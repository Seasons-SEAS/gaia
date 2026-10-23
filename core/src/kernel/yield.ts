/**
 * Earn-back (F12) and compounding (F13) at the USER's rate. The kernel never
 * picks a rate: a missing or non-positive rate is an input error.
 */
import { calcReceipt, kernelEnvelope, poolFeeFraction } from "./common";
import { DEFAULT_FEE_BPS, DISTRIBUTIONS_PER_YEAR } from "./constants";
import { KernelInputError, requireFinite, requireNonNegative } from "./errors";
import { validateFeeBps } from "./fee";
import { fmtNum, fmtPct, numberForms, pctForms } from "./numbers";

import type { ToolEnvelope } from "../types";

function userRate(ratePct: unknown): number {
  if (ratePct === undefined || ratePct === null) {
    throw new KernelInputError("ratePct", "ratePct is required and must be the user's own rate");
  }
  const r = requireFinite("ratePct", ratePct);
  if (r <= 0) throw new KernelInputError("ratePct", "ratePct must be greater than 0");
  return r;
}

// --- F12: time to earn back ---------------------------------------------------------

export interface EarnBackInput {
  /** Annual rate in percent, as the user stated it (e.g. 12). */
  ratePct: number;
  basis: "entry_fee" | "round_trip";
  feeBps?: number;
  poolFeePct?: number;
}

export interface EarnBackPath {
  /** Price move right after entry that then holds: 0, −30, −60. */
  priceChangePct: number;
  years: number;
  months: number;
}

export interface EarnBackData {
  ratePct: number;
  basis: EarnBackInput["basis"];
  feeBps: number;
  poolFeePct: number;
  /** Flat-price result (the F12 headline). */
  years: number;
  months: number;
  paths: EarnBackPath[];
  assumptions: string[];
}

export const EARN_BACK_PRICE_PATHS = [0, -30, -60] as const;

/**
 * Years until yield at rate r on the held value recovers the gap between what
 * was paid and what the position is worth (entry) or would return if sold
 * (round trip). With h = (1 − t)(1 − f), g = h (entry) or h² (round trip) and a
 * one-off price factor m: years = (1 − g·m) / (h·m·r). At m = 1 this is F12.
 */
export function earnBackYears(
  r: number,
  t: number,
  f: number,
  basis: EarnBackInput["basis"],
  m = 1,
): number {
  const h = (1 - t) * (1 - f);
  const g = basis === "entry_fee" ? h : h * h;
  return (1 - g * m) / (h * m * r);
}

export function calcTimeToEarnBack(input: EarnBackInput): ToolEnvelope<EarnBackData> {
  const ratePct = userRate(input.ratePct);
  if (input.basis !== "entry_fee" && input.basis !== "round_trip") {
    throw new KernelInputError("basis", "basis must be entry_fee or round_trip");
  }
  const feeBps = validateFeeBps(input.feeBps ?? DEFAULT_FEE_BPS);
  if (feeBps === 10_000)
    throw new KernelInputError("feeBps", "a 100% fee can never be earned back");
  const t = feeBps / 10_000;
  const f = poolFeeFraction(input.poolFeePct);
  const r = ratePct / 100;
  const inputs = { ...input, feeBps };

  const paths: EarnBackPath[] = EARN_BACK_PRICE_PATHS.map((pc) => {
    const years = earnBackYears(r, t, f, input.basis, 1 + pc / 100);
    return { priceChangePct: pc, years, months: years * 12 };
  });
  const flat = paths[0]!;
  const data: EarnBackData = {
    ratePct,
    basis: input.basis,
    feeBps,
    poolFeePct: f * 100,
    years: flat.years,
    months: flat.months,
    paths,
    assumptions: [
      "The rate is the user's own figure or a dated reported rate, applied to the spot value of the tokens held; it is not a Seasons forecast.",
      "The price moves once right after entry and then stays; no reinvestment; payout assets keep their value.",
      "Excludes network fees and price impact. Arithmetic on assumptions, not a projection.",
    ],
  };

  const common = [ratePct, r, feeBps, t * 100, f > 0 ? f * 100 : undefined];
  const formula =
    input.basis === "entry_fee"
      ? "F12 earn-back (entry fee): t / ((1 − t)·r)"
      : "F12 earn-back (round trip): (1 − k) / ((1 − t)(1 − f)·r)";
  const receipts = paths.map((pth) =>
    calcReceipt("earnback", inputs, {
      field: pth.priceChangePct === 0 ? "years_flat" : `years_minus${Math.abs(pth.priceChangePct)}`,
      label:
        pth.priceChangePct === 0
          ? `Years to earn back the ${input.basis === "entry_fee" ? "entry fee" : "round-trip cost"} at ${fmtNum(ratePct, 2)}%`
          : `Same, if the price is ${Math.abs(pth.priceChangePct)}% lower`,
      locator:
        pth.priceChangePct === 0
          ? formula
          : `${formula}, generalised with price factor ${1 + pth.priceChangePct / 100}`,
      value: `${fmtNum(pth.years, 2)} years (≈${fmtNum(pth.months, 0)} months)`,
      numbers: [
        ...numberForms(pth.years, pth.months),
        ...(pth.priceChangePct ? [pth.priceChangePct, Math.abs(pth.priceChangePct)] : []),
        ...common,
      ],
    }),
  );
  return kernelEnvelope(data, "F12 time to earn back", receipts);
}

