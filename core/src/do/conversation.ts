import { DurableObject } from "cloudflare:workers";

import { runTurn, type HistoryTurn } from "../pipeline/turn";

import { sharedChainCache } from "./chaincache";

import type { Env } from "../env";
import type { StreamEvent, TurnRequest } from "../types";

/**
 * One conversation: runs each turn to completion even if the
 * client disconnects, keeps the hot history (redacted user text + verified
 * answers only), the founder queue items it logged, and the verified answers
 * the voice endpoint may read aloud. Supabase (the system of record) is not
 * wired yet; see docs/RUNBOOK.md.
 */

interface StoredMessage {
  id: string;
  text: string;
  at: number;
}

const HISTORY_KEY = "history";
const MAX_TURNS = 20;

export class ConversationDO extends DurableObject<Env> {
  private running = false;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/turn") && request.method === "POST") return this.turn(request);
    if (url.pathname.endsWith("/message")) return this.message(url.searchParams.get("m") ?? "");
    return new Response("not found", { status: 404 });
  }

  /** A verified answer by id (the voice endpoint reads only these). */
  private async message(id: string): Promise<Response> {
    const stored = await this.ctx.storage.get<StoredMessage>(`msg:${id}`);
    return stored ? Response.json(stored) : new Response("not found", { status: 404 });
  }

  private async turn(request: Request): Promise<Response> {
    if (this.running) return Response.json({ error: "turn_running" }, { status: 409 });
    const body = (await request.json()) as TurnRequest & {
      conversation_id: string;
      eval?: boolean;
    };
    this.running = true;

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let open = true;
    const send = (event: StreamEvent | { type: "keepalive" }) => {
      if (!open) return;
      writer
        .write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        .catch(() => (open = false));
    };
    const keepalive = setInterval(() => send({ type: "keepalive" }), 15000);

    const work = (async () => {
      const history = (await this.ctx.storage.get<HistoryTurn[]>(HISTORY_KEY)) ?? [];
      send({
        type: "turn.start",
        turn_id: body.client_msg_id,
        conversation_id: body.conversation_id,
        disclosure_ids: history.length ? [] : ["disclosure.ai.v1"],
      });
      try {
        const outcome = await runTurn(body, {
          env: this.env,
          cache: sharedChainCache(this.env),
          history,
          recentUserTexts: history.slice(-3).map((turn) => turn.user),
          conversationId: body.conversation_id,
          evalMode: body.eval === true,
          emit: send,
          queue: async (topic, reason) => {
            await this.ctx.storage.put(`queue:${Date.now()}`, {
              topic,
              reason,
              at: new Date().toISOString(),
            });
          },
        });
        // Only the redacted user text and the verified answer are ever stored.
        if (outcome.mode !== "safety_alert") {
          history.push({
            user: outcome.storedUserText,
            assistant: outcome.text,
            mode: outcome.mode,
          });
          await this.ctx.storage.put(HISTORY_KEY, history.slice(-MAX_TURNS));
        }
        await this.ctx.storage.put(`msg:${outcome.messageId}`, {
          id: outcome.messageId,
          text: outcome.text,
          at: Date.now(),
        } satisfies StoredMessage);
        console.log(
          JSON.stringify({
            evt: "gaia.turn",
            mode: outcome.mode,
            verifier: outcome.verifier,
            receipts: outcome.receipts.length,
            violations: outcome.violations.map((v) => `${v.severity}:${v.check}`),
            timings: outcome.timings,
          }),
        );
      } catch (error) {
        console.error("gaia.turn.error", error instanceof Error ? error.message : error);
        send({ type: "error", code: "turn_failed", retryable: true });
      } finally {
        clearInterval(keepalive);
        this.running = false;
        open = false;
        writer.close().catch(() => {});
      }
    })();
    this.ctx.waitUntil(work);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }
}

/** Per-IP turn budget: a sliding hour window and a burst limit. */
export class LimiterDO extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    const now = Date.now();
    const hits = ((await this.ctx.storage.get<number[]>("hits")) ?? []).filter(
      (t) => now - t < 3600_000,
    );
    const lastMinute = hits.filter((t) => now - t < 60_000).length;
    const perHour = Number(this.env.LIMIT_PER_HOUR) || 60;
    const perMinute = Number(this.env.LIMIT_PER_MINUTE) || 8;
    if (hits.length >= perHour || lastMinute >= perMinute)
      return Response.json({ ok: false }, { status: 429 });
    hits.push(now);
    await this.ctx.storage.put("hits", hits);
    return Response.json({ ok: true });
  }
}
