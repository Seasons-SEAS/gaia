import { describe, expect, it } from "vitest";

import {
  calcCompound,
  calcExpr,
  calcGrossUp,
  calcRoundTrip,
  calcTaxedCompounding,
  calcTaxLens,
  calcTimeToEarnBack,
  classifyTier,
  evaluateExpr,
  grossUpBase,
  KernelInputError,
  preflightSellBelowThreshold,
  preflightSplit,
  preflightTransfer,
  seasToBase,
  tierForBalance,
  transferFeeBase,
} from "../src/kernel";

import type { Receipt, ToolEnvelope } from "../src/types";

const MAX_FEE = seasToBase(100_000_000);
const has = (r: Receipt, n: number, tol = 1e-9) =>
  r.numbers.some((x) => Math.abs(x - n) <= tol * Math.max(1, Math.abs(n)));
const byField = (env: ToolEnvelope, field: string) => {
  const r = env.receipts.find((x) => x.id.split("@")[0]!.endsWith(`:${field}`));
  if (!r) throw new Error(`no receipt for ${field}: ${env.receipts.map((x) => x.id).join(", ")}`);
  return r;
};

function expectKernelEnvelope(env: ToolEnvelope) {
  expect(env.source).toBe("kernel");
  expect(env.degraded).toBe(false);
  expect(env.receipts.length).toBeGreaterThan(0);
  for (const r of env.receipts) {
    expect(r.kind).toBe("calc");
    expect(r.id).toMatch(/^r:[a-z_]+:[A-Za-z0-9_]+@[0-9a-f]{6}$/);
    expect(r.locator.length).toBeGreaterThan(3);
    expect(r.numbers.every((n) => Number.isFinite(n))).toBe(true);
    expect(() => new Date(r.read_at).toISOString()).not.toThrow();
  }
  // Data must survive JSON (no bigint leaks into the model-facing payload).
  expect(() => JSON.stringify(env.data)).not.toThrow();
}

describe("Token-2022 fee arithmetic", () => {
  it("withholds ceil(amount × bps / 10,000), capped at maximumFee", () => {
    expect(transferFeeBase(seasToBase(10_000), 1000, MAX_FEE)).toBe(seasToBase(1_000));
    expect(transferFeeBase(1n, 1000, MAX_FEE)).toBe(1n); // ceil: the smallest transfer still pays a unit
    expect(transferFeeBase(0n, 1000, MAX_FEE)).toBe(0n);
    expect(transferFeeBase(seasToBase(5_000_000_000), 1000, MAX_FEE)).toBe(MAX_FEE);
  });

  it("gross-up is the minimal gross that nets the target", () => {
    const net = seasToBase(10_000);
    const g = grossUpBase(net, 1000, MAX_FEE);
    expect(g).toBe(1_111_111_111_112n); // 11,111.11111112 $SEAS
    expect(g - transferFeeBase(g, 1000, MAX_FEE)).toBeGreaterThanOrEqual(net);
    expect(g - 1n - transferFeeBase(g - 1n, 1000, MAX_FEE)).toBeLessThan(net);
    expect(grossUpBase(net, 0, MAX_FEE)).toBe(net);
    expect(grossUpBase(net, 10_000, MAX_FEE)).toBe(net + MAX_FEE);
  });
});

describe("tierForBalance", () => {
  it("uses Director ≥ 10,000 and Builder 1,000–9,999", () => {
    expect(classifyTier(10_000)).toEqual({ tier: "director" });
    expect(classifyTier(12_000)).toEqual({ tier: "director" });
    expect(classifyTier(9_999.99999999)).toEqual({
      tier: "builder",
      nextTier: "director",
      toNext: 0.00000001,
    });
    expect(classifyTier(9_000)).toEqual({ tier: "builder", nextTier: "director", toNext: 1_000 });
    expect(classifyTier(1_000)).toEqual({ tier: "builder", nextTier: "director", toNext: 9_000 });
    expect(classifyTier(999)).toEqual({ tier: "none", nextTier: "builder", toNext: 1 });
    expect(classifyTier(0)).toEqual({ tier: "none", nextTier: "builder", toNext: 1_000 });
    expect(classifyTier(1e12).tier).toBe("director");
  });

  it("returns an envelope with the caveat and receipts", () => {
    const env = tierForBalance(9_000);
    expectKernelEnvelope(env);
    expect(env.data.tier).toBe("builder");
    expect(env.data.caveat).toMatch(/balance-based estimate/);
    expect(has(byField(env, "to_next"), 1_000)).toBe(true);
    expect(has(byField(env, "tier"), 9_000)).toBe(true);
  });

  it("refuses negative and non-finite balances", () => {
    expect(() => tierForBalance(-1)).toThrow(KernelInputError);
    expect(() => tierForBalance(Number.NaN)).toThrow(KernelInputError);
    expect(() => tierForBalance(Number.POSITIVE_INFINITY)).toThrow(KernelInputError);
  });
});

