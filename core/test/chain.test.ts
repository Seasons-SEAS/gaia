import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BUILDER_CONFIG_PDA,
  ChainError,
  classifyAuthority,
  clusterSignatures,
  createRpcClient,
  getBuilderWeek,
  getDistributionReceipts,
  getPayoutSchedule,
  getPrice,
  getSupply,
  getTokenTrustFacts,
  getWalletTier,
  isOnCurve,
  isPublicMainnetRpc,
  isValidAddress,
  KNOWN_MINTS,
  parseDistributorTx,
  parsePrices,
  parseTrustFacts,
  RPC_METHOD_ALLOWLIST,
  sanitize,
  SET2_DISTRIBUTOR,
  summarizeRound,
  trimTx,
  weekRecordAddress,
  weekdayStreak,
  type SignatureInfo,
} from "../src/chain";

import type { Cache, ChainConfig, Receipt } from "../src/types";

// --- fixtures (real responses captured 2026-09-29; see each file's _note) -----------------

const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}`, import.meta.url), "utf8"));
const MINT_ACCOUNT = fx("mint-account.json");
const EPOCH_INFO = fx("epoch-info.json");
const TOKEN_SUPPLY = fx("token-supply.json");
const TOKEN_ACCOUNTS = fx("token-accounts-distributor.json");
const SIGNATURES: SignatureInfo[] = fx("distributor-signatures-page1.json").response.result;
const ROUND_TXS: Array<{
  result: { transaction: { signatures: string[] } } & Record<string, unknown>;
}> = fx("round-latest-transactions.json").responses;
const BUILDER_CONFIG = fx("builder-config.json");
const BUILDER_WEEK = fx("builder-week-record.json").response;
const BUILDER_VAULT_ACCT = fx("builder-vault.json");
const DEX = fx("dexscreener-pairs.json");
const JUP = fx("jupiter-price-v3.json");

const TX_BY_SIG = new Map(ROUND_TXS.map((r) => [r.result.transaction.signatures[0]!, r.result]));
const E1J26 = "E1J26HgTZp4mKyWFz7TmWtEzVkMRAcZ5uoytT6nEJzm8";
const CY3FA3 = "CY3fa3LQmZ9woV3cdfMxGmMYow1WHZ2BGNTcc4JsMDK7";
const RPC_URL = "https://rpc.example.test/v2/?api-key=SECRETKEY1234567890";
const NOW = new Date("2026-09-29T07:00:00Z");

// --- mock fetch ------------------------------------------------------------------------------

class MemCache implements Cache {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
}

type RpcRoute = (method: string, params: unknown[]) => unknown;
interface Mock {
  fetch: typeof fetch;
  methods: string[];
  urls: string[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Route JSON-RPC (single or batch) and the two market APIs from fixtures. */
function mockFetch(route: RpcRoute, http: (url: string) => Response | null = () => null): Mock {
  const methods: string[] = [];
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url === RPC_URL) {
      const body = JSON.parse(String(init?.body));
      const one = (b: { id: number; method: string; params: unknown[] }) => {
        methods.push(b.method);
        const r = route(b.method, b.params);
        if (r && typeof r === "object" && "__error" in (r as object))
          return { jsonrpc: "2.0", id: b.id, error: (r as { __error: unknown }).__error };
        return { jsonrpc: "2.0", id: b.id, result: r };
      };
      return json(Array.isArray(body) ? body.map(one) : one(body));
    }
    const h = http(url);
    if (h) return h;
    if (url.startsWith("https://api.dexscreener.com/")) return json(DEX);
    if (url.startsWith("https://lite-api.jup.ag/price/v3")) return json(JUP);
    throw new TypeError(`unexpected url ${url}`);
  }) as typeof fetch;
  return { fetch: f, methods, urls };
}

/** getSignaturesForAddress paging over the fixture (newest first), honouring limit and before. */
function signaturesRoute(params: unknown[]) {
  const o = (params[1] ?? {}) as { limit?: number; before?: string };
  const start = o.before ? SIGNATURES.findIndex((s) => s.signature === o.before) + 1 : 0;
  return SIGNATURES.slice(start, start + (o.limit ?? 1000));
}

const fixtureRoute: RpcRoute = (method, params) => {
  switch (method) {
    case "getAccountInfo": {
      const addr = params[0];
      if (addr === "7GdpaeSzvkx1a78rRkU11KstM1x8naMmMmmpWQnQSEAS") return MINT_ACCOUNT.result;
      if (addr === BUILDER_CONFIG_PDA) return BUILDER_CONFIG.result;
      if (addr === "3rHQ23oJbipSBqaP44Qsq8z5JgZ8enNb4FciHDbtLJ4w") return BUILDER_WEEK.result;
      if (addr === "Hb5NCcuDVwDPMWoUK44sEkykyfF1rUmvVQtVQYtjUXA1") return BUILDER_VAULT_ACCT.result;
      return { context: { slot: 1 }, value: null };
    }
    case "getEpochInfo":
      return EPOCH_INFO.result;
    case "getTokenSupply":
      return TOKEN_SUPPLY.result;
    case "getTokenAccountsByOwner":
      return params[0] === SET2_DISTRIBUTOR
        ? TOKEN_ACCOUNTS.result
        : { context: { slot: 1 }, value: [] };
    case "getSignaturesForAddress":
      return signaturesRoute(params);
    case "getTransaction":
      return TX_BY_SIG.get(params[0] as string) ?? null;
    default:
      return { __error: { code: -32601, message: "Method not found" } };
  }
};

const cfgWith = (m: Mock, cache?: Cache): ChainConfig => ({
  rpcUrl: RPC_URL,
  fetch: m.fetch,
  ...(cache ? { cache } : {}),
});
const receipt = (rs: Receipt[], id: string) => {
  const r = rs.find((x) => x.id === id);
  if (!r) throw new Error(`missing ${id} in ${rs.map((x) => x.id).join(", ")}`);
  return r;
};
/** Resolves to the rejection of a call that must fail. */
async function failure(p: Promise<unknown>): Promise<ChainError> {
  try {
    await p;
  } catch (e) {
    return e as ChainError;
  }
  throw new Error("expected the call to fail");
}
const near = (r: Receipt, n: number, tol = 1e-9) =>
  r.numbers.some((x) => Math.abs(x - n) <= tol * Math.max(1, Math.abs(n)));

// --- base58 / on-curve --------------------------------------------------------------------------

describe("addresses and on-curve classification", () => {
  it("classifies the two fee authorities as single-key wallets (on-curve EOAs)", () => {
    expect(isOnCurve(E1J26)).toBe(true);
    expect(isOnCurve(CY3FA3)).toBe(true);
    expect(classifyAuthority(E1J26)).toBe("single_key_wallet");
    expect(classifyAuthority(CY3FA3)).toBe("single_key_wallet");
  });

  it("classifies PDAs and the Squads vault as off-curve", () => {
    expect(classifyAuthority(BUILDER_CONFIG_PDA)).toBe("pda");
    expect(classifyAuthority("CXHaE1gdLSB1AAA28QELNZNPgmDAuxafCjegSwxmSJ8k")).toBe("pda");
    expect(classifyAuthority(null)).toBe("none");
  });

  it("derives the week-8 WeekRecord PDA exactly", async () => {
    expect(await weekRecordAddress(8)).toBe("3rHQ23oJbipSBqaP44Qsq8z5JgZ8enNb4FciHDbtLJ4w");
  });

  it("validates base58 addresses", () => {
    expect(isValidAddress(SET2_DISTRIBUTOR)).toBe(true);
    expect(isValidAddress("not-an-address")).toBe(false);
    expect(isValidAddress("0OIl" + "1".repeat(40))).toBe(false);
    expect(isValidAddress("1".repeat(20))).toBe(false);
  });
});

// --- RPC client ---------------------------------------------------------------------------------

describe("RPC client", () => {
  it("allows only the read-only allowlist and rejects before any network call", async () => {
    expect(RPC_METHOD_ALLOWLIST).toHaveLength(10);
    const m = mockFetch(fixtureRoute);
    const rpc = createRpcClient(cfgWith(m));
    for (const bad of [
      "sendTransaction",
      "simulateTransaction",
      "getProgramAccounts",
      "requestAirdrop",
    ]) {
      await expect(rpc.call(bad as never, [])).rejects.toMatchObject({
        code: "method_not_allowed",
      });
    }
    await expect(
      rpc.batch([
        { method: "getSlot", params: [] },
        { method: "sendTransaction" as never, params: [] },
      ]),
    ).rejects.toMatchObject({
      code: "method_not_allowed",
    });
    expect(m.urls).toHaveLength(0);
  });

  it("never echoes the RPC URL or key in errors", async () => {
    const leaky = (async () => {
      throw new TypeError(`fetch failed for ${RPC_URL}`);
    }) as unknown as typeof fetch;
    const err = await failure(
      createRpcClient({ rpcUrl: RPC_URL, fetch: leaky }).call("getSlot", []),
    );
    expect(err).toBeInstanceOf(ChainError);
    expect(err.message).not.toMatch(/SECRETKEY|rpc\.example\.test|https?:/);

    const echo = mockFetch(() => ({
      __error: { code: -32000, message: `upstream ${RPC_URL} rejected key SECRETKEY1234567890` },
    }));
    const e2 = await failure(createRpcClient(cfgWith(echo)).call("getSlot", []));
    expect(e2.code).toBe("rpc_error");
    expect(e2.message).not.toMatch(/SECRETKEY|rpc\.example\.test/);

    let n = 0;
    const down = (async () => {
      n++;
      return new Response("bad gateway", { status: 503 });
    }) as unknown as typeof fetch;
    const e3 = await failure(
      createRpcClient({ rpcUrl: RPC_URL, fetch: down }, { retryWaitMs: 1 }).call("getSlot", []),
    );
    expect(e3.code).toBe("http_error");
    expect(e3.message).toBe("RPC returned HTTP 503");
    expect(n).toBe(2); // one retry
    expect(sanitize(`see https://x.test/a?api-key=abc and key=zzz`)).toBe(
      "see [redacted-url] and key=[redacted]",
    );
  });

  it("retries once on 429 and succeeds", async () => {
    let n = 0;
    const flaky = (async (_: unknown, init?: RequestInit) => {
      n++;
      if (n === 1)
        return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      const b = JSON.parse(String(init?.body));
      return json({ jsonrpc: "2.0", id: b.id, result: 123 });
    }) as unknown as typeof fetch;
    const r = await createRpcClient({ rpcUrl: RPC_URL, fetch: flaky }).call<number>("getSlot", []);
    expect(r.result).toBe(123);
    expect(n).toBe(2);
  });

  it("times out", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      )) as unknown as typeof fetch;
    const err = await failure(
      createRpcClient({ rpcUrl: RPC_URL, fetch: hang }, { timeoutMs: 30 }).call("getSlot", []),
    );
    expect(err.code).toBe("timeout");
  });

  it("batches, retries rate-limited items once, and falls back when batches are unsupported", async () => {
    const seen = new Map<string, number>();
    const m = mockFetch((method, params) => {
      const k = String(params[0]);
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (k === "b" && seen.get(k) === 1)
        return { __error: { code: 429, message: "Too many requests for a specific RPC call" } };
      return `ok:${k}`;
    });
    const out = await createRpcClient(cfgWith(m), { retryWaitMs: 1 }).batch<string>([
      { method: "getBalance", params: ["a"] },
      { method: "getBalance", params: ["b"] },
    ]);
    expect(out.map((o) => (o.ok ? o.result : "fail"))).toEqual(["ok:a", "ok:b"]);
    expect(seen.get("b")).toBe(2);

    const noBatch = (async (_: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body));
      if (Array.isArray(b))
        return json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "batch not supported" },
        });
      return json({ jsonrpc: "2.0", id: b.id, result: b.params[0] });
    }) as unknown as typeof fetch;
    const out2 = await createRpcClient({ rpcUrl: RPC_URL, fetch: noBatch }).batch<string>([
      { method: "getBalance", params: ["x"] },
      { method: "getBalance", params: ["y"] },
    ]);
    expect(out2.map((o) => (o.ok ? o.result : "fail"))).toEqual(["x", "y"]);
  });

  it("caches with the original read time", async () => {
    const cache = new MemCache();
    const m = mockFetch(fixtureRoute);
    const rpc = createRpcClient(cfgWith(m, cache));
    const a = await rpc.call("getEpochInfo", [{}], { ttlSeconds: 60 });
    const b = await rpc.call("getEpochInfo", [{}], { ttlSeconds: 60 });
    expect(b.cached).toBe(true);
    expect(b.at).toBe(a.at);
    expect(m.methods.filter((x) => x === "getEpochInfo")).toHaveLength(1);
    // Cache keys never contain the endpoint or its key.
    expect([...cache.m.keys()].join()).not.toMatch(/SECRET|example/);
  });

  it("recognises the public mainnet endpoint for gentle pacing", () => {
    expect(isPublicMainnetRpc("https://api.mainnet-beta.solana.com")).toBe(true);
    expect(isPublicMainnetRpc(RPC_URL)).toBe(false);
  });
});

