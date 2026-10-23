import { getDistributionReceipts, getTokenTrustFacts } from "../chain";
import { corsHeaders, json, originAllowed, TurnBody, UUID, VoiceBody, withCors } from "../http";
import { readMemory, signMemory, type MemoryTurn } from "../memory";
import { runTurn, type HistoryTurn } from "../pipeline/turn";
import { memoryVoiceStore, speakCached } from "../voice/elevenlabs";

// Voice takes for repeated answers, kept in this instance's memory.
const voiceStore = memoryVoiceStore();

import type { Env } from "../env";
import type { Cache, StreamEvent } from "../types";

/**
 * GAIA Core on Vercel (a free demo host). Same pipeline and
 * edge contract as the Cloudflare Worker; the Durable Objects are replaced by
 * in-memory stores that live as long as the function instance (Fluid compute
 * reuses it), which is enough for a demo but not a system of record.
 * Production stays on Cloudflare.
 */

const env = {
  ...process.env,
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? "",
  GAIA_MODEL: process.env.GAIA_MODEL ?? "claude-opus-5-5",
  JUDGE_MODEL: process.env.JUDGE_MODEL ?? "claude-haiku-4-5",
} as unknown as Env;

// --- in-memory stores -------------------------------------------------------------
interface Conversation {
  history: HistoryTurn[];
  /** Message id of each history turn's answer (parallel to history). */
  ids: string[];
  messages: Map<string, string>;
  running: boolean;
  at: number;
}
const conversations = new Map<string, Conversation>();
const MAX_CONVERSATIONS = 500;
const MAX_TURNS = 20;

function conversation(id: string): Conversation {
  let found = conversations.get(id);
  if (!found) {
    if (conversations.size >= MAX_CONVERSATIONS) {
      const oldest = [...conversations.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) conversations.delete(oldest[0]);
    }
    found = { history: [], ids: [], messages: new Map(), running: false, at: Date.now() };
    conversations.set(id, found);
  }
  found.at = Date.now();
  return found;
}

const memoryKey = () => env.GAIA_MEMORY_KEY ?? env.GAIA_CANARY ?? "";

/** A cold instance restores the thread from the browser's signed memory. */
function restore(convo: Conversation, turns: MemoryTurn[]) {
  convo.history = turns.map((t) => ({
    user: t.u,
    assistant: t.a,
    mode: t.mode as HistoryTurn["mode"],
  }));
  convo.ids = turns.map((t) => t.m ?? "");
  for (const t of turns) if (t.m) convo.messages.set(t.m, t.a);
}

const store = new Map<string, { value: string; until: number }>();
const cache: Cache = {
  get: async (key) => {
    const hit = store.get(key);
    return hit && hit.until > Date.now() ? hit.value : null;
  },
  put: async (key, value, ttlSeconds) => {
    store.set(key, { value, until: Date.now() + ttlSeconds * 1000 });
  },
};

/** Per-IP budget plus a global hourly ceiling, so a shared link can't run up the bill. */
const hits = new Map<string, number[]>();
function allow(ip: string): boolean {
  const now = Date.now();
  const recent = (key: string) => (hits.get(key) ?? []).filter((t) => now - t < 3600_000);
  const mine = recent(ip);
  const all = recent("*");
  const perHour = Number(env.LIMIT_PER_HOUR) || 60;
  const perMinute = Number(env.LIMIT_PER_MINUTE) || 8;
  const globalPerHour = Number(process.env.LIMIT_GLOBAL_PER_HOUR) || 300;
  if (
    mine.length >= perHour ||
    mine.filter((t) => now - t < 60_000).length >= perMinute ||
    all.length >= globalPerHour
  )
    return false;
  hits.set(ip, [...mine, now]);
  hits.set("*", [...all, now]);
  return true;
}

/** The chain warmer: the mint and the latest rounds, at most every 20 minutes per instance. */
let warmedAt = 0;
let warming: Promise<void> | null = null;
function warm(): Promise<void> | null {
  if (warming || Date.now() - warmedAt < 20 * 60_000) return null;
  const cfg = {
    rpcUrl: env.SOLANA_RPC_URL,
    cache,
    gentle: env.SOLANA_RPC_GENTLE === "1" ? true : undefined,
  };
  warming = (async () => {
    try {
      await getTokenTrustFacts(cfg);
      await getDistributionReceipts(cfg, { rounds: 3, budgetMs: 150_000 });
      warmedAt = Date.now();
    } catch (error) {
      console.error("gaia.warm", error instanceof Error ? error.message : error);
    } finally {
      warming = null;
    }
  })();
  return warming;
}

