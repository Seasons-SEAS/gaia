/**
 * Fee maths for one leg (F1–F3), the gross-up (F4) and the round trip (F5).
 * t = transfer fee (bps/10,000), f = pool fee, p = $SEAS price in USD.
 */
import {
  calcReceipt,
  kernelEnvelope,
  optionalPrice,
  poolFeeFraction,
  trap,
  trapReceipts,
  type TrapHit,
} from "./common";
import { DEFAULT_FEE_BPS, DEFAULT_MAX_FEE_SEAS, TOTAL_SUPPLY_SEAS } from "./constants";
import { KernelInputError, requireFinite, requireNonNegative } from "./errors";
import {
  baseToSeas,
  baseToString,
  grossUpBase,
  maxFeeBase,
  seasToBase,
  splitTransfer,
  validateFeeBps,
} from "./fee";
import {
  fmtNum,
  fmtPct,
  fmtSeas,
  fmtSeasAtLeast,
  fmtUsd,
  numberForms,
  pctForms,
  requirementForms,
} from "./numbers";
import {
  classifyTier,
  TIER_LABEL,
  TIER_RANK,
  tierPhrase,
  tierThreshold,
  type TierInfo,
} from "./tier";

import type { ToolEnvelope } from "../types";

// --- F1–F3: tax lens ---------------------------------------------------------------

export interface TaxLensInput {
  amount: number;
  unit: "SEAS" | "USD";
  side: "buy" | "sell" | "transfer";
  /** Required to convert between USD and $SEAS; pass the live price receipt's value. */
  priceUsd?: number;
  feeBps?: number;
  /** Pool (LP) fee in percent, e.g. 0.25. Buy and sell legs only. */
  poolFeePct?: number;
  /** On-chain maximumFee per transfer; defaults to the mint's 100,000,000 $SEAS. */
  maximumFeeSeas?: number;
}

export interface TaxLensData {
  side: TaxLensInput["side"];
  unit: TaxLensInput["unit"];
  amount: number;
  feeBps: number;
  feePct: number;
  poolFeePct: number;
  priceUsd?: number;
  /** $SEAS moved before the transfer fee (pool output on a buy, amount sent on a sell/transfer). */
  grossSeas?: number;
  /** $SEAS that arrive: in the buyer's or recipient's wallet, or in the pool on a sell. */
  netSeas?: number;
  transferFeeSeas?: number;
  transferFeeUsd?: number;
  poolFeeUsd?: number;
  /** Buy: USD paid. */
  costUsd?: number;
  /** Buy/transfer: USD value of what arrives at spot. Sell: USD received. */
  netUsd?: number;
  /** Share of the starting value lost on this leg. */
  effectiveCostPct: number;
  /** Buy/transfer: tier of the receiving wallet if it held nothing before. */
  resultingTier?: TierInfo;
  exceedsTotalSupply: boolean;
  traps: TrapHit[];
  assumptions: string[];
}