// --- trust facts -------------------------------------------------------------------------------------

describe("getTokenTrustFacts", () => {
  it("parses the Token-2022 transferFeeConfig extension of the live mint", () => {
    const d = parseTrustFacts(MINT_ACCOUNT.result, EPOCH_INFO.result);
    expect(d.programName).toBe("Token-2022");
    expect(d.decimals).toBe(8);
    expect(d.mintAuthority).toEqual({ address: null, type: "none" });
    expect(d.freezeAuthority).toEqual({ address: null, type: "none" });
    expect(d.metadataUpdateAuthority.type).toBe("none");
    expect(d.metadataPointerAuthority.type).toBe("none");
    expect(d.metadata).toEqual({ name: "Seasons", symbol: "SEAS" });
    expect(d.extensions).toEqual(["transferFeeConfig", "metadataPointer", "tokenMetadata"]);
    expect(d.riskyExtensionsPresent).toEqual([]);
    const tf = d.transferFee;
    expect(tf.older).toMatchObject({ epoch: 892, bps: 1000, maximumFee: 100_000_000 });
    expect(tf.newer).toMatchObject({ epoch: 892, bps: 1000, maximumFee: 100_000_000 });
    expect(tf.currentEpoch).toBe(1045);
    expect(tf.pendingChange).toBe(false);
    expect(tf.configAuthority).toEqual({ address: E1J26, type: "single_key_wallet" });
    expect(tf.withdrawWithheldAuthority).toEqual({ address: CY3FA3, type: "single_key_wallet" });
    expect(tf.withheldOnMint).toBeCloseTo(288_471.41027326, 8);
  });

  it("flags a pending change until its epoch, then reports the new fee as current", () => {
    const mint = structuredClone(MINT_ACCOUNT.result);
    const ext = mint.value.data.parsed.info.extensions[0].state;
    ext.newerTransferFee = {
      epoch: 1047,
      transferFeeBasisPoints: 2500,
      maximumFee: 10000000000000000,
    };
    const before = parseTrustFacts(mint, { ...EPOCH_INFO.result, epoch: 1045 });
    expect(before.transferFee.pendingChange).toBe(true);
    expect(before.transferFee.current.bps).toBe(1000);
    const after = parseTrustFacts(mint, { ...EPOCH_INFO.result, epoch: 1047 });
    expect(after.transferFee.pendingChange).toBe(false);
    expect(after.transferFee.current.bps).toBe(2500);
  });

  it("rejects a mint without the fee extension", () => {
    const mint = structuredClone(MINT_ACCOUNT.result);
    mint.value.data.parsed.info.extensions = [];
    expect(() => parseTrustFacts(mint, EPOCH_INFO.result)).toThrow(ChainError);
  });

  it("returns chain receipts with Solscan links", async () => {
    const env = await getTokenTrustFacts(cfgWith(mockFetch(fixtureRoute)));
    expect(env.source).toBe("solana-rpc");
    expect(env.slot).toBe(MINT_ACCOUNT.result.context.slot);
    expect(env.ttlSeconds).toBe(600);
    const fee = receipt(env.receipts, "r:trust:fee_bps");
    expect(fee.kind).toBe("chain");
    expect(fee.value).toBe("10% (1000 bps)");
    for (const n of [1000, 10, 0.1]) expect(near(fee, n)).toBe(true);
    expect(fee.url).toBe("https://solscan.io/token/7GdpaeSzvkx1a78rRkU11KstM1x8naMmMmmpWQnQSEAS");
    expect(receipt(env.receipts, "r:trust:pending_change").value).toMatch(/^No change pending/);
    expect(receipt(env.receipts, "r:trust:fee_config_authority").url).toBe(
      `https://solscan.io/account/${E1J26}`,
    );
    expect(receipt(env.receipts, "r:trust:withdraw_authority").value).toMatch(/single-key wallet/);
    expect(receipt(env.receipts, "r:trust:mint_authority").value).toBe("none (revoked)");
    expect(near(receipt(env.receipts, "r:trust:withheld_on_mint"), 288_471.41)).toBe(true);
    expect(new Set(env.receipts.map((r) => r.id)).size).toBe(env.receipts.length);
  });
});

