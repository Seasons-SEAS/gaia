import { TOOLS } from "../brain/tools";
import { bridgeInfo, bridges, getHardAnswer } from "../canon";

import type { BridgeEdge, GuardResult, HardAnswer, Mode, PreflightLabels } from "../types";

/**
 * The router: code, not a model. It starts from the
 * mode floor set by deterministic signals; the judges may raise the mode but
 * never lower it. It also picks the allowed tools, effort and bridges.
 */

const RANK: Record<Mode, number> = {
  off_topic: -1,
  brief_plus_bridge: 0,
  normal: 1,
  sensitive_financial: 2,
  trust_question: 3,
  handoff: 4,
  guarded: 5,
  safety_alert: 6,
};

const raise = (current: Mode, next: Mode) => (RANK[next] > RANK[current] ? next : current);

export interface Route {
  mode: Mode;
  delivery: "ordered" | "proof_first";
  pinned: HardAnswer | null;
  allowedTools: ReadonlySet<string>;
  effort: "low" | "medium";
  bridges: BridgeEdge[];
  /** Facts the router reads itself before the brain runs (proof first). */
  prefetch: string[];
}

const ALL_TOOLS = new Set(TOOLS.map((tool) => tool.name));
const MONEY_PINS = new Set(["HA-RETURNS", "HA-PAYBACK", "HA-PRICE"]);
const NO_TOOLS: ReadonlySet<string> = new Set();

/** Which live reads prove a pinned answer. */
const PREFETCH_FOR_FACT: Record<string, string> = {
  token: "get_token_trust_facts",
  fee: "get_token_trust_facts",
  fees: "get_token_trust_facts",
  authority: "get_token_trust_facts",
  distribution: "get_distribution_receipts",
  rounds: "get_distribution_receipts",
  price: "get_price",
  market: "get_price",
  supply: "get_supply",
  schedule: "get_payout_schedule",
};

function prefetchFor(pinned: HardAnswer | null): string[] {
  if (!pinned) return [];
  const tools = new Set<string>();
  for (const key of pinned.required_fact_keys) {
    const head = key.split(".")[0];
    const tool = PREFETCH_FOR_FACT[head];
    if (tool) tools.add(tool);
  }
  return [...tools];
}

/**
 * Words that tie a message to Seasons or to using it (wallets, Solana, the
 * DEXs): such a message is never off-topic, whatever the judge's scope says.
 */
const SEASONS_TERMS =
  /seasons|\$?seas\b|сизн|сизонс|(?<![а-яё])сиз(?![а-яё])|gaia|(?<![а-яё])га[ияеюй]й?(?![а-яё])|\bnodes?\b|(?<![а-яё])нод(?:а|ы|е|у|ой|ам|ами|ах)?(?![а-яё])|director|builder|директор|билдер|terminal|терминал|xaut|wbtc|jlusdc|inclusion set|payouts?|выплат|wallet|кошел|phantom|backpack|solflare|jupiter|raydium|meteora|solana|солан|seed|сид-?фраз|private key|приватн|airdrop|аирдроп|scam|скам|мошен|knoten|auszahl|\bnodos?\b|billetera|ノード|ウォレット|配当|\bap[yr]s?\b|who are you|what are you|кто ты|что ты такое|wer bist du|quién eres|あなたは誰/i;

/** Topics GAIA doesn't spend the brain on: answered with a light template instead. */
const OFF_TOPIC_SCOPES = new Set([
  "adjacent_finance",
  "adjacent_crypto",
  "general",
  "smalltalk",
  "personal_savings",
]);

export const mentionsSeasons = (text: string) => SEASONS_TERMS.test(text);

export interface RouteContext {
  /** The message continues GAIA's previous real answer (a reply to her question, a short follow-up). */
  continues?: boolean;
  /** The mode of that previous answer. */
  previousMode?: Mode;
}

const INHERITED: Mode[] = ["normal", "sensitive_financial", "trust_question"];

export function route(
  guard: GuardResult,
  labels: PreflightLabels,
  context: RouteContext = {},
): Route {
  // Deterministic floor.
  let mode: Mode = "normal";
  if (
    ["adjacent_finance", "adjacent_crypto", "general", "smalltalk", "personal_savings"].includes(
      labels.scope,
    )
  )
    mode = "brief_plus_bridge";
  if (guard.floors.seasonsMoney) mode = raise(mode, "sensitive_financial");
  const pinned = guard.floors.pin ? (getHardAnswer(guard.floors.pin) ?? null) : null;
  // Money answers (returns, payback, price) are financial; the rest are trust questions.
  if (pinned)
    mode = raise(mode, MONEY_PINS.has(pinned.id) ? "sensitive_financial" : "trust_question");
  if (guard.injectionSignals.length) mode = raise(mode, "guarded");
  if (guard.secret === "hard") mode = "safety_alert";

  // Judges only raise.
  if (labels.scope === "seasons_money") mode = raise(mode, "sensitive_financial");
  if (labels.asks_about_returns === "clear" || labels.asks_personal_financial_advice === "clear")
    mode = raise(mode, "sensitive_financial");
  if (labels.challenges_legitimacy === "clear") mode = raise(mode, "trust_question");
  else if (labels.challenges_legitimacy === "possible") mode = raise(mode, "sensitive_financial");
  if (labels.distress === "clear" || labels.wants_human === "clear") mode = raise(mode, "handoff");
  if (labels.injection !== "none") mode = raise(mode, "guarded");
  // A reply inside a conversation keeps the thread: "7%" after "What does your bank
  // pay?" is still the money question, answered under the same rules.
  const followsUp = context.continues || labels.follows_up !== "none";
  if (followsUp && context.previousMode && INHERITED.includes(context.previousMode))
    mode = raise(mode, context.previousMode);
  // Not about Seasons and nothing ties it to Seasons: a template, no brain. A judge's
  // money labels on someone else's asset ("should I keep savings in stablecoins?")
  // don't make it a Seasons question; trust, handoff, guarded and safety still win.
  if (
    RANK[mode] <= RANK.sensitive_financial &&
    !followsUp &&
    OFF_TOPIC_SCOPES.has(labels.scope) &&
    !pinned &&
    !guard.floors.seasonsMoney &&
    labels.reports_possible_scam === "none" &&
    !mentionsSeasons(guard.text)
  )
    mode = "off_topic";

  const allowedTools =
    mode === "guarded" || mode === "safety_alert" || mode === "off_topic" ? NO_TOOLS : ALL_TOOLS;

  // A personal-savings question never bridges to Seasons yield.
  const edges = bridges.filter((edge) =>
    labels.scope === "personal_savings"
      ? bridgeInfo(edge.cluster)?.personal_savings_ok === true
      : true,
  );

  return {
    mode,
    delivery: pinned ? "proof_first" : "ordered",
    pinned,
    allowedTools,
    effort: labels.complexity >= 2 || (mode === "trust_question" && !pinned) ? "medium" : "low",
    bridges: mode === "brief_plus_bridge" ? edges.slice(0, 15) : [],
    prefetch:
      mode === "guarded" || mode === "safety_alert" || mode === "off_topic"
        ? []
        : prefetchFor(pinned),
  };
}