export function calcTaxLens(input: TaxLensInput): ToolEnvelope<TaxLensData> {
  const { side, unit } = input;
  if (side !== "buy" && side !== "sell" && side !== "transfer")
    throw new KernelInputError("side", "side must be buy, sell or transfer");
  if (unit !== "SEAS" && unit !== "USD")
    throw new KernelInputError("unit", "unit must be SEAS or USD");
  const amount = requireNonNegative("amount", input.amount);
  const feeBps = validateFeeBps(input.feeBps ?? DEFAULT_FEE_BPS);
  const t = feeBps / 10_000;
  const f = side === "transfer" ? 0 : poolFeeFraction(input.poolFeePct);
  const p = optionalPrice(input.priceUsd);
  const maxFee = maxFeeBase(input.maximumFeeSeas ?? DEFAULT_MAX_FEE_SEAS);
  const inputs = { ...input, feeBps };
  const unavailable: string[] = [];
  const assumptions: string[] = [
    "Fee = ceil(amount × bps / 10,000) in $SEAS base units, as Token-2022 withholds it.",
  ];
  if (side !== "transfer") assumptions.push("Ignores price impact and network fees.");

  const data: TaxLensData = {
    side,
    unit,
    amount,
    feeBps,
    feePct: t * 100,
    poolFeePct: f * 100,
    effectiveCostPct: 0,
    exceedsTotalSupply: false,
    traps: [],
    assumptions,
  };
  if (p !== undefined) data.priceUsd = p;

  // Tokens that leave the pool (buy) or the sender (sell/transfer) before the fee.
  let grossSeas: number | undefined;
  let nominalSeas: number | undefined; // what a naive reading of the amount implies
  if (side === "buy") {
    if (unit === "SEAS") {
      grossSeas = amount;
      nominalSeas = amount;
      if (p !== undefined) data.costUsd = (amount * p) / (1 - f);
    } else {
      data.costUsd = amount;
      data.poolFeeUsd = amount * f;
      if (p !== undefined) {
        grossSeas = (amount * (1 - f)) / p;
        nominalSeas = amount / p;
      }
    }
  } else {
    if (unit === "SEAS") grossSeas = amount;
    else if (p !== undefined) grossSeas = amount / p;
    nominalSeas = grossSeas;
  }

  if (grossSeas === undefined) {
    // USD amount without a price: fractions are still exact, token counts are not.
    unavailable.push("price_usd", "gross_seas", "net_seas", "transfer_fee_seas");
    if (side !== "sell") unavailable.push("resulting_tier");
    const keep = (1 - f) * (1 - t);
    data.netUsd = amount * keep;
    data.transferFeeUsd = amount * (1 - f) * t;
    data.poolFeeUsd = amount * f;
    data.effectiveCostPct = Number(((1 - keep) * 100).toPrecision(12));
  } else {
    const split = splitTransfer(seasToBase(grossSeas, "amount"), feeBps, maxFee);
    const gross = baseToSeas(split.gross);
    const net = baseToSeas(split.net);
    const fee = baseToSeas(split.fee);
    data.grossSeas = gross;
    data.netSeas = net;
    data.transferFeeSeas = fee;
    data.exceedsTotalSupply = gross > TOTAL_SUPPLY_SEAS;
    const legKeep = gross > 0 ? net / gross : 1 - t;
    if (p !== undefined) {
      data.transferFeeUsd = fee * p;
      if (side === "sell") {
        data.poolFeeUsd = net * p * f;
        data.netUsd = net * p * (1 - f);
      } else {
        data.netUsd = net * p;
      }
    }
    // 12 significant digits: drops float noise (9.999999999999998 → 10).
    data.effectiveCostPct = Number(
      ((1 - (side === "transfer" ? legKeep : legKeep * (1 - f))) * 100).toPrecision(12),
    );
    if (side !== "sell") {
      data.resultingTier = classifyTier(net);
      assumptions.push("Resulting tier assumes the receiving wallet held no $SEAS before.");
      const nominalTier = nominalSeas !== undefined ? classifyTier(nominalSeas).tier : "none";
      if (nominalTier !== "none" && TIER_RANK[nominalTier] > TIER_RANK[data.resultingTier.tier]) {
        const threshold = tierThreshold(nominalTier);
        const need = baseToSeas(grossUpBase(seasToBase(threshold), feeBps, maxFee));
        const needWorth = need / (1 - f);
        if (side === "buy") {
          data.traps.push(
            trap(
              "T2",
              `Buying ${fmtSeas(nominalSeas!)} worth leaves ${fmtSeas(net)} after the ${fmtPct(t, 2)} fee${f > 0 ? ` and the ${fmtPct(f, 2)} pool fee` : ""}: ${tierPhrase(data.resultingTier.tier)}, not ${tierPhrase(nominalTier)}. To net ${fmtSeas(threshold)}, buy at least ${fmtSeasAtLeast(needWorth)} worth, plus a margin for price impact.`,
              [nominalSeas!, net, threshold, ...requirementForms(need, needWorth)],
            ),
          );
        } else {
          data.traps.push(
            trap(
              "T1",
              `Sending ${fmtSeas(gross)} delivers ${fmtSeas(net)}: the receiving wallet is ${tierPhrase(data.resultingTier.tier)}, not ${tierPhrase(nominalTier)}. To deliver ${fmtSeas(threshold)}, send at least ${fmtSeasAtLeast(need)}.`,
              [gross, net, threshold, ...requirementForms(need)],
            ),
          );
        }
      }
    }
  }

  const common = [amount, feeBps, t * 100, t, p, f > 0 ? f * 100 : undefined];
  const locator = side === "buy" ? "F1 buy" : side === "sell" ? "F2 sell" : "F3 transfer";
  const receipts = [];
  if (data.netSeas !== undefined) {
    receipts.push(
      calcReceipt("tax", inputs, {
        field: "net_received",
        label:
          side === "sell"
            ? "$SEAS reaching the pool after the transfer fee"
            : "$SEAS received after the transfer fee",
        locator: `${locator}: net = gross − ceil(gross × ${feeBps}/10,000)`,
        value: `${fmtSeas(data.netSeas, 8)} of ${fmtSeas(data.grossSeas!, 8)}`,
        numbers: [...numberForms(data.netSeas, data.grossSeas), ...common],
      }),
    );
  }
  receipts.push(
    calcReceipt("tax", inputs, {
      field: "fee_paid",
      label: "Transfer fee paid on this leg",
      locator: `${locator}: ${feeBps} bps Token-2022 transfer fee`,
      value: [
        data.transferFeeSeas !== undefined ? fmtSeas(data.transferFeeSeas, 8) : undefined,
        data.transferFeeUsd !== undefined ? `≈${fmtUsd(data.transferFeeUsd)}` : undefined,
        `(${fmtPct(t, 2)})`,
      ]
        .filter(Boolean)
        .join(" "),
      numbers: [...numberForms(data.transferFeeSeas, data.transferFeeUsd), ...common],
    }),
  );
  if (f > 0 && data.poolFeeUsd !== undefined) {
    receipts.push(
      calcReceipt("tax", inputs, {
        field: "pool_fee",
        label: "Pool (LP) fee on this leg",
        locator: `${locator}: pool fee ${fmtNum(f * 100, 4)}%`,
        value: fmtUsd(data.poolFeeUsd),
        numbers: [...numberForms(data.poolFeeUsd), ...common],
      }),
    );
  }
  if (data.netUsd !== undefined || data.costUsd !== undefined) {
    receipts.push(
      calcReceipt("tax", inputs, {
        field: "usd",
        label: side === "sell" ? "USD received" : "USD paid and value received",
        locator: `${locator} at the given price${p !== undefined ? ` $${p}` : ""}`,
        value: [
          data.costUsd !== undefined ? `paid ${fmtUsd(data.costUsd)}` : undefined,
          data.netUsd !== undefined
            ? `${side === "sell" ? "received" : "worth"} ≈${fmtUsd(data.netUsd)}`
            : undefined,
        ]
          .filter(Boolean)
          .join(", "),
        numbers: [...numberForms(data.costUsd, data.netUsd), ...common],
      }),
    );
  }
  receipts.push(
    calcReceipt("tax", inputs, {
      field: "effective_cost",
      label: "Share of value lost on this leg",
      locator: `${locator}: 1 − (1 − t)(1 − f)`,
      value: fmtPct(data.effectiveCostPct / 100, 2),
      numbers: [...pctForms(data.effectiveCostPct / 100), ...common],
    }),
  );
  if (data.resultingTier) {
    receipts.push(
      calcReceipt("tax", inputs, {
        field: "resulting_tier",
        label: "Tier of the receiving wallet (if it held nothing before)",
        locator: `${locator} + node thresholds (10,000 / 1,000)`,
        value: `${fmtSeas(data.netSeas!, 8)} → ${TIER_LABEL[data.resultingTier.tier]}`,
        numbers: [...numberForms(data.netSeas, data.resultingTier.toNext), 10_000, 1_000],
      }),
    );
  }
  receipts.push(...trapReceipts("tax", inputs, data.traps, locator));
  return kernelEnvelope(data, locator, receipts, unavailable);
}