// --- routes -------------------------------------------------------------------------
async function turn(
  body: ReturnType<typeof TurnBody.parse>,
  evalMode: boolean,
  cors: Record<string, string>,
): Promise<Response> {
  const conversationId = body.conversation_id ?? crypto.randomUUID();
  const convo = conversation(conversationId);
  if (!convo.history.length && body.memory) {
    const turns = await readMemory(memoryKey(), conversationId, body.memory);
    if (turns) restore(convo, turns);
  }
  if (convo.running) return json({ error: "turn_running" }, 409, cors);
  convo.running = true;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let open = true;
  const send = (event: StreamEvent | { type: "keepalive" }) => {
    if (!open) return;
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => (open = false));
  };
  const keepalive = setInterval(() => send({ type: "keepalive" }), 15000);

  void (async () => {
    send({
      type: "turn.start",
      turn_id: body.client_msg_id,
      conversation_id: conversationId,
      disclosure_ids: convo.history.length ? [] : ["disclosure.ai.v1"],
    });
    try {
      const outcome = await runTurn(
        { ...body, conversation_id: conversationId },
        {
          env,
          cache,
          history: convo.history,
          recentUserTexts: convo.history.slice(-3).map((t) => t.user),
          conversationId,
          evalMode,
          emit: send,
          queue: async (topic, reason) =>
            console.log(JSON.stringify({ evt: "gaia.queue", topic, reason })),
        },
      );
      if (outcome.mode !== "safety_alert") {
        convo.history.push({
          user: outcome.storedUserText,
          assistant: outcome.text,
          mode: outcome.mode,
        });
        convo.ids.push(outcome.messageId);
        const extra = Math.max(0, convo.history.length - MAX_TURNS);
        convo.history.splice(0, extra);
        convo.ids.splice(0, extra);
      }
      convo.messages.set(outcome.messageId, outcome.text);
      if (memoryKey()) {
        const turns = convo.history.map((h, i) => ({
          u: h.user,
          a: h.assistant,
          m: convo.ids[i] || undefined,
          mode: h.mode,
        }));
        send({ type: "memory", token: await signMemory(memoryKey(), conversationId, turns) });
      }
      console.log(
        JSON.stringify({
          evt: "gaia.turn",
          mode: outcome.mode,
          verifier: outcome.verifier,
          timings: outcome.timings,
        }),
      );
    } catch (error) {
      console.error("gaia.turn.error", error instanceof Error ? error.message : error);
      send({ type: "error", code: "turn_failed", retryable: true });
    } finally {
      clearInterval(keepalive);
      convo.running = false;
      open = false;
      writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      ...cors,
    },
  });
}

export async function handle(
  request: Request,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<Response> {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST" },
    });
  // The rewrite passes the original sub-path as ?p=; direct calls use the path.
  const path = url.searchParams.get("p") ?? url.pathname.replace(/^\/api\/gaia\/v2\//, "");
  if (!originAllowed(request, env)) return json({ error: "origin" }, 403);

  if (path === "config" && request.method === "GET") {
    const warmer = warm();
    if (warmer && waitUntil) waitUntil(warmer);
    const langs = (env.GAIA_LANGUAGES ?? "")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    return json(
      {
        ok: true,
        ui: "v2",
        brain: Boolean(env.ANTHROPIC_API_KEY),
        voice: Boolean(env.ELEVENLABS_API_KEY),
        langs,
      },
      200,
      cors,
    );
  }

  if (path === "turn" && request.method === "POST") {
    const ip = request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "local";
    if (!allow(ip)) return json({ error: "rate_limited", retryable: true }, 429, cors);
    const parsed = TurnBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "bad_request" }, 400, cors);
    const evalMode =
      Boolean(env.EVAL_TOKEN) && request.headers.get("X-Gaia-Eval") === env.EVAL_TOKEN;
    return await turn(parsed.data, evalMode, cors);
  }

  if (path === "voice" && (request.method === "GET" || request.method === "POST")) {
    const posted =
      request.method === "POST"
        ? VoiceBody.safeParse(await request.json().catch(() => null))
        : null;
    const conversationId = posted?.success ? posted.data.c : (url.searchParams.get("c") ?? "");
    const messageId = posted?.success ? posted.data.m : (url.searchParams.get("m") ?? "");
    if (!UUID.test(conversationId) || !UUID.test(messageId))
      return json({ error: "bad_request" }, 400, cors);
    if (!env.ELEVENLABS_API_KEY) return json({ error: "voice_off" }, 503, cors);
    let text = conversations.get(conversationId)?.messages.get(messageId);
    if (!text && posted?.success)
      text = (await readMemory(memoryKey(), conversationId, posted.data.memory))?.find(
        (t) => t.m === messageId,
      )?.a;
    if (!text) return json({ error: "not_found" }, 404, cors);
    const voice = await speakCached(text, env.ELEVENLABS_API_KEY, voiceStore, waitUntil);
    return new Response(voice.body, {
      status: voice.status,
      headers: withCors(voice.headers, cors),
    });
  }

  return json({ error: "not_found" }, 404, cors);
}
