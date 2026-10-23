import Anthropic from "@anthropic-ai/sdk";

import { brainCostUsd, think, type Usage } from "../brain/loop";
import { systemPrompt, turnMessage } from "../brain/prompt";
import { numbersFrom, runTool, TOOL_LABELS, type ToolContext } from "../brain/tools";
import { almanacDigest, bridges, canonVersion, hardAnswers, registry } from "../canon";
import { screenInput } from "../guards";
import { jevPreflight } from "../judge/jev";
import { postCheck } from "../judge/post";
import { fallbackLabels, preflight } from "../judge/preflight";
import { verifyDraft, verifySuggestion } from "../verify";

import { almanacReceipts, almanacUsed, relevantAlmanac } from "./almanac";
import { ANSWER_TTL_SECONDS, answerKey, mayCache, type CachedAnswer } from "./answer-cache";
import { founderGateViolations } from "./founder-gates";
import { route } from "./router";
import {
  degradedTemplate,
  isSmallTurnText,
  pinnedTemplate,
  quickSmallTalk,
  secretTemplate,
  smallTurnKind,
  smallTurnTemplate,
  topicFollowup,
} from "./templates";

import type { Env } from "../env";
import type { Cache, GaiaShape, Mode, Receipt, StreamEvent, TurnRequest, Violation } from "../types";

export interface HistoryTurn {
  user: string;
  assistant: string;
  /** The mode that answered it; a follow-up inherits it. */
  mode?: Mode;
}

export interface TurnDeps {
  env: Env;
  cache?: Cache;
  history: HistoryTurn[];
  /** Recent user texts, for split-seed detection. */
  recentUserTexts: string[];
  conversationId: string;
  emit: (event: StreamEvent) => void;
  queue: (topic: string, reason: string) => Promise<void>;
  lastBridgeForm?: string;
  /** Eval request: run the Jev shadow and emit a debug event. */
  evalMode?: boolean;
}

export interface TurnOutcome {
  messageId: string;
  text: string;
  followup: string | null;
  shape: GaiaShape | null;
  mode: Mode;
  verifier: "pass" | "repaired" | "template";
  receipts: Receipt[];
  violations: Violation[];
  /** The redacted user text that may be stored. */
  storedUserText: string;
  timings: Record<string, number>;
}

let cachedPrompt: { key: string; text: string } | null = null;

/** Byte-stable per deploy: rebuilt only when the canon or canary changes. */
function promptFor(env: Env): string {
  const key = `${canonVersion}:${env.GAIA_CANARY ?? ""}`;
  if (cachedPrompt?.key !== key)
    cachedPrompt = {
      key,
      text: systemPrompt({ almanac: almanacDigest(), bridges, canary: env.GAIA_CANARY }),
    };
  return cachedPrompt.text;
}