// --- supply ---------------------------------------------------------------------------------------------

describe("getSupply", () => {
  it("reads total supply live and labels circulating as a dated almanac value", async () => {
    const env = await getSupply(cfgWith(mockFetch(fixtureRoute)));
    expect(env.data.totalSupply).toBeCloseTo(999_999_999.8044959, 8);
    expect(env.data.totalSupplyRaw).toBe("99999999980449592");
    expect(env.data.burnedSinceGenesis).toBe(0.19550408);
    expect(env.data.circulating.live).toBe(false);
    expect(env.unavailable).toContain("circulating_supply_live");
    expect(receipt(env.receipts, "r:supply:total").kind).toBe("chain");
    const circ = receipt(env.receipts, "r:supply:circulating_almanac");
    expect(circ.kind).toBe("almanac");
    expect(circ.label).toMatch(/as of 2026-09-28; not a live read/);
    expect(near(circ, 332_989_984.15)).toBe(true);
    expect(near(circ, 333_000_000)).toBe(true);
  });
});

// --- distributions ------------------------------------------------------------------------------------------

describe("distribution rounds", () => {
  const nowSec = Math.floor(NOW.getTime() / 1000);

  it("clusters signatures by > 3 h gaps and marks ≥ 40-tx clusters as payout rounds", () => {
    const clusters = clusterSignatures(SIGNATURES, { historyExhausted: false, nowSec });
    const rounds = clusters.filter((c) => c.kind === "payout_round" && c.complete);
    expect(rounds.length).toBeGreaterThanOrEqual(13);
    const latest = rounds[0]!;
    expect(new Date(latest.startSec * 1000).toISOString()).toBe("2026-09-27T03:42:28.000Z");
    expect(new Date(latest.endSec * 1000).toISOString()).toBe("2026-09-27T06:19:38.000Z");
    expect(latest.txCount).toBe(69);
    expect(latest.possiblyInProgress).toBe(false);
    // The page is full, so the oldest cluster may continue beyond it.
    expect(clusters[clusters.length - 1]!.complete).toBe(false);
    // Preparation clusters (funding, swaps) are small.
    expect(clusters.filter((c) => c.kind === "preparation").every((c) => c.txCount < 40)).toBe(
      true,
    );
    const streak = weekdayStreak(
      rounds.map((c) => ({
        weekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
          new Date(c.startSec * 1000).getUTCDay()
        ]!,
      })),
    );
    expect(streak.allSundayOrWednesday).toBe(true);
    expect(streak.streak).toBe(rounds.length);
  });

  it("flags a round that may still be in progress", () => {
    const soon = Math.floor(Date.parse("2026-09-27T07:00:00Z") / 1000);
    const upTo = SIGNATURES.filter((s) => (s.blockTime ?? 0) <= soon);
    const clusters = clusterSignatures(upTo, { historyExhausted: false, nowSec: soon });
    expect(clusters[0]!.possiblyInProgress).toBe(true);
  });

  it("parses payout vs swap transactions from token-balance deltas", () => {
    const parsed = ROUND_TXS.map((r) =>
      parseDistributorTx(trimTx(r.result as never, r.result.transaction.signatures[0]!)),
    );
    const kinds = parsed.reduce<Record<string, number>>(
      (a, p) => ((a[p.kind] = (a[p.kind] ?? 0) + 1), a),
      {},
    );
    expect(kinds).toEqual({ payout: 60, swap: 8, other: 1 });
    const t = summarizeRound(parsed);
    expect(t.uniqueRecipients).toBe(365);
    expect(t.seasSold).toBeCloseTo(25_011.1101, 8);
    expect(t.assets.map((a) => [a.symbol, a.totalPaidExact, a.recipients])).toEqual([
      ["XAUt0", "0.416109", 365],
      ["wBTC", "0.02108091", 365],
      ["jlUSDc", "2238.609157", 365],
    ]);
    // Swap-route fee accounts that received dust are not recipients.
    const swapCredits = parsed.filter((p) => p.kind === "swap").flatMap((p) => p.credits);
    expect(swapCredits).toEqual([]);
  });

  it("the known-mint map matches the mints and decimals seen in real payouts", () => {
    const parsed = ROUND_TXS.map((r) =>
      parseDistributorTx(trimTx(r.result as never, r.result.transaction.signatures[0]!)),
    );
    const t = summarizeRound(parsed);
    for (const a of t.assets) {
      expect(a.known).toBe(true);
      expect(KNOWN_MINTS[a.mint]!.decimals).toBe(a.decimals);
    }
    expect(t.assets.map((a) => a.mint)).toEqual([
      "AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P",
      "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
      "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D",
    ]);
  });

  it("getDistributionReceipts: latest round, basket totals, weekday check and USD at read-time prices", async () => {
    const cache = new MemCache();
    const m = mockFetch(fixtureRoute);
    const env = await getDistributionReceipts(cfgWith(m, cache), {
      rounds: 3,
      delayMs: 0,
      now: NOW,
    });
    expect(env.degraded).toBe(false);
    expect(env.unavailable).toEqual([]);
    const L = env.data.latest!;
    expect(L.weekday).toBe("Sunday");
    expect(L.startUtc).toBe("2026-09-27T03:42:28Z");
    expect(L.txCount).toBe(69);
    expect(L.complete).toBe(true);
    expect(L.totals!.uniqueRecipients).toBe(365);
    expect(env.data.rounds.map((r) => `${r.weekday} ${r.startUtc.slice(0, 10)}`)).toEqual([
      "Sunday 2026-09-27",
      "Wednesday 2026-09-23",
      "Sunday 2026-09-20",
    ]);
    expect(env.data.rounds[0]!.gapHoursFromPrevious).toBeCloseTo(95, 0);
    expect(env.data.weekdayStreak.allSundayOrWednesday).toBe(true);
    // One signature page and one batch per 10 transactions, nothing else.
    expect(m.methods.filter((x) => x === "getSignaturesForAddress")).toHaveLength(1);
    expect(m.methods.filter((x) => x === "getTransaction")).toHaveLength(69);

    const b = env.data.basketUsd!;
    expect(b.note).toMatch(/when read, not at the time of the payout/);
    const expected =
      0.416109 * JUP.AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P.usdPrice +
      0.02108091 * JUP["3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"].usdPrice +
      2238.609157 * JUP["9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D"].usdPrice;
    expect(b.totalUsd).toBeCloseTo(expected, 6);

    const ids = env.receipts.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "r:dist:latest_round",
        "r:dist:recipients",
        "r:dist:paid_XAUt0",
        "r:dist:paid_wBTC",
        "r:dist:paid_jlUSDc",
        "r:dist:seas_sold",
        "r:dist:rounds",
        "r:dist:weekday_streak",
        "r:dist:basket_usd",
      ]),
    );
    expect(near(receipt(env.receipts, "r:dist:paid_XAUt0"), 0.416109)).toBe(true);
    expect(near(receipt(env.receipts, "r:dist:paid_wBTC"), 0.02108091)).toBe(true);
    expect(near(receipt(env.receipts, "r:dist:paid_jlUSDc"), 2238.61)).toBe(true);
    expect(near(receipt(env.receipts, "r:dist:recipients"), 365)).toBe(true);
    expect(receipt(env.receipts, "r:dist:basket_usd").kind).toBe("api");
    expect(receipt(env.receipts, "r:dist:basket_usd").value).toMatch(
      /not the value at payout time/,
    );
    expect(() => JSON.stringify(env)).not.toThrow();

    // Second call within the TTL is served from the tool cache: no new reads.
    const before = m.methods.length;
    const again = await getDistributionReceipts(cfgWith(m, cache), {
      rounds: 3,
      delayMs: 0,
      now: NOW,
    });
    expect(m.methods.length).toBe(before);
    expect(again.asOf).toBe(env.asOf);
  });

  it("pages signatures with `before` when a page holds too few rounds", async () => {
    const m = mockFetch(fixtureRoute);
    const env = await getDistributionReceipts(cfgWith(m), {
      pageSize: 300,
      maxPages: 3,
      delayMs: 0,
      now: NOW,
      valueUsd: false,
    });
    expect(m.methods.filter((x) => x === "getSignaturesForAddress").length).toBeGreaterThan(1);
    expect(env.data.latest!.totals!.uniqueRecipients).toBe(365);
    expect(env.data.basketUsd).toBeUndefined();
  });

  it("reports a partial round as unavailable (never partial totals) and resumes from the tx cache", async () => {
    const cache = new MemCache();
    let served = 0;
    const m = mockFetch((method, params) => {
      if (method === "getTransaction") {
        served++;
        if (served > 20) return { __error: { code: -32000, message: "upstream down" } };
      }
      return fixtureRoute(method, params);
    });
    const env = await getDistributionReceipts(cfgWith(m, cache), {
      delayMs: 0,
      now: NOW,
      valueUsd: false,
      budgetMs: 2_000,
    });
    expect(env.degraded).toBe(true);
    expect(env.unavailable).toEqual(expect.arrayContaining(["basket_totals", "unique_recipients"]));
    expect(env.data.latest!.totals).toBeUndefined();
    expect(env.receipts.some((r) => r.id.startsWith("r:dist:paid_"))).toBe(false);

    // Next call: cached transactions are reused; only the rest is fetched.
    const m2 = mockFetch(fixtureRoute);
    const env2 = await getDistributionReceipts(cfgWith(m2, cache), {
      delayMs: 0,
      now: NOW,
      valueUsd: false,
    });
    expect(env2.degraded).toBe(false);
    expect(m2.methods.filter((x) => x === "getTransaction").length).toBe(69 - 20);
    expect(env2.data.latest!.totals!.uniqueRecipients).toBe(365);
  });

  it("marks basket_usd unavailable when prices cannot be read", async () => {
    const m = mockFetch(fixtureRoute, (url) =>
      url.includes("jup.ag") ? new Response("down", { status: 500 }) : null,
    );
    const env = await getDistributionReceipts(cfgWith(m), { delayMs: 0, now: NOW });
    expect(env.unavailable).toContain("basket_usd");
    expect(env.data.basketUsd).toBeUndefined();
    expect(env.data.latest!.totals!.assets).toHaveLength(3);
  });
});