// --- F4: gross-up --------------------------------------------------------------------

export interface GrossUpInput {
  targetNet: number;
  feeBps?: number;
  /** Adds the pool fee on a buy (percent, e.g. 0.25). */
  poolFeePct?: number;
  priceUsd?: number;
  maximumFeeSeas?: number;
}

export interface GrossUpData {
  targetNet: number;
  feeBps: number;
  /** Exact minimum gross transfer, to the base unit. */
  grossSeas: number;
  grossSeasExact: string;
  /** Rounded UP to cents of a token, the figure to quote (11,111.12). */
  grossSeasDisplay: number;
  feeSeas: number;
  /** With a pool fee: $SEAS worth of payment to spend at spot. */
  buyWorthSeas?: number;
  costUsd?: number;
  note: string;
}

export function calcGrossUp(input: GrossUpInput): ToolEnvelope<GrossUpData> {
  const targetNet = requireNonNegative("targetNet", input.targetNet);
  const feeBps = validateFeeBps(input.feeBps ?? DEFAULT_FEE_BPS);
  const f = poolFeeFraction(input.poolFeePct);
  const p = optionalPrice(input.priceUsd);
  const maxFee = maxFeeBase(input.maximumFeeSeas ?? DEFAULT_MAX_FEE_SEAS);
  const inputs = { ...input, feeBps };

  const netBase = seasToBase(targetNet, "targetNet");
  const grossBase = grossUpBase(netBase, feeBps, maxFee);
  const gross = baseToSeas(grossBase);
  // Ceil to hundredths on the integer, so the quoted figure never falls short.
  const display = Number((grossBase + 999_999n) / 1_000_000n) / 100;
  const data: GrossUpData = {
    targetNet,
    feeBps,
    grossSeas: gross,
    grossSeasExact: baseToString(grossBase),
    grossSeasDisplay: display,
    feeSeas: baseToSeas(grossBase - netBase),
    note: "Minimum gross so the receiving wallet nets the target after the transfer fee. Add a margin for price impact on a buy.",
  };
  if (f > 0) data.buyWorthSeas = gross / (1 - f);
  if (p !== undefined) data.costUsd = (data.buyWorthSeas ?? gross) * p;

  const common = [targetNet, feeBps, feeBps / 100, feeBps / 10_000, p, f > 0 ? f * 100 : undefined];
  const receipts = [
    calcReceipt("grossup", inputs, {
      field: "gross",
      label: `Gross amount to net ${fmtSeas(targetNet)}`,
      locator: "F4 gross-up: G = ceil(N × 10,000 / (10,000 − bps)), Token-2022 inverse fee",
      value: `${fmtNum(display, 2)} $SEAS (exact minimum ${data.grossSeasExact})`,
      numbers: [...requirementForms(gross, display), ...common],
    }),
    calcReceipt("grossup", inputs, {
      field: "fee",
      label: "Transfer fee paid on the gross-up",
      locator: "F4 gross-up: fee = G − N",
      value: fmtSeas(data.feeSeas, 8),
      numbers: [...numberForms(data.feeSeas), ...common],
    }),
  ];
  if (data.buyWorthSeas !== undefined) {
    receipts.push(
      calcReceipt("grossup", inputs, {
        field: "buy_worth",
        label: "Buy size including the pool fee",
        locator: "F4 gross-up with pool fee: G / (1 − f)",
        value: `at least ${fmtSeasAtLeast(data.buyWorthSeas)} worth`,
        numbers: [...requirementForms(data.buyWorthSeas), ...common],
      }),
    );
  }
  if (data.costUsd !== undefined) {
    receipts.push(
      calcReceipt("grossup", inputs, {
        field: "cost_usd",
        label: "USD cost at the given price",
        locator: `F4 gross-up × price $${p}`,
        value: fmtUsd(data.costUsd),
        numbers: [...requirementForms(data.costUsd), ...common],
      }),
    );
  }
  return kernelEnvelope(data, "F4 gross-up", receipts);
}