export async function runTurn(req: TurnRequest, deps: TurnDeps): Promise<TurnOutcome> {
  const { env, emit } = deps;
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (label: string) => (timings[label] = Date.now() - t0);
  const messageId = crypto.randomUUID();
  const layer = req.context.layer ?? (req.context.surface === "gaia_stage" ? "spoken" : "full");

  // L0 guards: nothing downstream ever sees an unredacted secret.
  const guard = screenInput(req.text, { recentUserTexts: deps.recentUserTexts, hardAnswers });
  // The languages GAIA answers in (GAIA_LANGUAGES); anything else gets the first one.
  const langs = (env.GAIA_LANGUAGES ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const speak = (lang: string) => (!langs.length || langs.includes(lang) ? lang : langs[0]);
  const early = speak(guard.lang);
  emit({ type: "state", semantic: "thinking" });

  const finish = (
    outcome: Omit<TurnOutcome, "messageId" | "storedUserText" | "timings">,
  ): TurnOutcome => {
    emit({ type: "text.commit", text: outcome.text, layer, message_id: messageId });
    if (outcome.shape) emit({ type: "shape", shape: outcome.shape });
    if (outcome.followup) emit({ type: "followup", text: outcome.followup });
    const kinds = new Set(outcome.receipts.map((r) => r.kind));
    emit({
      type: "turn.end",
      turn_id: messageId,
      message_id: messageId,
      verifier: outcome.verifier,
      provenance:
        outcome.verifier === "template" && !kinds.size
          ? "unverified"
          : kinds.has("chain") || kinds.has("api")
            ? "chain"
            : outcome.receipts.some((r) => r.kind === "almanac" || r.kind === "team_statement")
              ? "approved"
              : kinds.has("docs")
                ? "docs"
                : "general",
      receipts_count: outcome.receipts.length,
    });
    mark("total");
    return { ...outcome, messageId, storedUserText: guard.text, timings };
  };

  // A hard secret never reaches a model: authored template, nothing stored.
  if (guard.secret === "hard") {
    emit({ type: "state", semantic: "guard" });
    emit({ type: "policy", mode: "safety_alert", delivery: "ordered", pinned: null });
    const template = secretTemplate(early);
    return finish({
      text: template.text,
      followup: template.followup,
      shape: "shield",
      mode: "safety_alert",
      verifier: "template",
      receipts: [],
      violations: [],
    });
  }

  // Greetings and thanks need no model at all: instant, free, and they work in an outage.
  const quick = quickSmallTalk(guard.text);
  if (quick) {
    emit({ type: "policy", mode: "off_topic", delivery: "ordered", pinned: null });
    const small = smallTurnTemplate(quick, early, deps.history.at(-1)?.assistant);
    return finish({
      text: small.text,
      followup: small.followup,
      shape: small.shape,
      mode: "off_topic",
      verifier: "template",
      receipts: [],
      violations: [],
    });
  }

  if (!env.ANTHROPIC_API_KEY) {
    emit({ type: "state", semantic: "degraded", label: "Core has no model key" });
    return finish({
      text: degradedTemplate(early),
      followup: topicFollowup(early),
      shape: null,
      mode: "normal",
      verifier: "template",
      receipts: [],
      violations: [],
    });
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const receipts: Receipt[] = [];
  const signals: string[] = [];
  const toolsUsed = new Set<string>();
  const toolCtx: ToolContext = {
    chain: {
      rpcUrl: env.SOLANA_RPC_URL,
      cache: deps.cache,
      gentle: env.SOLANA_RPC_GENTLE === "1" ? true : undefined,
    },
    // Accepted suggestions and chips are not the user's own words.
    userNumbers: req.origin === "typed" || req.origin === "paste" ? numbersFrom(guard.text) : [],
    userAddresses: req.origin === "typed" || req.origin === "paste" ? guard.addresses : [],
    userLinks: guard.links,
    receipts,
    allowed: new Set<string>(),
    queue: deps.queue,
  };

  const callTool = async (
    name: string,
    input: Record<string, unknown>,
    id: string,
    initiator: "router" | "model",
  ) => {
    toolsUsed.add(name);
    emit({ type: "state", semantic: "tool", label: TOOL_LABELS[name] });
    emit({
      type: "tool.call",
      call_id: id,
      tool: name,
      label: TOOL_LABELS[name] ?? name,
      initiator,
    });
    const outcome = await runTool(name, input, toolCtx);
    for (const receipt of outcome.receipts) {
      if (receipts.some((r) => r.id === receipt.id)) continue;
      receipts.push(receipt);
      emit({ type: "receipt", receipt });
    }
    if (outcome.signal) signals.push(outcome.signal);
    emit({
      type: "tool.result",
      call_id: id,
      receipt_ids: outcome.receipts.map((r) => r.id),
      degraded: outcome.degraded,
      unavailable: outcome.unavailable,
    });
    return outcome;
  };

  // Pre-flight judgment runs in parallel with the proof-first prefetch.
  const previous = deps.history.at(-1)?.assistant;
  const fallback = fallbackLabels(guard.lang, guard.floors.seasonsMoney);
  // Does this message continue GAIA's last real answer? A number, a short reply,
  // or any answer to a question she just asked. Templates (jokes, greetings) don't count.
  const last = deps.history.at(-1);
  const words = guard.text.split(/\s+/).filter(Boolean).length;
  const context = {
    continues: Boolean(
      last &&
      !isSmallTurnText(last.assistant) &&
      (/\d/.test(guard.text) || words <= 2 || /\?\s*$/.test(last.assistant)),
    ),
    previousMode: last?.mode,
  };
  // The same fresh question answered a few minutes ago (typically a tapped
  // suggestion): serve that verified answer again, with no model call at all.
  // Never for evals, which must exercise the whole pipeline.
  const cacheKey =
    deps.cache && !deps.evalMode
      ? answerKey(guard, { ...context, lang: early, layer, model: env.GAIA_MODEL, canon: canonVersion })
      : null;
  if (cacheKey) {
    const hit = await deps.cache!.get(cacheKey).catch(() => null);
    if (hit) {
      const answer = JSON.parse(hit) as CachedAnswer;
      emit({ type: "policy", mode: answer.mode, delivery: "ordered", pinned: null });
      for (const receipt of answer.receipts) emit({ type: "receipt", receipt });
      timings.answer_cache = 1;
      timings.cost_millicents = 0;
      return finish({
        text: answer.text,
        followup: answer.followup,
        shape: answer.shape,
        mode: answer.mode,
        verifier: answer.verifier,
        receipts: answer.receipts,
        violations: [],
      });
    }
  }

  const earlyRoute = guard.floors.pin ? route(guard, fallback, context) : null;
  const prefetch = earlyRoute?.prefetch.length
    ? (() => {
        toolCtx.allowed = earlyRoute.allowedTools;
        return Promise.all(
          earlyRoute.prefetch.map((name, i) => callTool(name, {}, `router-${i}`, "router")),
        ).then((r) => {
          mark("prefetch");
          return r;
        });
      })()
    : Promise.resolve([]);
  // Jev runs in shadow on eval requests only, never on live user text.
  const jev =
    deps.evalMode && env.AI_GATEWAY_API_KEY
      ? jevPreflight(env.AI_GATEWAY_API_KEY, guard.text)
      : Promise.resolve(null);
  const haiku = { calls: 0, input: 0, output: 0 };
  const [{ labels, degraded: judgeDegraded, usage: judgeUsage }, , jevResult] = await Promise.all([
    preflight(client, env.JUDGE_MODEL, guard.text, previous, fallback).then((r) => {
      mark("judge");
      return r;
    }),
    prefetch,
    jev,
  ]);
  mark("preflight");
  haiku.calls++;
  haiku.input += judgeUsage.input;
  haiku.output += judgeUsage.output;
  if (judgeDegraded) timings.judge_degraded = 1;

  const plan = route(guard, labels, context);
  toolCtx.allowed = plan.allowedTools;
  emit({
    type: "policy",
    mode: plan.mode,
    delivery: plan.delivery,
    pinned: plan.pinned?.id ?? null,
  });
  if (plan.mode === "guarded") emit({ type: "state", semantic: "guard" });
  else emit({ type: "state", semantic: "thinking" });

  // Off-topic, greetings and thanks: a light authored line, no brain, only the judge's cost.
  if (plan.mode === "off_topic") {
    const small = smallTurnTemplate(
      smallTurnKind(guard.text, labels.gratitude),
      speak(labels.language || guard.lang),
      previous,
    );
    timings.haiku_calls = haiku.calls;
    timings.cost_millicents = Math.round(
      ((haiku.input * 1 + haiku.output * 5) / 1_000_000) * 100_000,
    );
    if (deps.evalMode)
      emit({
        type: "debug",
        cost_usd: timings.cost_millicents / 100_000,
        mode: plan.mode,
        haiku: labels,
        jev: jevResult,
        violations: [],
      });
    return finish({
      text: small.text,
      followup: small.followup,
      shape: small.shape,
      mode: "off_topic",
      verifier: "template",
      receipts: [],
      violations: [],
    });
  }

  const system = promptFor(env);
  const recent = deps.history.slice(-8);
  // A cache read point on the previous verified answer: a follow-up reads the
  // older history from cache and writes only the newest pair.
  const history: Anthropic.MessageParam[] = recent.flatMap((turn, i) => [
    { role: "user" as const, content: turn.user },
    {
      role: "assistant" as const,
      content:
        i === recent.length - 1
          ? [
              {
                type: "text" as const,
                text: turn.assistant,
                cache_control: { type: "ephemeral" as const },
              },
            ]
          : turn.assistant,
    },
  ]);
  const brief = (extra?: string) =>
    turnMessage({
      mode: plan.mode,
      layer,
      labels: { ...labels, language: speak(labels.language || guard.lang) },
      userLanguage: labels.language || guard.lang,
      pinned: plan.pinned,
      receipts,
      bridges: plan.bridges,
      lastBridgeForm: deps.lastBridgeForm,
      nowIso: new Date().toISOString(),
    }) + (extra ? `\n\n${extra}` : "");

  const almanac = almanacReceipts();
  const pinnedFacts = (plan.pinned?.required_fact_keys ?? []).flatMap((key) =>
    almanac.filter((r) => r.id.endsWith(key)),
  );
  // The pinned brief's dated figures (e.g. the latest reported rate) may feed the calculator.
  toolCtx.vouched = pinnedFacts.flatMap((r) => r.numbers);
  const ctx = {
    mode: plan.mode,
    lang: speak(labels.language || guard.lang),
    receipts,
    userText: guard.text,
    pinned: plan.pinned,
    registry,
    canary: env.GAIA_CANARY,
  };

  const spend: Usage = {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite1h: 0,
    cacheWrite5m: 0,
  };
  const attempt = async (
    extra?: string,
    toolChoice: "auto" | "none" = plan.allowedTools.size ? "auto" : "none",
  ) => {
    const result = await think({
      client,
      model: env.GAIA_MODEL,
      system,
      history,
      userText: guard.text,
      turnMessage: brief(extra),
      effort: plan.effort,
      toolChoice,
      runTool: (name, input, id) => callTool(name, input, id, "model"),
    });
    for (const key of Object.keys(spend) as (keyof Usage)[]) spend[key] += result.usage[key];
    if (result.refusal) return { result, checked: null };
    emit({ type: "state", semantic: "verifying" });
    // Numbers are vouched for by live receipts and the Almanac facts on the draft's own topics.
    // The pinned brief's facts vouch in every language, whatever words the draft uses.
    const checked = verifyDraft(result.text, {
      ...ctx,
      receipts: [...receipts, ...pinnedFacts, ...relevantAlmanac(result.text, almanac)],
    });
    const post = await postCheck(client, env.JUDGE_MODEL, {
      userText: guard.text,
      draft: checked.text,
      // The judge sees what was read live, the pinned brief's facts and the Almanac facts the draft uses.
      receipts: [...receipts, ...pinnedFacts, ...almanacUsed(checked.text, almanac, 8)].filter(
        (r, i, all) => all.findIndex((x) => x.id === r.id) === i,
      ),
      mode: plan.mode,
      implicatures: plan.pinned?.verifier.forbidden_implicatures,
    });
    haiku.calls += post.usage.calls;
    haiku.input += post.usage.input;
    haiku.output += post.usage.output;
    return {
      result,
      checked: {
        text: checked.text,
        violations: [
          ...checked.violations,
          ...founderGateViolations(checked.text),
          ...post.violations,
        ],
      },
    };
  };

  let verifier: TurnOutcome["verifier"] = "pass";
  let first;
  try {
    first = await attempt();
  } catch {
    emit({ type: "state", semantic: "degraded" });
    return finish({
      text: pinnedTemplate(plan.pinned, ctx.lang),
      followup: plan.pinned ? null : topicFollowup(ctx.lang),
      shape: null,
      mode: plan.mode,
      verifier: "template",
      receipts,
      violations: [],
    });
  }
  mark("draft");

  const firstViolations = (first.checked?.violations ?? []).map((v) => `${v.severity}:${v.check}`);
  timings.first_blocks = firstViolations.filter((v) => v.startsWith("block")).length;
  let text = first.checked?.text ?? "";
  let followup = first.result.followup;
  let violations = first.checked?.violations ?? [];
  const blocking = (list: Violation[]) => list.filter((v) => v.severity === "block");

  if (first.result.refusal || !text) {
    verifier = "template";
    text = pinnedTemplate(plan.pinned, ctx.lang);
    followup = plan.pinned ? null : topicFollowup(ctx.lang);
  } else if (blocking(violations).length) {
    // One repair, naming the violations; tools already ran, so it's a fast round.
    const problems = blocking(violations)
      .map(
        (v) =>
          `- ${v.check}: ${v.detail}${v.sentence ? ` (in: "${v.sentence.slice(0, 160)}")` : ""}`,
      )
      .join("\n");
    try {
      const second = await attempt(
        `A previous draft of this answer was rejected by the checks:\n${problems}\nWrite a new answer that fixes these problems. Use only the receipts listed above.`,
        "none",
      );
      mark("repair");
      if (
        second.checked &&
        !second.result.refusal &&
        !blocking(second.checked.violations).length &&
        second.checked.text
      ) {
        verifier = "repaired";
        text = second.checked.text;
        followup = second.result.followup;
        violations = second.checked.violations;
      } else {
        verifier = "template";
        text = pinnedTemplate(plan.pinned, ctx.lang);
        followup = plan.pinned ? null : topicFollowup(ctx.lang);
        violations = second.checked?.violations ?? violations;
      }
    } catch {
      verifier = "template";
      text = pinnedTemplate(plan.pinned, ctx.lang);
      followup = plan.pinned ? null : topicFollowup(ctx.lang);
    }
  }

  const cleanFollowup = followup ? verifySuggestion(followup, ctx) : null;
  // Live reads: the chain itself, or pool prices read from the market APIs.
  const chainChecked = receipts.some((r) => r.kind === "chain" || r.kind === "api");
  const shape = answerShape({
    mode: plan.mode,
    grateful: labels.gratitude === "clear",
    template: verifier === "template",
    chainChecked,
    receipts,
  });

  // Almanac facts the final answer relies on are shown as receipts too.
  if (verifier !== "template")
    for (const receipt of almanacUsed(text, almanac))
      if (!receipts.some((r) => r.id === receipt.id)) {
        receipts.push(receipt);
        emit({ type: "receipt", receipt });
      }
  timings.opus_calls = spend.calls;
  timings.opus_in = spend.input + spend.cacheRead + spend.cacheWrite1h + spend.cacheWrite5m;
  timings.opus_out = spend.output;
  timings.haiku_calls = haiku.calls;
  // Opus plus Haiku 4.5 at $1 / $5 per million tokens.
  timings.cost_millicents = Math.round(
    (brainCostUsd(env.GAIA_MODEL, spend) + (haiku.input * 1 + haiku.output * 5) / 1_000_000) * 100_000,
  );
  timings.words = text.split(/\s+/).filter(Boolean).length;
  if (deps.evalMode)
    emit({
      type: "debug",
      cost_usd: timings.cost_millicents / 100_000,
      mode: plan.mode,
      haiku: labels,
      jev: jevResult,
      violations: [
        ...firstViolations.map((v) => `first:${v}`),
        ...violations.map((v) => `${v.severity}:${v.check}`),
      ],
    });
  if (signals.length)
    violations.push(
      ...signals.map((s) => ({ check: `dispatcher.${s}`, severity: "flag" as const, detail: s })),
    );
  if (cacheKey && mayCache({ mode: plan.mode, verifier }, toolsUsed)) {
    const answer: CachedAnswer = {
      text,
      followup: cleanFollowup,
      shape,
      mode: plan.mode,
      verifier: verifier as CachedAnswer["verifier"],
      receipts,
      at: Date.now(),
    };
    await deps.cache!.put(cacheKey, JSON.stringify(answer), ANSWER_TTL_SECONDS).catch(() => {});
  }
  return finish({
    text,
    followup: cleanFollowup,
    shape,
    mode: plan.mode,
    verifier,
    receipts,
    violations,
  });
}

/**
 * The symbol GAIA draws after an answer, kept to a few (owner, 2026-10-01):
 * guarded turns a shield, thanks a heart, an answer read from the chain a
 * check. The Seasons mark belongs to her entrance on the stage, not to answers.
 * (The stage also has sprout, clock, node and spark; unused for now.)
 */
export function answerShape(turn: {
  mode: string;
  grateful: boolean;
  template: boolean;
  chainChecked: boolean;
  receipts: Receipt[];
}): GaiaShape | null {
  if (turn.mode === "guarded" || turn.mode === "safety_alert") return "shield";
  if (turn.grateful && turn.mode === "brief_plus_bridge") return "heart";
  if (turn.template) return null;
  if (turn.chainChecked && ["trust_question", "sensitive_financial", "normal"].includes(turn.mode))
    return "check";
  return null;
}
