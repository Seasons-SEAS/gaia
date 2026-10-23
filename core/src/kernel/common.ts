/** Shared kernel plumbing: envelope defaults, receipt ids, pool-fee and price validation, traps. */
import { KernelInputError, requirePositive } from "./errors";
import { makeEnvelope, makeReceipt, shortHash, stableJson, type ReceiptInit } from "./numbers";

import type { Receipt, ToolEnvelope } from "../types";

export const KERNEL_SOURCE = "kernel";
/** Pure results stay valid for their inputs; nothing to cache or expire. */
export const KERNEL_TTL_SECONDS = 0;

/**
 * Receipt id `r:<tool>:<field>@<input-hash>`. The suffix keeps ids unique when
 * the brain runs the same calculator twice in one turn with different inputs.
 */
export function kernelReceiptId(tool: string, field: string, inputs: unknown): string {
  return `r:${tool}:${field}@${shortHash(stableJson(inputs))}`;
}

export function calcReceipt(
  tool: string,
  inputs: unknown,
  r: Omit<ReceiptInit, "id" | "kind"> & { field: string },
): Receipt {
  const { field, ...rest } = r;
  return makeReceipt({ ...rest, id: kernelReceiptId(tool, field, inputs), kind: "calc" });
}

export function kernelEnvelope<T>(
  data: T,
  formula: string,
  receipts: Receipt[],
  unavailable: string[] = [],
): ToolEnvelope<T> {
  return makeEnvelope({
    data,
    source: KERNEL_SOURCE,
    locator: `kernel:${formula}`,
    ttlSeconds: KERNEL_TTL_SECONDS,
    unavailable,
    receipts,
  });
}

/** Pool (LP) fee as a fraction; `poolFeePct` is a percentage like 0.25. */
export function poolFeeFraction(poolFeePct: unknown): number {
  if (poolFeePct === undefined) return 0;
  if (
    typeof poolFeePct !== "number" ||
    !Number.isFinite(poolFeePct) ||
    poolFeePct < 0 ||
    poolFeePct >= 100
  ) {
    throw new KernelInputError("poolFeePct", "poolFeePct must be a percentage from 0 to below 100");
  }
  return poolFeePct / 100;
}

export function optionalPrice(priceUsd: unknown): number | undefined {
  if (priceUsd === undefined) return undefined;
  return requirePositive("priceUsd", priceUsd);
}

export type TrapId = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8" | "T9" | "T10";

/** A documented computation trap triggered by the user's numbers. */
export interface TrapHit {
  id: TrapId;
  title: string;
  /** English sentence in the user's own numbers; the brain localises it. */
  detail: string;
  numbers: number[];
}

export const TRAP_TITLES: Record<TrapId, string> = {
  T1: "Moving tokens between your own wallets costs the transfer fee",
  T2: "Buying exactly the threshold is not enough",
  T3: "Splitting one wallet by transfer does not give equal nodes",
  T4: "LP deposits and withdrawals are taxed",
  T5: "Reinvesting yield pays the fee again",
  T6: "Dropping below the threshold and buying back pays twice",
  T7: "Builder rewards must be claimed",
  T8: "Quoted rates are on spot value, not on what you paid",
  T9: "Targets are not forecasts",
  T10: "Selling keeps yield only while you stay above the threshold",
};

export function trap(id: TrapId, detail: string, numbers: number[]): TrapHit {
  return { id, title: TRAP_TITLES[id], detail, numbers };
}

export function trapReceipts(
  tool: string,
  inputs: unknown,
  traps: TrapHit[],
  locator: string,
): Receipt[] {
  return traps.map((t) =>
    calcReceipt(tool, inputs, {
      field: `trap_${t.id}`,
      label: `${t.id}: ${t.title}`,
      locator: `${locator}; trap ${t.id}`,
      value: t.detail,
      numbers: t.numbers,
    }),
  );
}