// --- price ----------------------------------------------------------------------------------------------------

describe("getPrice", () => {
  it("returns each source with its read time, the gap, exit liquidity and named market caps", async () => {
    const env = await getPrice(cfgWith(mockFetch(fixtureRoute)));
    const d = env.data;
    expect(d.prices.map((p) => [p.key, p.priceUsd])).toEqual([
      ["raydium_clmm", 0.2664],
      ["meteora_damm", 0.2664],
      ["jupiter", JUP["7GdpaeSzvkx1a78rRkU11KstM1x8naMmMmmpWQnQSEAS"].usdPrice],
    ]);
    expect(d.canonical).toBe("raydium_clmm");
    expect(d.prices[0]!.exitLiquidityUsdc).toBe(78_210);
    expect(d.prices[1]!.exitLiquidityUsdc).toBe(125_190);
    expect(d.totalExitLiquidityUsdc).toBe(203_400);
    const jGap = d.gaps.find((g) => g.source === "jupiter")!;
    expect(jGap.gapPct).toBeCloseTo(((0.26645403605935036 - 0.2664) / 0.2664) * 100, 10);
    expect(d.divergent).toBe(false);
    const chainCap = d.marketCaps.find((c) => c.key === "chain_circulating")!;
    expect(chainCap.usd).toBeCloseTo(0.2664 * 332_989_984.15, 4);
    expect(chainCap.definition).toMatch(/time-lock escrows; almanac as of 2026-09-28/);
    expect(d.marketCaps.find((c) => c.key === "dexscreener")!.definition).toMatch(
      /its own circulating figure/,
    );
    // The brain reads the first r:price: receipt's first number as the price.
    const first = env.receipts.find((r) => r.id.startsWith("r:price:"))!;
    expect(first.id).toBe("r:price:raydium_clmm");
    expect(first.numbers[0]).toBe(0.2664);
    expect(first.url).toBe(
      "https://dexscreener.com/solana/fc6nsemazygwwqcr6uqssx8axv85qcoa5tajmrbhgzvy",
    );
    expect(env.degraded).toBe(false);
    expect(env.ttlSeconds).toBe(30);
  });

  it("flags a large gap as divergent", () => {
    const jup = { [Object.keys(JUP)[1]!]: JUP[Object.keys(JUP)[1]!] } as Record<
      string,
      { usdPrice: number }
    >;
    jup["7GdpaeSzvkx1a78rRkU11KstM1x8naMmMmmpWQnQSEAS"] = { usdPrice: 0.2392 };
    const { data } = parsePrices({ data: DEX, at: "t" }, { data: jup, at: "t" });
    expect(data.gaps.find((g) => g.source === "jupiter")!.gapPct).toBeCloseTo(-10.21, 2);
    expect(data.divergent).toBe(true);
  });

  it("never invents a price: failed sources are unavailable", async () => {
    const dexDown = mockFetch(fixtureRoute, (url) =>
      url.includes("dexscreener") ? new Response("err", { status: 500 }) : null,
    );
    const env = await getPrice(cfgWith(dexDown));
    expect(env.degraded).toBe(true);
    expect(env.unavailable).toEqual(
      expect.arrayContaining([
        "price_raydium_clmm",
        "price_meteora_damm",
        "price_canonical",
        "market_cap",
      ]),
    );
    expect(env.data.prices.map((p) => p.key)).toEqual(["jupiter"]);
    expect(env.data.marketCaps).toEqual([]);

    const allDown = mockFetch(fixtureRoute, () => new Response("err", { status: 503 }));
    const env2 = await getPrice(cfgWith(allDown));
    expect(env2.data.prices).toEqual([]);
    expect(env2.receipts).toEqual([]);
    expect(env2.unavailable).toContain("price_jupiter");
  });
});

