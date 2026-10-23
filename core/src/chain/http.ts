/**
 * Shared HTTP plumbing for chain and market reads: timeout, one retry on
 * 429/5xx, cache access that never fails a tool, and error messages that never
 * carry a URL (paid RPC keys sit in query strings).
 */
import type { Cache, ChainConfig } from "../types";

export type ChainErrorCode =
  | "method_not_allowed"
  | "invalid_address"
  | "timeout"
  | "rate_limited"
  | "http_error"
  | "rpc_error"
  | "network_error"
  | "invalid_response"
  | "not_found";

export class ChainError extends Error {
  constructor(
    readonly code: ChainErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChainError";
  }
}

export const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_RETRY_WAIT_MS = 3_000;
const DEFAULT_RETRY_WAIT_MS = 800;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Strip anything URL-like (and the configured endpoint) from a message before it leaves this module. */
export function sanitize(message: unknown, secrets: string[] = []): string {
  let s = typeof message === "string" ? message : "request failed";
  for (const secret of secrets) {
    if (secret && secret.length >= 6) s = s.split(secret).join("[redacted]");
  }
  s = s
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\b(api[-_]?key|token|key|secret)=[^\s&"']+/gi, "$1=[redacted]");
  return s.slice(0, 200);
}

/** Secret-ish pieces of an endpoint: the full URL, its origin+path, host and query. */
export function secretsOf(url: string): string[] {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter((s) => s.length >= 12);
    const values = [...u.searchParams.values()].filter((v) => v.length >= 8);
    return [
      url,
      `${u.origin}${u.pathname}`,
      u.host,
      u.search.slice(1),
      u.pathname.length > 1 ? u.pathname : "",
      ...segments,
      ...values,
    ]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length); // longest first so partial redactions cannot leave a tail
  } catch {
    return [url];
  }
}

export function fetchImpl(cfg: Pick<ChainConfig, "fetch">): typeof fetch {
  // Wrap the global so Workers never see an unbound `fetch` (Illegal invocation).
  return cfg.fetch ?? ((input, init) => fetch(input, init));
}

function retryWait(res: Response | null): number {
  const h = res?.headers.get("retry-after");
  const secs = h ? Number(h) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
  return DEFAULT_RETRY_WAIT_MS;
}

export interface FetchOptions {
  timeoutMs?: number;
  /** Retries after a 429/5xx; default 1. */
  retries?: number;
  retryWaitMs?: number;
}

/**
 * fetch with a timeout and one retry on 429/5xx. Returns the final Response
 * (possibly still an error status). Throws ChainError on timeout/network
 * failure, with a message that never includes the URL.
 */
export async function fetchWithRetry(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  opts: FetchOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 1;
  let last: Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(opts.retryWaitMs ?? retryWait(last));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      last = await f(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new ChainError("timeout", "request timed out");
      // The underlying message can contain the host; never forward it.
      throw new ChainError("network_error", "request failed (network)");
    }
    clearTimeout(timer);
    if (last.status !== 429 && last.status < 500) return last;
  }
  return last!;
}

// --- cache ---------------------------------------------------------------------------

export const CACHE_PREFIX = "gaia:chain:v1:";

export interface CachedValue<T> {
  /** ISO time of the original read. */
  at: string;
  v: T;
}

export async function cacheGet<T>(
  cache: Cache | undefined,
  key: string,
): Promise<CachedValue<T> | null> {
  if (!cache) return null;
  try {
    const raw = await cache.get(CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedValue<T>;
    return parsed && typeof parsed.at === "string" ? parsed : null;
  } catch {
    return null; // a broken cache is a miss, never a failed tool
  }
}

export async function cachePut<T>(
  cache: Cache | undefined,
  key: string,
  value: CachedValue<T>,
  ttlSeconds: number,
): Promise<void> {
  if (!cache || ttlSeconds <= 0) return;
  try {
    await cache.put(CACHE_PREFIX + key, JSON.stringify(value), ttlSeconds);
  } catch {
    // best effort
  }
}

export interface JsonResult<T> {
  data: T;
  at: string;
  cached: boolean;
}

/** GET a public JSON API (DexScreener, Jupiter) with cache, timeout and one retry. */
export async function getJson<T>(
  cfg: ChainConfig,
  url: string,
  opts: { ttlSeconds: number; cacheKey: string; timeoutMs?: number },
): Promise<JsonResult<T>> {
  const hit = await cacheGet<T>(cfg.cache, opts.cacheKey);
  if (hit) return { data: hit.v, at: hit.at, cached: true };
  const res = await fetchWithRetry(
    fetchImpl(cfg),
    url,
    { method: "GET", headers: { accept: "application/json" } },
    { timeoutMs: opts.timeoutMs },
  );
  if (res.status === 429) throw new ChainError("rate_limited", "API rate limited (HTTP 429)", 429);
  if (!res.ok) throw new ChainError("http_error", `API returned HTTP ${res.status}`, res.status);
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    throw new ChainError("invalid_response", "API returned invalid JSON");
  }
  const at = new Date().toISOString();
  await cachePut(cfg.cache, opts.cacheKey, { at, v: data }, opts.ttlSeconds);
  return { data, at, cached: false };
}
