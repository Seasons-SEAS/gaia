/**
 * "Check before you move": consequences of a user-described action in the
 * user's own numbers (tier before/after, what arrives, fee paid, which trap).
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
import { DEFAULT_FEE_BPS, DEFAULT_MAX_FEE_SEAS, DIRECTOR_MIN_SEAS } from "./constants";
import { KernelInputError, requireNonNegative, requirePositive } from "./errors";
import {
  baseToSeas,
  grossUpBase,
  maxFeeBase,
  seasToBase,
  splitTransfer,
  transferFeeBase,
  validateFeeBps,
} from "./fee";
import {
  fmtNum,
  fmtPct,
  fmtSeas,
  fmtSeasAtLeast,
  fmtUsd,
  numberForms,
  requirementForms,
} from "./numbers";
import {
  classifyTier,
  TIER_LABEL,
  TIER_RANK,
  tierPhrase,
  tierThreshold,
  type Tier,
  type TierInfo,
} from "./tier";

import type { ToolEnvelope } from "../types";

function bestTier(...tiers: Tier[]): Tier {
  return tiers.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a), "none" as Tier);
}

// --- transfer (T1) -------------------------------------------------------------------

export interface PreflightTransferInput {
  balance: number;
  amount: number;
  feeBps?: number;
  /** $SEAS already in the receiving wallet; default 0 (a new wallet, e.g. a Ledger). */
  recipientBalance?: number;
  priceUsd?: number;
  maximumFeeSeas?: number;
}

export interface PreflightTransferData {
  balance: number;
  amount: number;
  feeBps: number;
  feeSeas: number;
  feeUsd?: number;
  recipientReceives: number;
  senderBefore: TierInfo & { balance: number };
  senderAfter: TierInfo & { balance: number };
  recipientBefore: TierInfo & { balance: number };
  recipientAfter: TierInfo & { balance: number };
  /** Best tier across both wallets before and after (an own-wallet move). */
  positionTierBefore: Tier;
  positionTierAfter: Tier;
  /** The sending wallet falls to a lower tier at the next cutoff. */
  senderDropsTier: boolean;
  insufficientBalance: boolean;
  /** When a trap fires: gross to send so the recipient reaches the tier the amount suggests. */
  grossToKeepTier?: number;
  traps: TrapHit[];
}

