/**
 * Live smoke test against public mainnet RPC, DexScreener and Jupiter.
 * Run with: LIVE=1 npx vitest run test/live
 * Public RPC throttles getTransaction hard (≈1/s); the tools pace themselves
 * for it, so the distribution read takes a minute or more. Offline tests in
 * test/chain.test.ts stay authoritative for parsing.
 */
import { describe, expect, it } from "vitest";

import {
  getBuilderWeek,
  getDistributionReceipts,
  getPayoutSchedule,
  getPrice,
  getSupply,
  getTokenTrustFacts,
  getWalletTier,
  SET2_DISTRIBUTOR,
} from "../../src/chain";

import type { Cache, ChainConfig, ToolEnvelope } from "../../src/types";

class MemCache implements Cache {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
}

const cfg: ChainConfig = { rpcUrl: "https://api.mainnet-beta.solana.com", cache: new MemCache() };
const log = (label: string, v: unknown) => console.log(`[live] ${label}: ${JSON.stringify(v)}`);

function expectEnvelope(env: ToolEnvelope) {
  expect(typeof env.asOf).toBe("string");
  expect(Array.isArray(env.unavailable)).toBe(true);
  for (const r of env.receipts) {
    expect(r.id).toMatch(/^r:[a-z_]+:/);
    expect(r.numbers.every(Number.isFinite)).toBe(true);
  }
}

describe("live chain reads", () => {
  it("token trust facts", async () => {
    const env = await getTokenTrustFacts(cfg);
    expectEnvelope(env);
    const tf = env.data.transferFee;
    expect(env.data.programName).toBe("Token-2022");
    expect(env.data.decimals).toBe(8);
    expect(typeof tf.current.bps).toBe("number");
    log("trust", {
      slot: env.slot,
      bps: tf.current.bps,
      maxFee: tf.current.maximumFee,
      older: tf.older,
      newer: tf.newer,
      epoch: tf.currentEpoch,
      pending: tf.pendingChange,
      configAuthority: tf.configAuthority,
      withdrawAuthority: tf.withdrawWithheldAuthority,
      mintAuthority: env.data.mintAuthority,
      freezeAuthority: env.data.freezeAuthority,
      metadataAuthority: env.data.metadataUpdateAuthority,
      extensions: env.data.extensions,
      withheldOnMint: tf.withheldOnMint,
    });
  });

  it("supply", async () => {
    const env = await getSupply(cfg);
    expectEnvelope(env);
    expect(env.data.totalSupply).toBeGreaterThan(999_000_000);
    log("supply", {
      total: env.data.totalSupply,
      burned: env.data.burnedSinceGenesis,
      slot: env.slot,
    });
  });

  it("price", async () => {
    const env = await getPrice(cfg);
    expectEnvelope(env);
    expect(env.data.prices.length).toBeGreaterThan(0);
    log("price", {
      prices: env.data.prices.map((p) => ({
        key: p.key,
        usd: p.priceUsd,
        exitUsdc: p.exitLiquidityUsdc,
        liq: p.liquidityUsd,
        at: p.readAt,
      })),
      gaps: env.data.gaps,
      divergent: env.data.divergent,
      caps: env.data.marketCaps.map((c) => ({ key: c.key, usd: Math.round(c.usd) })),
      unavailable: env.unavailable,
    });
  });

  it("wallet tier (the Set #2 distributor wallet)", async () => {
    const env = await getWalletTier(cfg, SET2_DISTRIBUTOR);
    expectEnvelope(env);
    log("wallet", {
      balance: env.data.balance,
      tier: env.data.estimate,
      type: env.data.addressType,
    });
  });

  it("payout schedule", () => {
    const env = getPayoutSchedule();
    log("schedule", { next: env.data.nextDirectorRound, builder: env.data.nextBuilderRoot });
  });

  it("builder week", async () => {
    const env = await getBuilderWeek(cfg);
    expectEnvelope(env);
    log("builder", {
      week: env.data.week,
      vault: env.data.vault,
      rootAuthority: env.data.rootAuthorityType,
      unavailable: env.unavailable,
    });
  });

  it("distribution receipts (latest round, gentle pacing)", async () => {
    const t0 = Date.now();
    const env = await getDistributionReceipts(cfg, { rounds: 3, budgetMs: 240_000 });
    expectEnvelope(env);
    const L = env.data.latest;
    expect(L).not.toBeNull();
    // Public RPC may still refuse some reads: then the round is partial and says so.
    if (!L!.complete) expect(env.unavailable).toEqual(expect.arrayContaining(["basket_totals"]));
    log("distributions", {
      seconds: Math.round((Date.now() - t0) / 1000),
      latest: {
        weekday: L!.weekday,
        start: L!.startUtc,
        end: L!.endUtc,
        tx: L!.txCount,
        parsed: L!.parsedTransactions,
        complete: L!.complete,
      },
      recipients: L!.totals?.uniqueRecipients,
      assets: L!.totals?.assets.map((a) => [a.symbol, a.totalPaidExact, a.recipients]),
      seasSold: L!.totals?.seasSold,
      kinds: L!.totals?.kinds,
      rounds: env.data.rounds.map((r) => `${r.weekday} ${r.startUtc}`),
      streak: env.data.weekdayStreak,
      basketUsd: env.data.basketUsd && Math.round(env.data.basketUsd.totalUsd * 100) / 100,
      unavailable: env.unavailable,
    });
  }, 300_000);
});