// --- F5: round trip ---------------------------------------------------------------------

export interface RoundTripInput {
  priceChangePct?: number;
  feeBps?: number;
  poolFeePct?: number;
  /** Illustration base for the waterfall (default $100). */
  amountUsd?: number;
}

export interface WaterfallStep {
  step: string;
  valueUsd: number;
}

export interface RoundTripData {
  feeBps: number;
  poolFeePct: number;
  /** Share of value kept after buy + sell at an unchanged price: (1 − t)²(1 − f)². */
  keepFraction: number;
  lossPct: number;
  /** Price rise needed to get back to the starting value: 1/k − 1. */
  breakEvenPct: number;
  priceChangePct: number;
  amountUsd: number;
  finalValueUsd: number;
  netResultPct: number;
  waterfall: WaterfallStep[];
}

export function calcRoundTrip(input: RoundTripInput = {}): ToolEnvelope<RoundTripData> {
  const feeBps = validateFeeBps(input.feeBps ?? DEFAULT_FEE_BPS);
  const t = feeBps / 10_000;
  const f = poolFeeFraction(input.poolFeePct);
  const x = requireFinite("priceChangePct", input.priceChangePct ?? 0);
  if (x < -100) throw new KernelInputError("priceChangePct", "priceChangePct cannot be below −100");
  const amountUsd =
    input.amountUsd === undefined ? 100 : requireNonNegative("amountUsd", input.amountUsd);
  if (t === 1) throw new KernelInputError("feeBps", "a 100% fee leaves nothing to sell");
  const inputs = { ...input, feeBps };

  const k = (1 - t) ** 2 * (1 - f) ** 2;
  const steps: WaterfallStep[] = [{ step: "start", valueUsd: amountUsd }];
  let v = amountUsd;
  const push = (step: string, next: number) => {
    v = next;
    steps.push({ step, valueUsd: v });
  };
  if (f > 0) push(`pool fee on the buy (${fmtNum(f * 100, 4)}%)`, v * (1 - f));
  push(`transfer fee on the buy (${fmtNum(t * 100, 2)}%)`, v * (1 - t));
  if (x !== 0) push(`price change (${x > 0 ? "+" : ""}${fmtNum(x, 2)}%)`, v * (1 + x / 100));
  push(`transfer fee on the sell (${fmtNum(t * 100, 2)}%)`, v * (1 - t));
  if (f > 0) push(`pool fee on the sell (${fmtNum(f * 100, 4)}%)`, v * (1 - f));

  const data: RoundTripData = {
    feeBps,
    poolFeePct: f * 100,
    keepFraction: k,
    lossPct: (1 - k) * 100,
    breakEvenPct: (1 / k - 1) * 100,
    priceChangePct: x,
    amountUsd,
    finalValueUsd: v,
    netResultPct: amountUsd > 0 ? (v / amountUsd - 1) * 100 : k * (1 + x / 100) * 100 - 100,
    waterfall: steps,
  };
  const common = [
    feeBps,
    t * 100,
    t,
    f > 0 ? f * 100 : undefined,
    x !== 0 ? x : undefined,
    amountUsd,
  ];
  const receipts = [
    calcReceipt("roundtrip", inputs, {
      field: "loss",
      label: "Round-trip cost at an unchanged price",
      locator: "F5 round trip: loss = 1 − (1 − t)²(1 − f)²",
      value: `${fmtPct(1 - k, 2)} lost; ${fmtPct(k, 2)} kept`,
      numbers: [...pctForms(1 - k, k), ...common],
    }),
    calcReceipt("roundtrip", inputs, {
      field: "break_even",
      label: "Price rise needed to break even on a round trip",
      locator: "F5 round trip: break-even = 1 / ((1 − t)²(1 − f)²) − 1",
      value: `+${fmtPct(1 / k - 1, 2)}`,
      numbers: [...pctForms(1 / k - 1), ...common],
    }),
    calcReceipt("roundtrip", inputs, {
      field: "waterfall",
      label: `Round-trip waterfall on ${fmtUsd(amountUsd)}`,
      locator: "F5 round trip waterfall",
      value: steps.map((s) => `${s.step}: ${fmtUsd(s.valueUsd)}`).join(" → "),
      numbers: [
        ...steps.flatMap((s) => numberForms(s.valueUsd)),
        ...pctForms(data.netResultPct / 100),
        ...common,
      ],
    }),
  ];
  return kernelEnvelope(data, "F5 round trip", receipts);
}

/** Helper for other modules: keep fraction of one taxed leg, (1 − t)(1 − f). */
export function legKeep(feeBps: number, poolFee: number): number {
  return (1 - feeBps / 10_000) * (1 - poolFee);
}
