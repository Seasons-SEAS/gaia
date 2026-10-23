/** Node tier by balance (Director ≥ 10,000; Builder 1,000 to below 10,000 $SEAS). */
import { calcReceipt, kernelEnvelope } from "./common";
import { BUILDER_MIN_SEAS, CAVEAT_TIER_ESTIMATE, DIRECTOR_MIN_SEAS } from "./constants";
import { baseToSeas, seasToBase } from "./fee";
import { fmtSeas, numberForms, requirementForms } from "./numbers";

import type { ToolEnvelope } from "../types";

export type Tier = "director" | "builder" | "none";

export interface TierInfo {
  tier: Tier;
  nextTier?: Exclude<Tier, "none">;
  /** $SEAS the wallet must NET (after fees) to reach nextTier. */
  toNext?: number;
}

export const TIER_RANK: Record<Tier, number> = { none: 0, builder: 1, director: 2 };
export const TIER_LABEL: Record<Tier, string> = {
  none: "no node tier",
  builder: "Builder",
  director: "Director",
};

/** Sentence form: "a Director", "a Builder", "below the node thresholds". */
export function tierPhrase(t: Tier): string {
  return t === "none" ? "below the node thresholds" : `a ${TIER_LABEL[t]}`;
}

export function tierThreshold(t: Exclude<Tier, "none">): number {
  return t === "director" ? DIRECTOR_MIN_SEAS : BUILDER_MIN_SEAS;
}

/** Pure classification (no envelope), used by every other kernel function. */
export function classifyTier(seas: number): TierInfo {
  const b = seasToBase(seas, "balance");
  const dir = seasToBase(DIRECTOR_MIN_SEAS);
  const bld = seasToBase(BUILDER_MIN_SEAS);
  if (b >= dir) return { tier: "director" };
  if (b >= bld) return { tier: "builder", nextTier: "director", toNext: baseToSeas(dir - b) };
  return { tier: "none", nextTier: "builder", toNext: baseToSeas(bld - b) };
}

export interface TierForBalanceData extends TierInfo {
  balance: number;
  thresholds: { director: number; builder: number };
  caveat: string;
}

export function tierForBalance(seas: number): ToolEnvelope<TierForBalanceData> {
  const info = classifyTier(seas);
  const inputs = { seas };
  const data: TierForBalanceData = {
    ...info,
    balance: seas,
    thresholds: { director: DIRECTOR_MIN_SEAS, builder: BUILDER_MIN_SEAS },
    caveat: CAVEAT_TIER_ESTIMATE,
  };
  const receipts = [
    calcReceipt("tier", inputs, {
      field: "tier",
      label: "Node tier for a balance",
      locator:
        "Node thresholds: Director ≥ 10,000 $SEAS, Builder 1,000–9,999 $SEAS (GitBook Nodes)",
      value: `${fmtSeas(seas, 8)} → ${TIER_LABEL[info.tier]} (${CAVEAT_TIER_ESTIMATE})`,
      numbers: [...numberForms(seas), DIRECTOR_MIN_SEAS, BUILDER_MIN_SEAS],
    }),
  ];
  if (info.nextTier && info.toNext !== undefined) {
    receipts.push(
      calcReceipt("tier", inputs, {
        field: "to_next",
        label: `Distance to ${TIER_LABEL[info.nextTier]}`,
        locator: "Node thresholds minus balance (net $SEAS the wallet must hold)",
        value: `${fmtSeas(info.toNext, 8)} more (net) to reach ${TIER_LABEL[info.nextTier]}`,
        numbers: [
          ...requirementForms(info.toNext),
          ...numberForms(seas),
          tierThreshold(info.nextTier),
        ],
      }),
    );
  }
  return kernelEnvelope(data, "node thresholds", receipts);
}
