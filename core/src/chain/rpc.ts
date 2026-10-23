/**
 * Read-only Solana JSON-RPC client. Read-only by construction: only the
 * allowlisted methods can be sent (no send/simulate, no getProgramAccounts).
 * Errors never include the endpoint, whose URL may carry a paid API key.
 */
import { stableJson } from "../kernel/numbers";

import {
  cacheGet,
  cachePut,
  ChainError,
  DEFAULT_TIMEOUT_MS,
  fetchImpl,
  fetchWithRetry,
  sanitize,
  secretsOf,
  sleep,
} from "./http";

import type { ChainConfig } from "../types";

export const RPC_METHOD_ALLOWLIST = [
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenSupply",
  "getEpochInfo",
  "getSlot",
  "getSignaturesForAddress",
  "getTransaction",
  "getTokenAccountsByOwner",
  "getTokenAccountBalance",
  "getBalance",
] as const;

export type RpcMethod = (typeof RPC_METHOD_ALLOWLIST)[number];

const ALLOWED = new Set<string>(RPC_METHOD_ALLOWLIST);

export function isAllowedMethod(method: string): method is RpcMethod {
  return ALLOWED.has(method);
}

function assertAllowed(method: string): asserts method is RpcMethod {
  if (!isAllowedMethod(method))
    throw new ChainError(
      "method_not_allowed",
      `RPC method "${String(method).slice(0, 40)}" is not allowed`,
    );
}

export interface RpcCall {
  method: RpcMethod;
  params: unknown[];
}

export interface RpcOk<T> {
  ok: true;
  result: T;
  /** ISO time of the actual read (earlier than now when served from cache). */
  at: string;
  cached: boolean;
}

export interface RpcFail {
  ok: false;
  error: ChainError;
}