export function preflightTransfer(
  input: PreflightTransferInput,
): ToolEnvelope<PreflightTransferData> {
  const balance = requireNonNegative("balance", input.balance);
  const amount = requirePositive("amount", input.amount);
  const recipientBalance = requireNonNegative("recipientBalance", input.recipientBalance ?? 0);
  const feeBps = validateFeeBps(input.feeBps ?? DEFAULT_FEE_BPS);
  const p = optionalPrice(input.priceUsd);
  const maxFee = maxFeeBase(input.maximumFeeSeas ?? DEFAULT_MAX_FEE_SEAS);
  const inputs = { ...input, feeBps };

  const balB = seasToBase(balance, "balance");
  const amtB = seasToBase(amount, "amount");
  const recB = seasToBase(recipientBalance, "recipientBalance");
  const split = splitTransfer(amtB, feeBps, maxFee);
  const senderAfterB = balB > amtB ? balB - amtB : 0n;
  const recAfterB = recB + split.net;

  const at = (b: bigint) => ({ ...classifyTier(baseToSeas(b)), balance: baseToSeas(b) });
  const data: PreflightTransferData = {
    balance,
    amount,
    feeBps,
    feeSeas: baseToSeas(split.fee),
    recipientReceives: baseToSeas(split.net),
    senderBefore: at(balB),
    senderAfter: at(senderAfterB),
    recipientBefore: at(recB),
    recipientAfter: at(recAfterB),
    positionTierBefore: "none",
    positionTierAfter: "none",
    senderDropsTier: false,
    insufficientBalance: amtB > balB,
    traps: [],
  };
  if (p !== undefined) data.feeUsd = data.feeSeas * p;
  data.positionTierBefore = bestTier(data.senderBefore.tier, data.recipientBefore.tier);
  data.positionTierAfter = bestTier(data.senderAfter.tier, data.recipientAfter.tier);
  data.senderDropsTier = TIER_RANK[data.senderAfter.tier] < TIER_RANK[data.senderBefore.tier];

  // The amount "looks like" a tier (10,000 → Director) but what arrives may not be.
  const nominal = classifyTier(recipientBalance + amount).tier;
  if (nominal !== "none" && TIER_RANK[data.recipientAfter.tier] < TIER_RANK[nominal]) {
    const threshold = tierThreshold(nominal);
    const needNet = seasToBase(threshold) - recB;
    const gross = baseToSeas(grossUpBase(needNet > 0n ? needNet : 0n, feeBps, maxFee));
    data.grossToKeepTier = gross;
    const canAfford = seasToBase(gross) <= balB;
    data.traps.push(
      trap(
        "T1",
        `Sending ${fmtSeas(amount)} delivers ${fmtSeas(data.recipientReceives)} (the ${fmtPct(feeBps / 10_000, 2)} fee applies to moves between your own wallets too), so the receiving wallet ends at ${fmtSeas(data.recipientAfter.balance)}: ${tierPhrase(data.recipientAfter.tier)}, not ${tierPhrase(nominal)}. To make it ${tierPhrase(nominal)}, send at least ${fmtSeasAtLeast(gross)}${canAfford ? "" : ` (more than the ${fmtSeas(balance)} you hold)`}. Keep some SOL for network fees.`,
        [
          amount,
          data.recipientReceives,
          data.recipientAfter.balance,
          threshold,
          ...requirementForms(gross),
          balance,
        ],
      ),
    );
  }

  const common = [balance, amount, feeBps, feeBps / 100, recipientBalance || undefined, p];
  const receipts = [
    calcReceipt("preflight_transfer", inputs, {
      field: "recipient_receives",
      label: "What the receiving wallet gets",
      locator: "F3 transfer: delivered = amount − ceil(amount × bps / 10,000)",
      value: `${fmtSeas(data.recipientReceives, 8)} arrives; fee ${fmtSeas(data.feeSeas, 8)}${data.feeUsd !== undefined ? ` (≈${fmtUsd(data.feeUsd)})` : ""}`,
      numbers: [...numberForms(data.recipientReceives, data.feeSeas, data.feeUsd), ...common],
    }),
    calcReceipt("preflight_transfer", inputs, {
      field: "tiers",
      label: "Tiers before and after the transfer",
      locator: "F3 transfer + node thresholds (10,000 / 1,000)",
      value: `sender ${TIER_LABEL[data.senderBefore.tier]} → ${TIER_LABEL[data.senderAfter.tier]} (${fmtSeas(data.senderAfter.balance, 8)}); recipient ${TIER_LABEL[data.recipientBefore.tier]} → ${TIER_LABEL[data.recipientAfter.tier]} (${fmtSeas(data.recipientAfter.balance, 8)})`,
      numbers: [
        ...numberForms(data.senderAfter.balance, data.recipientAfter.balance),
        10_000,
        1_000,
        ...common,
      ],
    }),
    ...trapReceipts("preflight_transfer", inputs, data.traps, "F3 transfer"),
  ];
  return kernelEnvelope(data, "F3 transfer preflight", receipts);
}

// --- split (T3) ------------------------------------------------------------------------

export interface PreflightSplitInput {
  balance: number;
  /**
   * A number n: split equally across n wallets, the source keeping one share
   * and sending the rest by transfer. An array: amounts sent to new wallets;
   * the source keeps the remainder.
   */
  parts: number | number[];
  feeBps?: number;
  maximumFeeSeas?: number;
}

export interface SplitWallet {
  label: string;
  sent?: number;
  fee?: number;
  balance: number;
  tier: Tier;
}