// --- F13: taxed compounding ------------------------------------------------------------

export interface TaxedCompoundingInput {
  ratePct: number;
  years: number;
  feeBps?: number;
  poolFeePct?: number;
  /** Reinvestments per year; default 104 (every Sunday and Wednesday round). */
  periodsPerYear?: number;
}

export interface TaxedCompoundingData {
  ratePct: number;
  years: number;
  periodsPerYear: number;
  feeBps: number;
  poolFeePct: number;
  /** (1 − t)(1 − f): the share of each payout that becomes new $SEAS weight. */
  reinvestKeep: number;
  /** Value multiplier when every payout is swapped back into $SEAS (taxed). */
  multiplierTaxed: number;
  /** Same without any fee, for comparison only (not achievable with $SEAS). */
  multiplierUntaxed: number;
  /** Payouts kept aside, not reinvested: 1 + r·years. */
  multiplierNoReinvest: number;
  effectiveAnnualTaxedPct: number;
  effectiveAnnualUntaxedPct: number;
  notes: string[];
}

export function calcTaxedCompounding(
  input: TaxedCompoundingInput,
): ToolEnvelope<TaxedCompoundingData> {
  const ratePct = userRate(input.ratePct);
  const years = requireNonNegative("years", input.years);
  const n =
    input.periodsPerYear === undefined
      ? DISTRIBUTIONS_PER_YEAR
      : requireFinite("periodsPerYear", input.periodsPerYear);
  if (!Number.isInteger(n) || n < 1)
    throw new KernelInputError("periodsPerYear", "periodsPerYear must be a whole number ≥ 1");
  const feeBps = validateFeeBps(input.feeBps ?? DEFAULT_FEE_BPS);
  const t = feeBps / 10_000;
  const f = poolFeeFraction(input.poolFeePct);
  const r = ratePct / 100;
  const h = (1 - t) * (1 - f);
  const inputs = { ...input, feeBps, periodsPerYear: n };

  const data: TaxedCompoundingData = {
    ratePct,
    years,
    periodsPerYear: n,
    feeBps,
    poolFeePct: f * 100,
    reinvestKeep: h,
    multiplierTaxed: (1 + (h * r) / n) ** (n * years),
    multiplierUntaxed: (1 + r / n) ** (n * years),
    multiplierNoReinvest: 1 + r * years,
    effectiveAnnualTaxedPct: ((1 + (h * r) / n) ** n - 1) * 100,
    effectiveAnnualUntaxedPct: ((1 + r / n) ** n - 1) * 100,
    notes: [
      `Each reinvestment pays the ${fmtPct(t, 2)} transfer fee${f > 0 ? " and the pool fee" : ""}, so compounding runs at ≤${fmtNum(h, 4)}× the rate (trap T5).`,
      "Constant $SEAS price and constant rate assumed. Reinvesting also raises the network's node balance, so if everyone compounds it is zero-sum on weight.",
    ],
  };
  const common = [ratePct, r, years, n, feeBps, t * 100, f > 0 ? f * 100 : undefined];
  const receipts = [
    calcReceipt("compound_taxed", inputs, {
      field: "reinvest_keep",
      label: "Share of each reinvested payout that becomes $SEAS",
      locator: "F13 taxed compounding: r_eff ≤ (1 − t)(1 − f)·r",
      value: `${fmtNum(h, 4)}× (effective rate ≤ ${fmtNum(h * ratePct, 2)}% instead of ${fmtNum(ratePct, 2)}%)`,
      numbers: [...numberForms(h, h * ratePct), ...pctForms(h), ...common],
    }),
    calcReceipt("compound_taxed", inputs, {
      field: "multipliers",
      label: `Growth over ${fmtNum(years, 2)} years: taxed reinvesting vs untaxed vs not reinvesting`,
      locator: `F13 taxed compounding: (1 + h·r/n)^(n·years), n = ${n}`,
      value: `taxed ${fmtNum(data.multiplierTaxed, 4)}×, untaxed ${fmtNum(data.multiplierUntaxed, 4)}×, not reinvested ${fmtNum(data.multiplierNoReinvest, 4)}×`,
      numbers: [
        ...numberForms(data.multiplierTaxed, data.multiplierUntaxed, data.multiplierNoReinvest),
        ...pctForms(
          data.multiplierTaxed - 1,
          data.multiplierUntaxed - 1,
          data.multiplierNoReinvest - 1,
        ),
        ...common,
      ],
    }),
    calcReceipt("compound_taxed", inputs, {
      field: "effective_annual",
      label: "Effective annual rate with reinvesting",
      locator: "F13 taxed compounding: (1 + h·r/n)^n − 1",
      value: `taxed ${fmtNum(data.effectiveAnnualTaxedPct, 2)}%, untaxed ${fmtNum(data.effectiveAnnualUntaxedPct, 2)}%`,
      numbers: [
        ...numberForms(data.effectiveAnnualTaxedPct, data.effectiveAnnualUntaxedPct),
        ...common,
      ],
    }),
  ];
  return kernelEnvelope(data, "F13 taxed compounding", receipts);
}

