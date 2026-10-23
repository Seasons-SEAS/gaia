import { sharedChainCache } from "./do/chaincache";
import { corsHeaders, json, originAllowed, TurnBody, UUID, VoiceBody, withCors } from "./http";
import { edgeVoiceStore, speakCached } from "./voice/elevenlabs";

import type { Env } from "./env";

export { ChainCacheDO } from "./do/chaincache";
export { ConversationDO, LimiterDO } from "./do/conversation";

/**
 * GAIA Core edge: origin check, per-IP budget,
 * request validation, then the conversation's Durable Object runs the turn.
 */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST" },
      });
    if (!url.pathname.startsWith("/api/gaia/v2/")) return json({ error: "not_found" }, 404);
    if (!originAllowed(request, env)) return json({ error: "origin" }, 403);
    const path = url.pathname.slice("/api/gaia/v2/".length);

    if (path === "config" && request.method === "GET") {
      // Touching the shared chain cache starts its warmer, so the first answers find the round ready.
      await sharedChainCache(env)
        .get("warm")
        .catch(() => null);
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
      const ip =
        request.headers.get("CF-Connecting-IP") ??
        request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
        "local";
      const limit = await env.LIMITER.get(env.LIMITER.idFromName(ip)).fetch("https://limiter/hit");
      if (limit.status === 429) return json({ error: "rate_limited", retryable: true }, 429, cors);
      const parsed = TurnBody.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return json({ error: "bad_request" }, 400, cors);
      const conversationId = parsed.data.conversation_id ?? crypto.randomUUID();
      const evalMode =
        Boolean(env.EVAL_TOKEN) && request.headers.get("X-Gaia-Eval") === env.EVAL_TOKEN;
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(conversationId));
      const response = await stub.fetch("https://conversation/turn", {
        method: "POST",
        body: JSON.stringify({ ...parsed.data, conversation_id: conversationId, eval: evalMode }),
      });
      return new Response(response.body, {
        status: response.status,
        headers: withCors(response.headers, cors),
      });
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
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(conversationId));
      const stored = await stub.fetch(`https://conversation/message?m=${messageId}`);
      if (!stored.ok) return json({ error: "not_found" }, 404, cors);
      const { text } = (await stored.json()) as { text: string };
      const voice = await speakCached(text, env.ELEVENLABS_API_KEY, edgeVoiceStore(), (p) => ctx.waitUntil(p));
      return new Response(voice.body, {
        status: voice.status,
        headers: withCors(voice.headers, cors),
      });
    }

    return json({ error: "not_found" }, 404, cors);
  },
} satisfies ExportedHandler<Env>;