export interface PreflightSplitData {
  balance: number;
  feeBps: number;
  wallets: SplitWallet[];
  totalFeeSeas: number;
  directors: number;
  builders: number;
  insufficientBalance: boolean;
  /** Minimum single-wallet balance that yields this many Directors by transfer. */
  minBalanceForAllDirectors: number;
  traps: TrapHit[];
}

export function preflightSplit(input: PreflightSplitInput): ToolEnvelope<PreflightSplitData> {
  const balance = requireNonNegative("balance", input.balance);
  const feeBps = validateFeeBps(input.feeBps ?? DEFAULT_FEE_BPS);
  const maxFee = maxFeeBase(input.maximumFeeSeas ?? DEFAULT_MAX_FEE_SEAS);
  const inputs = { ...input, feeBps };
  const balB = seasToBase(balance, "balance");

  let sends: bigint[];
  if (typeof input.parts === "number") {
    const n = input.parts;
    if (!Number.isInteger(n) || n < 2 || n > 100)
      throw new KernelInputError("parts", "parts must be a whole number of wallets from 2 to 100");
    const share = balB / BigInt(n);
    sends = Array.from({ length: n - 1 }, () => share);
  } else if (Array.isArray(input.parts)) {
    if (input.parts.length < 1 || input.parts.length > 100)
      throw new KernelInputError("parts", "parts must list 1 to 100 amounts");
    sends = input.parts.map((a, i) => seasToBase(requirePositive(`parts[${i}]`, a), `parts[${i}]`));
  } else {
    throw new KernelInputError("parts", "parts must be a number of wallets or a list of amounts");
  }

  const totalSent = sends.reduce((a, b) => a + b, 0n);
  const keep = balB > totalSent ? balB - totalSent : 0n;
  const wallets: SplitWallet[] = [
    {
      label: "source wallet (keeps)",
      balance: baseToSeas(keep),
      tier: classifyTier(baseToSeas(keep)).tier,
    },
  ];
  let totalFee = 0n;
  sends.forEach((s, i) => {
    const sp = splitTransfer(s, feeBps, maxFee);
    totalFee += sp.fee;
    wallets.push({
      label: `new wallet ${i + 1}`,
      sent: baseToSeas(s),
      fee: baseToSeas(sp.fee),
      balance: baseToSeas(sp.net),
      tier: classifyTier(baseToSeas(sp.net)).tier,
    });
  });
  const walletsCount = wallets.length;
  const minAllDirectors = baseToSeas(
    seasToBase(DIRECTOR_MIN_SEAS) +
      BigInt(walletsCount - 1) * grossUpBase(seasToBase(DIRECTOR_MIN_SEAS), feeBps, maxFee),
  );
  const data: PreflightSplitData = {
    balance,
    feeBps,
    wallets,
    totalFeeSeas: baseToSeas(totalFee),
    directors: wallets.filter((w) => w.tier === "director").length,
    builders: wallets.filter((w) => w.tier === "builder").length,
    insufficientBalance: totalSent > balB,
    minBalanceForAllDirectors: minAllDirectors,
    traps: [],
  };

  // Trap: a sent part that "looks like" a tier arrives below it.
  const shortfalls = wallets.filter(
    (w) => w.sent !== undefined && TIER_RANK[classifyTier(w.sent).tier] > TIER_RANK[w.tier],
  );
  if (shortfalls.length > 0) {
    const tiersText = wallets
      .map((w) => `${fmtSeas(w.balance)} (${TIER_LABEL[w.tier]})`)
      .join(" + ");
    data.traps.push(
      trap(
        "T3",
        `Splitting ${fmtSeas(balance)} by transfer gives ${tiersText}: each transfer pays the ${fmtPct(feeBps / 10_000, 2)} fee. ${walletsCount} Directors from one wallet need at least ${fmtSeasAtLeast(minAllDirectors)}; wallets funded by separate buys avoid the extra transfer fee.`,
        [
          balance,
          ...wallets.map((w) => w.balance),
          ...requirementForms(minAllDirectors),
          walletsCount,
          data.totalFeeSeas,
        ],
      ),
    );
  }

  const common = [balance, feeBps, feeBps / 100, walletsCount];
  const receipts = [
    calcReceipt("preflight_split", inputs, {
      field: "wallets",
      label: "Balances and tiers after the split",
      locator: "F3 transfer per part + node thresholds (10,000 / 1,000)",
      value: wallets
        .map((w) => `${w.label}: ${fmtSeas(w.balance, 8)} (${TIER_LABEL[w.tier]})`)
        .join("; "),
      numbers: [
        ...wallets.flatMap((w) => numberForms(w.balance, w.sent, w.fee)),
        ...numberForms(data.totalFeeSeas),
        data.directors,
        data.builders,
        ...common,
      ],
    }),
    calcReceipt("preflight_split", inputs, {
      field: "min_balance_all_directors",
      label: `Minimum balance for ${walletsCount} Directors from one wallet`,
      locator: "T3: 10,000 + (n − 1) × gross-up(10,000)",
      value: fmtSeas(minAllDirectors, 8),
      numbers: [...requirementForms(minAllDirectors), 10_000, ...common],
    }),
    ...trapReceipts("preflight_split", inputs, data.traps, "F3 transfer (split)"),
  ];
  return kernelEnvelope(data, "T3 split preflight", receipts);
}