// --- general compounding -------------------------------------------------------------------

export interface CompoundInput {
  ratePct: number;
  years: number;
  periodsPerYear?: number;
  principal?: number;
}

export interface CompoundData {
  ratePct: number;
  years: number;
  periodsPerYear: number;
  multiplier: number;
  gainPct: number;
  effectiveAnnualPct: number;
  principal?: number;
  finalValue?: number;
}

/** Plain compound interest, (1 + r/n)^(n·years). No fee: use calcTaxedCompounding for $SEAS reinvesting. */
export function calcCompound(input: CompoundInput): ToolEnvelope<CompoundData> {
  const ratePct = requireFinite("ratePct", input.ratePct);
  if (ratePct <= -100) throw new KernelInputError("ratePct", "ratePct must be above −100");
  const years = requireNonNegative("years", input.years);
  const n =
    input.periodsPerYear === undefined ? 1 : requireFinite("periodsPerYear", input.periodsPerYear);
  if (!Number.isInteger(n) || n < 1)
    throw new KernelInputError("periodsPerYear", "periodsPerYear must be a whole number ≥ 1");
  const principal =
    input.principal === undefined ? undefined : requireNonNegative("principal", input.principal);
  const r = ratePct / 100;
  const multiplier = (1 + r / n) ** (n * years);
  const data: CompoundData = {
    ratePct,
    years,
    periodsPerYear: n,
    multiplier,
    gainPct: (multiplier - 1) * 100,
    effectiveAnnualPct: ((1 + r / n) ** n - 1) * 100,
  };
  if (principal !== undefined) {
    data.principal = principal;
    data.finalValue = principal * multiplier;
  }
  const inputs = { ...input, periodsPerYear: n };
  const receipts = [
    calcReceipt("compound", inputs, {
      field: "result",
      label: `Compound growth at ${fmtNum(ratePct, 2)}% for ${fmtNum(years, 2)} years`,
      locator: `compound interest: (1 + r/n)^(n·years), n = ${n}`,
      value: `${fmtNum(multiplier, 4)}× (+${fmtNum(data.gainPct, 2)}%)${data.finalValue !== undefined ? `, ${fmtNum(principal!, 2)} → ${fmtNum(data.finalValue, 2)}` : ""}`,
      numbers: [
        ...numberForms(
          multiplier,
          data.gainPct,
          data.effectiveAnnualPct,
          principal,
          data.finalValue,
        ),
        ratePct,
        r,
        years,
        n,
      ],
    }),
  ];
  return kernelEnvelope(data, "compound interest", receipts);
}