describe("calcGrossUp (F4)", () => {
  it("10,000 net needs 11,111.12 gross; 1,000 needs 1,111.12", () => {
    const env = calcGrossUp({ targetNet: 10_000 });
    expectKernelEnvelope(env);
    expect(env.data.grossSeasExact).toBe("11111.11111112");
    expect(env.data.grossSeasDisplay).toBe(11_111.12);
    expect(env.data.feeSeas).toBeCloseTo(1_111.11111112, 8);
    const gross = byField(env, "gross");
    expect(has(gross, 11_111.12)).toBe(true);
    // Never vouch for a figure that falls short of the target.
    expect(has(gross, 11_111.11)).toBe(false);
    expect(calcGrossUp({ targetNet: 1_000 }).data.grossSeasDisplay).toBe(1_111.12);
  });

  it("adds the pool fee and USD cost when given", () => {
    const env = calcGrossUp({ targetNet: 10_000, poolFeePct: 0.25, priceUsd: 0.2697 });
    expect(env.data.buyWorthSeas).toBeCloseTo(11_138.95, 1);
    expect(env.data.costUsd).toBeCloseTo(11_138.95 * 0.2697, 1);
    expect(env.receipts.some((r) => r.id.startsWith("r:grossup:cost_usd@"))).toBe(true);
  });

  it("handles 0, fee 0 and bad inputs", () => {
    expect(calcGrossUp({ targetNet: 0 }).data.grossSeas).toBe(0);
    expect(calcGrossUp({ targetNet: 10_000, feeBps: 0 }).data.grossSeas).toBe(10_000);
    expect(() => calcGrossUp({ targetNet: -5 })).toThrow(KernelInputError);
    expect(() => calcGrossUp({ targetNet: 10_000, feeBps: 10_001 })).toThrow(KernelInputError);
    expect(() => calcGrossUp({ targetNet: 10_000, feeBps: 12.5 })).toThrow(KernelInputError);
  });
});

describe("calcRoundTrip (F5)", () => {
  it("loses 19% and needs +23.46% to break even without a pool fee", () => {
    const env = calcRoundTrip();
    expectKernelEnvelope(env);
    expect(env.data.keepFraction).toBeCloseTo(0.81, 12);
    expect(env.data.lossPct).toBeCloseTo(19, 10);
    expect(env.data.breakEvenPct).toBeCloseTo(23.4568, 4);
    expect(has(byField(env, "break_even"), 23.46)).toBe(true);
    expect(has(byField(env, "loss"), 19)).toBe(true);
    expect(env.data.waterfall.map((s) => Math.round(s.valueUsd * 100) / 100)).toEqual([
      100, 90, 81,
    ]);
  });

  it("needs +24.1% at a 0.25% pool fee (19.4% loss)", () => {
    const env = calcRoundTrip({ poolFeePct: 0.25 });
    expect(env.data.breakEvenPct).toBeCloseTo(24.0764, 3);
    expect(env.data.lossPct).toBeCloseTo(19.404, 2);
    expect(has(byField(env, "break_even"), 24.1)).toBe(true);
    expect(has(byField(env, "loss"), 19.4)).toBe(true);
  });

  it("applies the user's price change inside the waterfall", () => {
    const even = calcRoundTrip({ priceChangePct: 23.456790123456 });
    expect(even.data.finalValueUsd).toBeCloseTo(100, 6);
    const down = calcRoundTrip({ priceChangePct: -30, amountUsd: 1_000 });
    expect(down.data.finalValueUsd).toBeCloseTo(567, 6);
    expect(down.data.netResultPct).toBeCloseTo(-43.3, 6);
    expect(() => calcRoundTrip({ priceChangePct: -150 })).toThrow(KernelInputError);
  });
});

