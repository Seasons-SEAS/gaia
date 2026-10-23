/**
 * Documented protocol parameters the kernel computes with. They are the
 * current settings per GitBook and the live mint, not permanent rules; callers
 * pass the live fee (from get_token_trust_facts) when they have it.
 */

/** Token-2022 transfer fee on the $SEAS mint: 1000 bps = 10% (GitBook TTT; mint newerTransferFee). */
export const DEFAULT_FEE_BPS = 1000;
/** Token-2022 caps basis points at 10,000 (100%). */
export const MAX_FEE_BPS = 10_000;
/** maximumFee on the mint: 1e16 base units = 100,000,000 $SEAS per transfer. */
export const DEFAULT_MAX_FEE_SEAS = 100_000_000;
export const SEAS_DECIMALS = 8;
/** Fixed supply minted at genesis (a negligible 0.2 $SEAS has since been burned). */
export const TOTAL_SUPPLY_SEAS = 1_000_000_000;

/** Director Node: balance ≥ 10,000 $SEAS (GitBook Nodes L1416; node-ledger ≥10,000). */
export const DIRECTOR_MIN_SEAS = 10_000;
/** Builder Node: 1,000 to 9,999.99999999 $SEAS (GitBook Nodes L1416). */
export const BUILDER_MIN_SEAS = 1_000;

/** Director rounds per year at the Sunday + Wednesday cadence (mechanics F18). */
export const DISTRIBUTIONS_PER_YEAR = 104;

/** Largest amount the kernel accepts; far above supply, it only guards float/bigint conversion. */
export const MAX_INPUT_SEAS = 1e15;

export const CAVEAT_TIER_ESTIMATE = "balance-based estimate; other eligibility rules apply";
