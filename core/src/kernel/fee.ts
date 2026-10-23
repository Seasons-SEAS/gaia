/**
 * Token-2022 transfer-fee arithmetic in base units (8 decimals), mirroring
 * spl-token-2022 `TransferFee::calculate_fee` / `calculate_inverse_fee`, so
 * results match what the chain withholds to the last unit.
 */
import {
  DEFAULT_FEE_BPS,
  DEFAULT_MAX_FEE_SEAS,
  MAX_FEE_BPS,
  MAX_INPUT_SEAS,
  SEAS_DECIMALS,
} from "./constants";
import { KernelInputError, requireNonNegative } from "./errors";

const SCALE = 10n ** BigInt(SEAS_DECIMALS);
const BPS_DENOM = BigInt(MAX_FEE_BPS);

/** $SEAS (JS number) → base units, rounded to the nearest unit via decimal string (no float drift). */
export function seasToBase(x: number, field = "amount"): bigint {
  requireNonNegative(field, x);
  if (x > MAX_INPUT_SEAS)
    throw new KernelInputError(field, `${field} is larger than the kernel accepts`);
  const [int, frac = ""] = x.toFixed(SEAS_DECIMALS).split(".");
  return BigInt(int) * SCALE + BigInt(frac.padEnd(SEAS_DECIMALS, "0"));
}

export function baseToSeas(b: bigint): number {
  const neg = b < 0n;
  const a = neg ? -b : b;
  const v = Number(a / SCALE) + Number(a % SCALE) / Number(SCALE);
  return neg ? -v : v;
}

/** Decimal string of a base-unit amount ("11111.11111112"). */
export function baseToString(b: bigint, decimals = SEAS_DECIMALS): string {
  const scale = 10n ** BigInt(decimals);
  const neg = b < 0n;
  const a = neg ? -b : b;
  const frac = (a % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / scale}${frac ? "." + frac : ""}`;
}

export function validateFeeBps(feeBps: unknown = DEFAULT_FEE_BPS): number {
  if (
    typeof feeBps !== "number" ||
    !Number.isInteger(feeBps) ||
    feeBps < 0 ||
    feeBps > MAX_FEE_BPS
  ) {
    throw new KernelInputError("feeBps", "feeBps must be an integer from 0 to 10000");
  }
  return feeBps;
}

export function maxFeeBase(maximumFeeSeas: number = DEFAULT_MAX_FEE_SEAS): bigint {
  return seasToBase(maximumFeeSeas, "maximumFeeSeas");
}

/** Fee withheld on a transfer of `amount` base units: ceil(amount·bps/10,000), capped at maximumFee. */
export function transferFeeBase(amount: bigint, feeBps: number, maxFee: bigint): bigint {
  if (feeBps === 0 || amount === 0n) return 0n;
  const raw = (amount * BigInt(feeBps) + BPS_DENOM - 1n) / BPS_DENOM;
  return raw < maxFee ? raw : maxFee;
}

/** Smallest gross transfer that delivers at least `net` base units (Token-2022 inverse fee). */
export function grossUpBase(net: bigint, feeBps: number, maxFee: bigint): bigint {
  if (feeBps === 0 || net === 0n) return net;
  if (feeBps === MAX_FEE_BPS) return net + maxFee;
  const denom = BPS_DENOM - BigInt(feeBps);
  const raw = (net * BPS_DENOM + denom - 1n) / denom;
  if (raw - net >= maxFee) return net + maxFee;
  // Walk down if a smaller gross still nets the target (ceil can overshoot by a unit).
  let g = raw;
  while (g > net && g - 1n - transferFeeBase(g - 1n, feeBps, maxFee) >= net) g -= 1n;
  while (g - transferFeeBase(g, feeBps, maxFee) < net) g += 1n;
  return g;
}

export interface TransferSplit {
  gross: bigint;
  fee: bigint;
  net: bigint;
}

export function splitTransfer(gross: bigint, feeBps: number, maxFee: bigint): TransferSplit {
  const fee = transferFeeBase(gross, feeBps, maxFee);
  return { gross, fee, net: gross - fee };
}