describe("calcTaxLens (F1–F3)", () => {
  it("T1: moving 10,000 to a new wallet leaves 9,000 (Director becomes Builder)", () => {
    const env = calcTaxLens({ amount: 10_000, unit: "SEAS", side: "transfer" });
    expectKernelEnvelope(env);
    expect(env.data.netSeas).toBe(9_000);
    expect(env.data.transferFeeSeas).toBe(1_000);
    expect(env.data.resultingTier?.tier).toBe("builder");
    const t1 = env.data.traps.find((t) => t.id === "T1");
    expect(t1?.detail).toMatch(/11,111\.12/);
    expect(has(byField(env, "trap_T1"), 11_111.12)).toBe(true);
    expect(has(byField(env, "net_received"), 9_000)).toBe(true);
  });

  it("F1 buy: $1,000 at $0.2697 with a 0.25% pool fee gives ≈3,328.7 $SEAS", () => {
    const env = calcTaxLens({
      amount: 1_000,
      unit: "USD",
      side: "buy",
      priceUsd: 0.2697,
      poolFeePct: 0.25,
    });
    expect(env.data.netSeas).toBeCloseTo(3_328.69, 1);
    expect(env.data.poolFeeUsd).toBeCloseTo(2.5, 10);
    expect(env.data.netUsd).toBeCloseTo(897.75, 1);
    expect(env.data.effectiveCostPct).toBeCloseTo(10.225, 2);
    expect(env.data.resultingTier?.tier).toBe("builder");
    expect(env.unavailable).toEqual([]);
  });

  it("T2: buying exactly the threshold's worth is not enough", () => {
    const env = calcTaxLens({
      amount: 2_697,
      unit: "USD",
      side: "buy",
      priceUsd: 0.2697,
      poolFeePct: 0.25,
    });
    expect(env.data.netSeas).toBeCloseTo(8_977.5, 1);
    const t2 = env.data.traps.find((t) => t.id === "T2");
    expect(t2).toBeDefined();
    expect(has(byField(env, "trap_T2"), 11_138.95, 1e-6)).toBe(true);
  });

  it("without a price, a USD amount yields fractions only and lists what is unavailable", () => {
    const env = calcTaxLens({ amount: 100, unit: "USD", side: "buy" });
    expect(env.data.netSeas).toBeUndefined();
    expect(env.data.netUsd).toBeCloseTo(90, 10);
    expect(env.unavailable).toEqual(
      expect.arrayContaining(["price_usd", "net_seas", "resulting_tier"]),
    );
    expect(env.receipts.some((r) => r.id.startsWith("r:tax:net_received"))).toBe(false);
  });

  it("F2 sell: 1,000 $SEAS at $0.25 returns $225 (10% fee)", () => {
    const env = calcTaxLens({ amount: 1_000, unit: "SEAS", side: "sell", priceUsd: 0.25 });
    expect(env.data.netSeas).toBe(900);
    expect(env.data.netUsd).toBeCloseTo(225, 10);
    expect(env.data.transferFeeUsd).toBeCloseTo(25, 10);
    expect(env.data.resultingTier).toBeUndefined();
  });

  it("edge cases: 0, huge (fee cap), negative, bad enums", () => {
    const zero = calcTaxLens({ amount: 0, unit: "SEAS", side: "transfer" });
    expect(zero.data.netSeas).toBe(0);
    expect(zero.data.transferFeeSeas).toBe(0);
    const huge = calcTaxLens({ amount: 5_000_000_000, unit: "SEAS", side: "transfer" });
    expect(huge.data.exceedsTotalSupply).toBe(true);
    expect(huge.data.transferFeeSeas).toBe(100_000_000); // maximumFee cap
    expect(() => calcTaxLens({ amount: -1, unit: "SEAS", side: "buy" })).toThrow(KernelInputError);
    expect(() => calcTaxLens({ amount: 1e16, unit: "SEAS", side: "buy" })).toThrow(
      KernelInputError,
    );
    expect(() => calcTaxLens({ amount: 1, unit: "EUR" as never, side: "buy" })).toThrow(
      KernelInputError,
    );
    expect(() => calcTaxLens({ amount: 1, unit: "SEAS", side: "swap" as never })).toThrow(
      KernelInputError,
    );
    expect(() => calcTaxLens({ amount: 1, unit: "USD", side: "buy", priceUsd: 0 })).toThrow(
      KernelInputError,
    );
  });
});