// --- sell below threshold (T6, T10) -----------------------------------------------------

export interface PreflightSellInput {
  balance: number;
  amount: number;
  priceUsd?: number;
  feeBps?: number;
  poolFeePct?: number;
  maximumFeeSeas?: number;
}

export interface PreflightSellData {
  balance: number;
  amount: number;
  feeBps: number;
  balanceAfter: number;
  tierBefore: TierInfo;
  tierAfter: TierInfo;
  feeSeas: number;
  feeUsd?: number;
  proceedsUsd?: number;
  /** Largest sale that keeps the current tier (0 when none). */
  maxSellKeepingTier: number;
  /** When the tier drops: gross buy to get back to the old threshold, and its fee. */
  buyBackGross?: number;
  buyBackFee?: number;
  insufficientBalance: boolean;
  traps: TrapHit[];
}

export function preflightSellBelowThreshold(
  input: PreflightSellInput,
): ToolEnvelope<PreflightSellData> {
  const balance = requireNonNegative("balance", input.balance);
  const amount = requirePositive("amount", input.amount);
  const feeBps = validateFeeBps(input.feeBps ?? DEFAULT_FEE_BPS);
  const f = poolFeeFraction(input.poolFeePct);
  const p = optionalPrice(input.priceUsd);
  const maxFee = maxFeeBase(input.maximumFeeSeas ?? DEFAULT_MAX_FEE_SEAS);
  const inputs = { ...input, feeBps };

  const balB = seasToBase(balance, "balance");
  const amtB = seasToBase(amount, "amount");
  const afterB = balB > amtB ? balB - amtB : 0n;
  const fee = transferFeeBase(amtB, feeBps, maxFee);
  const tierBefore = classifyTier(balance);
  const tierAfter = classifyTier(baseToSeas(afterB));
  const keepThreshold =
    tierBefore.tier === "none" ? 0n : seasToBase(tierThreshold(tierBefore.tier));
  const data: PreflightSellData = {
    balance,
    amount,
    feeBps,
    balanceAfter: baseToSeas(afterB),
    tierBefore,
    tierAfter,
    feeSeas: baseToSeas(fee),
    maxSellKeepingTier: tierBefore.tier === "none" ? 0 : baseToSeas(balB - keepThreshold),
    insufficientBalance: amtB > balB,
    traps: [],
  };
  if (p !== undefined) {
    data.feeUsd = data.feeSeas * p;
    data.proceedsUsd = baseToSeas(amtB - fee) * p * (1 - f);
  }

  if (TIER_RANK[tierAfter.tier] < TIER_RANK[tierBefore.tier] && tierBefore.tier !== "none") {
    const threshold = tierThreshold(tierBefore.tier);
    const back = grossUpBase(keepThreshold - afterB, feeBps, maxFee);
    data.buyBackGross = baseToSeas(back);
    data.buyBackFee = baseToSeas(back - (keepThreshold - afterB));
    data.traps.push(
      trap(
        "T6",
        `Selling ${fmtSeas(amount)} leaves ${fmtSeas(data.balanceAfter)}: below the ${fmtSeas(threshold)} ${TIER_LABEL[tierBefore.tier]} threshold, so the wallet is ${tierPhrase(tierAfter.tier)} from the next cutoff. The sale pays ${fmtSeas(data.feeSeas)} in fees; getting back to ${fmtSeas(threshold)} means buying at least ${fmtSeasAtLeast(data.buyBackGross)}, which pays about ${fmtSeas(data.buyBackFee)} again.`,
        [
          amount,
          data.balanceAfter,
          threshold,
          data.feeSeas,
          ...requirementForms(data.buyBackGross),
          data.buyBackFee,
        ],
      ),
    );
  }
  if (tierBefore.tier !== "none") {
    data.traps.push(
      trap(
        "T10",
        `You keep ${TIER_LABEL[tierBefore.tier]} yield only while the balance stays at or above ${fmtSeas(tierThreshold(tierBefore.tier))} at each cutoff: from ${fmtSeas(balance)} you can sell at most ${fmtSeas(data.maxSellKeepingTier)}, and every sale pays the ${fmtPct(feeBps / 10_000, 2)} fee.`,
        [balance, tierThreshold(tierBefore.tier), ...numberForms(data.maxSellKeepingTier)],
      ),
    );
  }

  const common = [balance, amount, feeBps, feeBps / 100, p, f > 0 ? f * 100 : undefined];
  const receipts = [
    calcReceipt("preflight_sell", inputs, {
      field: "tiers",
      label: "Tier before and after the sale",
      locator: "F2 sell + node thresholds (10,000 / 1,000)",
      value: `${TIER_LABEL[tierBefore.tier]} → ${TIER_LABEL[tierAfter.tier]} (${fmtSeas(data.balanceAfter, 8)} left)`,
      numbers: [
        ...numberForms(data.balanceAfter, data.maxSellKeepingTier),
        10_000,
        1_000,
        ...common,
      ],
    }),
    calcReceipt("preflight_sell", inputs, {
      field: "fee",
      label: "Fee paid on the sale",
      locator: "F2 sell: ceil(amount × bps / 10,000)",
      value: `${fmtSeas(data.feeSeas, 8)}${data.feeUsd !== undefined ? ` (≈${fmtUsd(data.feeUsd)})` : ""}${data.proceedsUsd !== undefined ? `; proceeds ≈${fmtUsd(data.proceedsUsd)}` : ""}`,
      numbers: [...numberForms(data.feeSeas, data.feeUsd, data.proceedsUsd), ...common],
    }),
    ...trapReceipts("preflight_sell", inputs, data.traps, "F2 sell"),
  ];
  if (data.buyBackGross !== undefined) {
    receipts.push(
      calcReceipt("preflight_sell", inputs, {
        field: "buy_back",
        label: "Gross buy to return to the old threshold",
        locator: "F4 gross-up of (threshold − balance after)",
        value: `${fmtNum(data.buyBackGross, 8)} $SEAS (fee ${fmtNum(data.buyBackFee!, 8)})`,
        numbers: [
          ...requirementForms(data.buyBackGross),
          ...numberForms(data.buyBackFee),
          ...common,
        ],
      }),
    );
  }
  return kernelEnvelope(data, "T6/T10 sell preflight", receipts);
}