// --- wallet tier ---------------------------------------------------------------------------------------------

describe("getWalletTier", () => {
  it("sums the Token-2022 balance and estimates the tier with the caveat", async () => {
    const env = await getWalletTier(cfgWith(mockFetch(fixtureRoute)), SET2_DISTRIBUTOR);
    expect(env.data.balance).toBeCloseTo(19_511.1101, 8);
    expect(env.data.balanceExact).toBe("19511.1101");
    expect(env.data.estimate.tier).toBe("director");
    expect(env.data.caveat).toMatch(/^balance-based estimate; other eligibility rules apply/);
    expect(env.data.addressType).toBe(classifyAuthority(SET2_DISTRIBUTOR));
    expect(receipt(env.receipts, "r:wallet:balance").url).toBe(
      `https://solscan.io/account/${SET2_DISTRIBUTOR}`,
    );
    expect(env.receipts.some((r) => r.id === "r:wallet:to_next")).toBe(false);
  });

  it("an empty wallet is a real 0 balance with the distance and gross-up to Builder", async () => {
    const env = await getWalletTier(cfgWith(mockFetch(fixtureRoute)), E1J26);
    expect(env.data.balance).toBe(0);
    expect(env.data.estimate).toEqual({ tier: "none", nextTier: "builder", toNext: 1_000 });
    expect(env.data.grossToNext).toBeCloseTo(1_111.11111112, 8);
    expect(near(receipt(env.receipts, "r:wallet:to_next"), 1_111.12)).toBe(true);
    expect(env.unavailable).toEqual([]);
  });

  it("marks program-owned addresses and rejects invalid ones before any read", async () => {
    const env = await getWalletTier(cfgWith(mockFetch(fixtureRoute)), BUILDER_CONFIG_PDA);
    expect(env.data.addressType).toBe("pda");
    expect(env.data.caveat).toMatch(/not counted as nodes/);
    const m = mockFetch(fixtureRoute);
    await expect(getWalletTier(cfgWith(m), "hello")).rejects.toMatchObject({
      code: "invalid_address",
    });
    expect(m.urls).toHaveLength(0);
  });
});