export interface RpcClientOptions {
  timeoutMs?: number;
  /** Wait before retrying a rate-limited item; default 800 ms. */
  retryWaitMs?: number;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const isRateLimitCode = (code: unknown) => code === 429 || code === -32429 || code === -32005;

async function cacheKeyFor(method: string, params: unknown[]): Promise<string> {
  // SHA-256, not a short hash: a collision would silently serve another account's data.
  const bytes = new TextEncoder().encode(`${method}:${stableJson(params)}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest.slice(0, 20)) hex += b.toString(16).padStart(2, "0");
  return `rpc:${method}:${hex}`;
}

export class RpcClient {
  private nextId = 1;
  private readonly secrets: string[];
  private readonly f: typeof fetch;

  constructor(
    private readonly cfg: ChainConfig,
    private readonly opts: RpcClientOptions = {},
  ) {
    if (!cfg || typeof cfg.rpcUrl !== "string" || !/^https?:\/\//i.test(cfg.rpcUrl)) {
      throw new ChainError("http_error", "RPC endpoint is not configured");
    }
    this.secrets = secretsOf(cfg.rpcUrl);
    this.f = fetchImpl(cfg);
  }

  private fail(
    code: ConstructorParameters<typeof ChainError>[0],
    message: string,
    status?: number,
  ): ChainError {
    return new ChainError(code, sanitize(message, this.secrets), status);
  }

  private async post(body: unknown): Promise<unknown> {
    const res = await fetchWithRetry(
      this.f,
      this.cfg.rpcUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      },
      { timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, retryWaitMs: this.opts.retryWaitMs },
    );
    if (res.status === 429) throw this.fail("rate_limited", "RPC rate limited (HTTP 429)", 429);
    if (!res.ok) throw this.fail("http_error", `RPC returned HTTP ${res.status}`, res.status);
    try {
      return await res.json();
    } catch {
      throw this.fail("invalid_response", "RPC returned invalid JSON");
    }
  }

  private toResult<T>(
    r: JsonRpcResponse | undefined,
  ): { ok: true; result: T } | { ok: false; error: ChainError; rateLimited: boolean } {
    if (!r || typeof r !== "object")
      return {
        ok: false,
        error: this.fail("invalid_response", "RPC response missing"),
        rateLimited: false,
      };
    if (r.error) {
      const rateLimited = isRateLimitCode(r.error.code);
      return {
        ok: false,
        rateLimited,
        error: this.fail(
          rateLimited ? "rate_limited" : "rpc_error",
          `RPC error ${r.error.code ?? ""}: ${r.error.message ?? "unknown"}`,
        ),
      };
    }
    if (!("result" in r))
      return {
        ok: false,
        error: this.fail("invalid_response", "RPC response has no result"),
        rateLimited: false,
      };
    return { ok: true, result: r.result as T };
  }

  /** One allowlisted call. `ttlSeconds` > 0 caches the result (with its read time). */
  async call<T>(
    method: RpcMethod,
    params: unknown[],
    o: { ttlSeconds?: number } = {},
  ): Promise<RpcOk<T>> {
    assertAllowed(method);
    const ttl = o.ttlSeconds ?? 0;
    const key = ttl > 0 ? await cacheKeyFor(method, params) : "";
    if (ttl > 0) {
      const hit = await cacheGet<T>(this.cfg.cache, key);
      if (hit) return { ok: true, result: hit.v, at: hit.at, cached: true };
    }
    for (let attempt = 0; ; attempt++) {
      const body = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params });
      const r = this.toResult<T>(body as JsonRpcResponse);
      if (r.ok) {
        const at = new Date().toISOString();
        if (ttl > 0) await cachePut(this.cfg.cache, key, { at, v: r.result }, ttl);
        return { ok: true, result: r.result, at, cached: false };
      }
      // A JSON-level rate limit (HTTP 200) gets the same single retry as HTTP 429.
      if (r.rateLimited && attempt === 0) {
        await sleep(this.opts.retryWaitMs ?? 800);
        continue;
      }
      throw r.error;
    }
  }

  /**
   * Several allowlisted calls in one JSON-RPC batch (one subrequest). Items
   * fail individually; rate-limited items are retried once. Falls back to
   * sequential calls if the endpoint does not answer batches with an array.
   */
  async batch<T>(
    calls: RpcCall[],
    o: { ttlSeconds?: number } = {},
  ): Promise<Array<RpcOk<T> | RpcFail>> {
    for (const c of calls) assertAllowed(c.method);
    const ttl = o.ttlSeconds ?? 0;
    const out: Array<RpcOk<T> | RpcFail | undefined> = new Array(calls.length);
    const keys: string[] = [];
    if (ttl > 0) {
      for (let i = 0; i < calls.length; i++) {
        keys[i] = await cacheKeyFor(calls[i]!.method, calls[i]!.params);
        const hit = await cacheGet<T>(this.cfg.cache, keys[i]!);
        if (hit) out[i] = { ok: true, result: hit.v, at: hit.at, cached: true };
      }
    }
    let pending = calls.map((_, i) => i).filter((i) => !out[i]);
    for (let attempt = 0; pending.length > 0 && attempt < 2; attempt++) {
      if (attempt > 0) await sleep(this.opts.retryWaitMs ?? 800);
      const ids = new Map<number, number>();
      const body = pending.map((i) => {
        const id = this.nextId++;
        ids.set(id, i);
        return { jsonrpc: "2.0", id, method: calls[i]!.method, params: calls[i]!.params };
      });
      let resp: unknown;
      try {
        resp = await this.post(body);
      } catch (err) {
        const e =
          err instanceof ChainError ? err : this.fail("network_error", "RPC request failed");
        for (const i of pending) out[i] = { ok: false, error: e };
        return out as Array<RpcOk<T> | RpcFail>;
      }
      if (!Array.isArray(resp)) {
        for (const i of pending) {
          try {
            out[i] = await this.call<T>(calls[i]!.method, calls[i]!.params, { ttlSeconds: ttl });
          } catch (err) {
            out[i] = {
              ok: false,
              error: err instanceof ChainError ? err : this.fail("rpc_error", "RPC call failed"),
            };
          }
        }
        return out as Array<RpcOk<T> | RpcFail>;
      }
      const at = new Date().toISOString();
      const retry: number[] = [];
      const byIndex = new Map<number, JsonRpcResponse>();
      for (const item of resp as JsonRpcResponse[]) {
        const i = typeof item?.id === "number" ? ids.get(item.id) : undefined;
        if (i !== undefined) byIndex.set(i, item);
      }
      for (const i of pending) {
        const r = this.toResult<T>(byIndex.get(i));
        if (r.ok) {
          out[i] = { ok: true, result: r.result, at, cached: false };
          if (ttl > 0) await cachePut(this.cfg.cache, keys[i]!, { at, v: r.result }, ttl);
        } else if (r.rateLimited && attempt === 0) {
          retry.push(i);
        } else {
          out[i] = { ok: false, error: r.error };
        }
      }
      pending = retry;
    }
    return out as Array<RpcOk<T> | RpcFail>;
  }
}

export function createRpcClient(cfg: ChainConfig, opts?: RpcClientOptions): RpcClient {
  return new RpcClient(cfg, opts);
}

/** The public mainnet endpoint rate-limits hard (≈1 getTransaction/s); tools slow down for it. */
export function isPublicMainnetRpc(rpcUrl: string): boolean {
  try {
    return new URL(rpcUrl).hostname === "api.mainnet-beta.solana.com";
  } catch {
    return false;
  }
}
