import { DurableObject } from "cloudflare:workers";

import { getDistributionReceipts, getTokenTrustFacts } from "../chain";

import type { Env } from "../env";
import type { Cache } from "../types";

/**
 * One chain cache shared by every conversation, with a warmer. A cold read of
 * the latest payout round takes ~110 s on public RPC (getTransaction is
 * throttled), far too slow for a live answer, so an alarm re-reads the round
 * and the mint every 20 minutes and turns only ever hit the cache.
 */

const WARM_EVERY_MS = 20 * 60 * 1000;

export class ChainCacheDO extends DurableObject<Env> {
  private local: Cache = {
    get: async (key) => {
      const hit = await this.ctx.storage.get<{ value: string; until: number }>(key);
      return hit && hit.until > Date.now() ? hit.value : null;
    },
    put: async (key, value, ttlSeconds) => {
      await this.ctx.storage.put(key, { value, until: Date.now() + ttlSeconds * 1000 });
    },
  };

  async fetch(request: Request): Promise<Response> {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 1000);
    const { op, key, value, ttl } = (await request.json()) as {
      op: "get" | "put";
      key: string;
      value?: string;
      ttl?: number;
    };
    if (op === "get") return Response.json({ value: await this.local.get(key) });
    await this.local.put(key, value ?? "", ttl ?? 60);
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    const cfg = {
      rpcUrl: this.env.SOLANA_RPC_URL,
      cache: this.local,
      gentle: this.env.SOLANA_RPC_GENTLE === "1" ? true : undefined,
    };
    try {
      await getTokenTrustFacts(cfg);
      await getDistributionReceipts(cfg, { rounds: 3, budgetMs: 150_000 });
    } catch (error) {
      console.error("gaia.chaincache.warm", error instanceof Error ? error.message : error);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + WARM_EVERY_MS);
    }
  }
}

/** The shared cache as seen from a conversation. */
export function sharedChainCache(env: Env): Cache {
  const stub = env.CHAIN_CACHE.get(env.CHAIN_CACHE.idFromName("chain"));
  const call = (body: unknown) =>
    stub.fetch("https://chain-cache/", { method: "POST", body: JSON.stringify(body) });
  return {
    get: async (key) =>
      ((await (await call({ op: "get", key })).json()) as { value: string | null }).value,
    put: async (key, value, ttlSeconds) => {
      await call({ op: "put", key, value, ttl: ttlSeconds });
    },
  };
}