// --- schedule and builder week ----------------------------------------------------------------------------------

describe("getPayoutSchedule", () => {
  it("on a Tuesday: next Director round Wednesday, then Sunday; Builder root Sunday", () => {
    const env = getPayoutSchedule(new Date("2026-09-29T10:00:00Z"));
    expect(env.data.nextDirectorRound).toEqual({
      date: "2026-09-30",
      weekday: "Wednesday",
      isToday: false,
      daysAway: 1,
    });
    expect(env.data.followingDirectorRound).toMatchObject({
      date: "2026-10-04",
      weekday: "Sunday",
    });
    expect(env.data.nextBuilderRoot).toMatchObject({ date: "2026-10-04", weekday: "Sunday" });
    // Never an hour.
    for (const r of env.receipts) expect(r.value).not.toMatch(/\d{1,2}:\d{2}/);
    expect(JSON.stringify(env.data)).not.toMatch(/T\d{2}:\d{2}/);
  });

  it("on a round day it says it may already have landed", () => {
    const env = getPayoutSchedule(new Date("2026-09-27T23:00:00Z"));
    expect(env.data.nextDirectorRound).toMatchObject({
      date: "2026-09-27",
      weekday: "Sunday",
      isToday: true,
    });
    expect(env.data.followingDirectorRound.date).toBe("2026-09-30");
    expect(env.data.note).toMatch(/may already have landed/);
    expect(getPayoutSchedule(new Date("2026-10-01T00:00:00Z")).data.nextDirectorRound.date).toBe(
      "2026-10-04",
    );
  });
});