describe("calcTimeToEarnBack (F12)", () => {
  it("entry fee at 12%: ≈0.93 years; round trip ≈1.76 years", () => {
    const entry = calcTimeToEarnBack({ ratePct: 12, basis: "entry_fee" });
    expectKernelEnvelope(entry);
    expect(entry.data.years).toBeCloseTo(0.9259, 4);
    const rt = calcTimeToEarnBack({ ratePct: 12, basis: "round_trip" });
    expect(rt.data.years).toBeCloseTo(0.21111 / 0.12, 3);
    expect(has(byField(rt, "years_flat"), 1.76)).toBe(true);
  });

  it("matches the documented round-trip table (0.2111 / r)", () => {
    const table: Array<[number, number]> = [
      [6.58, 3.21],
      [18.6, 1.14],
      [21.07, 1.0],
    ];
    for (const [rate, years] of table) {
      expect(
        Math.round(calcTimeToEarnBack({ ratePct: rate, basis: "round_trip" }).data.years * 100) /
          100,
      ).toBe(years);
    }
  });

  it("adds −30% and −60% price paths", () => {
    const rt = calcTimeToEarnBack({ ratePct: 12, basis: "round_trip" });
    expect(rt.data.paths.map((p) => p.priceChangePct)).toEqual([0, -30, -60]);
    expect(rt.data.paths[1]!.years).toBeCloseTo((1 - 0.81 * 0.7) / (0.9 * 0.7 * 0.12), 8);
    expect(rt.data.paths[2]!.years).toBeCloseTo((1 - 0.81 * 0.4) / (0.9 * 0.4 * 0.12), 8);
    expect(rt.receipts.map((r) => r.id.split("@")[0])).toEqual([
      "r:earnback:years_flat",
      "r:earnback:years_minus30",
      "r:earnback:years_minus60",
    ]);
  });

  it("never picks a rate: missing, zero or negative rates are refused", () => {
    expect(() => calcTimeToEarnBack({ basis: "entry_fee" } as never)).toThrow(/user's own rate/);
    expect(() => calcTimeToEarnBack({ ratePct: 0, basis: "entry_fee" })).toThrow(KernelInputError);
    expect(() => calcTimeToEarnBack({ ratePct: -5, basis: "round_trip" })).toThrow(
      KernelInputError,
    );
    expect(() => calcTimeToEarnBack({ ratePct: Number.NaN, basis: "round_trip" })).toThrow(
      KernelInputError,
    );
  });
});

describe("calcTaxedCompounding (F13) and calcCompound", () => {
  it("reinvesting pays the fee again: ≤0.9× effect", () => {
    const env = calcTaxedCompounding({ ratePct: 12, years: 1 });
    expectKernelEnvelope(env);
    expect(env.data.reinvestKeep).toBeCloseTo(0.9, 12);
    expect(env.data.periodsPerYear).toBe(104);
    expect(env.data.multiplierTaxed).toBeCloseTo((1 + 0.108 / 104) ** 104, 10);
    expect(env.data.multiplierUntaxed).toBeCloseTo((1 + 0.12 / 104) ** 104, 10);
    expect(env.data.multiplierTaxed - 1).toBeLessThan(env.data.multiplierUntaxed - 1);
    expect(env.data.effectiveAnnualTaxedPct).toBeLessThan(12);
    expect(has(byField(env, "reinvest_keep"), 10.8)).toBe(true);
  });

  it("0 years is neutral; bad inputs refused", () => {
    expect(calcTaxedCompounding({ ratePct: 12, years: 0 }).data.multiplierTaxed).toBe(1);
    expect(() => calcTaxedCompounding({ ratePct: 12, years: -1 })).toThrow(KernelInputError);
    expect(() => calcTaxedCompounding({ ratePct: 12, years: 1, periodsPerYear: 0 })).toThrow(
      KernelInputError,
    );
  });

  it("calcCompound is plain compound interest", () => {
    const env = calcCompound({ ratePct: 10, years: 2, principal: 1_000 });
    expectKernelEnvelope(env);
    expect(env.data.multiplier).toBeCloseTo(1.21, 12);
    expect(env.data.finalValue).toBeCloseTo(1_210, 9);
    expect(
      calcCompound({ ratePct: 12, years: 1, periodsPerYear: 12 }).data.effectiveAnnualPct,
    ).toBeCloseTo(12.6825, 3);
    expect(() => calcCompound({ ratePct: -100, years: 1 })).toThrow(KernelInputError);
  });
});

describe("preflightTransfer (T1)", () => {
  it("moving all 10,000 to a Ledger: 9,000 arrives, Director → Builder", () => {
    const env = preflightTransfer({ balance: 10_000, amount: 10_000 });
    expectKernelEnvelope(env);
    const d = env.data;
    expect(d.recipientReceives).toBe(9_000);
    expect(d.feeSeas).toBe(1_000);
    expect(d.senderBefore.tier).toBe("director");
    expect(d.senderAfter.tier).toBe("none");
    expect(d.recipientAfter.tier).toBe("builder");
    expect(d.positionTierBefore).toBe("director");
    expect(d.positionTierAfter).toBe("builder");
    expect(d.grossToKeepTier).toBeCloseTo(11_111.11111112, 8);
    const t1 = d.traps.find((t) => t.id === "T1")!;
    expect(t1.detail).toMatch(/11,111\.12/);
    expect(t1.detail).toMatch(/more than the 10,000 \$SEAS you hold/);
    expect(has(byField(env, "trap_T1"), 11_111.12)).toBe(true);
  });

  it("a partial move that stays in tier fires no trap but flags the sender dropping", () => {
    const env = preflightTransfer({ balance: 12_000, amount: 5_000 });
    expect(env.data.recipientReceives).toBe(4_500);
    expect(env.data.traps).toEqual([]);
    expect(env.data.senderDropsTier).toBe(true);
    expect(env.data.senderAfter.tier).toBe("builder");
  });

  it("topping up an existing wallet counts its balance", () => {
    const env = preflightTransfer({ balance: 5_000, amount: 2_000, recipientBalance: 8_500 });
    expect(env.data.recipientAfter.balance).toBe(10_300);
    expect(env.data.recipientAfter.tier).toBe("director");
    expect(env.data.traps).toEqual([]);
  });

  it("flags an amount above the balance and refuses bad input", () => {
    expect(preflightTransfer({ balance: 100, amount: 200 }).data.insufficientBalance).toBe(true);
    expect(() => preflightTransfer({ balance: 100, amount: 0 })).toThrow(KernelInputError);
    expect(() => preflightTransfer({ balance: -1, amount: 1 })).toThrow(KernelInputError);
  });
});

describe("preflightSplit (T3)", () => {
  it("20,000 split in two by transfer: one Director and one Builder; two Directors need 21,111.12", () => {
    const env = preflightSplit({ balance: 20_000, parts: 2 });
    expectKernelEnvelope(env);
    expect(env.data.wallets.map((w) => [w.balance, w.tier])).toEqual([
      [10_000, "director"],
      [9_000, "builder"],
    ]);
    expect(env.data.directors).toBe(1);
    expect(env.data.builders).toBe(1);
    expect(env.data.minBalanceForAllDirectors).toBeCloseTo(21_111.11111112, 8);
    expect(env.data.traps[0]?.id).toBe("T3");
    expect(env.data.traps[0]?.detail).toMatch(/21,111\.12/);
    expect(has(byField(env, "min_balance_all_directors"), 21_111.12)).toBe(true);
  });

  it("explicit amounts: the source keeps the remainder", () => {
    const env = preflightSplit({ balance: 30_000, parts: [10_000, 10_000] });
    expect(env.data.wallets.map((w) => w.balance)).toEqual([10_000, 9_000, 9_000]);
    expect(env.data.totalFeeSeas).toBe(2_000);
    expect(preflightSplit({ balance: 5_000, parts: [10_000] }).data.insufficientBalance).toBe(true);
    expect(() => preflightSplit({ balance: 5_000, parts: 1 })).toThrow(KernelInputError);
  });
});

describe("preflightSellBelowThreshold (T6, T10)", () => {
  it("selling 1,000 of 10,500 drops a Director to Builder and costs fees twice to return", () => {
    const env = preflightSellBelowThreshold({ balance: 10_500, amount: 1_000, priceUsd: 0.25 });
    expectKernelEnvelope(env);
    const d = env.data;
    expect(d.tierBefore.tier).toBe("director");
    expect(d.tierAfter.tier).toBe("builder");
    expect(d.balanceAfter).toBe(9_500);
    expect(d.feeSeas).toBe(100);
    expect(d.proceedsUsd).toBeCloseTo(225, 10);
    expect(d.maxSellKeepingTier).toBe(500);
    expect(d.buyBackGross).toBeCloseTo(555.55555556, 8);
    expect(d.traps.map((t) => t.id)).toEqual(["T6", "T10"]);
    expect(has(byField(env, "buy_back"), 555.56)).toBe(true);
  });

  it("a sale that keeps the tier only carries the T10 reminder", () => {
    const env = preflightSellBelowThreshold({ balance: 10_500, amount: 400 });
    expect(env.data.tierAfter.tier).toBe("director");
    expect(env.data.traps.map((t) => t.id)).toEqual(["T10"]);
    expect(env.unavailable).toEqual([]);
  });
});

describe("calcExpr", () => {
  it("derives ≈60% of supply from receipt-backed inputs", () => {
    const env = calcExpr({
      expr: "locked / supply",
      inputs: {
        locked: { value: 600_309_014.08, receipt: "r:supply:circulating_almanac" },
        supply: 999_999_999.8044959,
      },
      format: "percent",
      name: "locked_share",
    });
    expectKernelEnvelope(env);
    expect(env.data.result).toBeCloseTo(0.60030901, 6);
    const r = env.receipts[0]!;
    expect(r.id).toMatch(/^r:expr:locked_share@/);
    expect(has(r, 60.03)).toBe(true);
    expect(has(r, 600_309_014.08)).toBe(true);
    expect(r.locator).toMatch(/locked=r:supply:circulating_almanac/);
  });

  it("supports × ÷ − precedence, parentheses and unary minus", () => {
    expect(evaluateExpr("(a + b) × 2 ÷ 4", { a: 3, b: 5 }).result).toBe(4);
    expect(evaluateExpr("a − b * 2", { a: 10, b: 3 }).result).toBe(4);
    expect(evaluateExpr("-a + -(-b)", { a: 1, b: 2 }).result).toBe(1);
    expect(evaluateExpr("1.5e3 / x", { x: 3 }).result).toBe(500);
  });

  it("refuses code, unknown names, division by zero and oversized input", () => {
    expect(() => evaluateExpr("alert(1)", {})).toThrow(/unknown input/);
    expect(() => evaluateExpr("a; process.exit()", { a: 1 })).toThrow(KernelInputError);
    expect(() => evaluateExpr("2 ** 3", {})).toThrow(KernelInputError);
    expect(() => evaluateExpr("constructor", {})).toThrow(/unknown input/);
    expect(() => evaluateExpr("a / (b - b)", { a: 1, b: 2 })).toThrow(/division by zero/);
    expect(() => evaluateExpr("((((1))", {})).toThrow(/parenthesis/);
    expect(() => evaluateExpr("1 +", {})).toThrow(KernelInputError);
    expect(() => evaluateExpr("x".repeat(400), {})).toThrow(/at most/);
    expect(() => evaluateExpr("(".repeat(40) + "1" + ")".repeat(40), {})).toThrow(/nested/);
    expect(() => calcExpr({ expr: "a", inputs: { a: Number.NaN } })).toThrow(KernelInputError);
    expect(() => calcExpr({ expr: "a", inputs: { "a-b": 1 } as never })).toThrow(KernelInputError);
    // A model-supplied JSON key "__proto__" stays a plain input and never touches prototypes.
    const polluted = JSON.parse('{"__proto__": 3}') as Record<string, number>;
    expect(calcExpr({ expr: "__proto__ * 2", inputs: polluted }).data.result).toBe(6);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("gives distinct receipt ids for different expressions in one turn", () => {
    const a = calcExpr({ expr: "x * 2", inputs: { x: 1 } }).receipts[0]!.id;
    const b = calcExpr({ expr: "x * 3", inputs: { x: 1 } }).receipts[0]!.id;
    expect(a).not.toBe(b);
  });
});