describe("getBuilderWeek", () => {
  it("decodes the config PDA, the WeekRecord and the vault", async () => {
    const env = await getBuilderWeek(cfgWith(mockFetch(fixtureRoute)));
    const d = env.data;
    expect(d.config.currentWeek).toBe(8);
    expect(d.config.currentRoot.startsWith("fc9ff7fd")).toBe(true);
    expect(d.config.mint).toBe("7GdpaeSzvkx1a78rRkU11KstM1x8naMmMmmpWQnQSEAS");
    expect(d.config.vault).toBe("Hb5NCcuDVwDPMWoUK44sEkykyfF1rUmvVQtVQYtjUXA1");
    expect(d.rootAuthorityType).toBe("single_key_wallet");
    expect(d.week).toEqual({
      week: 8,
      root: d.config.currentRoot,
      builderCount: 121,
      totalCumulative: 3435.72690954,
      publishedSlot: 450_986_288,
    });
    expect(d.vault).toEqual({
      address: "Hb5NCcuDVwDPMWoUK44sEkykyfF1rUmvVQtVQYtjUXA1",
      balance: 4293.3324219,
      withheld: 588.5,
    });
    expect(env.unavailable).toEqual([]);
    expect(near(receipt(env.receipts, "r:builder:week_record"), 121)).toBe(true);
  });
});
