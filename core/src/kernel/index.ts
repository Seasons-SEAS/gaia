/**
 * GAIA Kernel: deterministic, network-free protocol maths. Every public
 * function returns a ToolEnvelope whose `calc` receipts list the inputs and
 * outputs (with rounded forms) the answer may quote.
 */
export {
  tierForBalance,
  classifyTier,
  TIER_LABEL,
  type Tier,
  type TierInfo,
  type TierForBalanceData,
} from "./tier";
export {
  calcTaxLens,
  calcGrossUp,
  calcRoundTrip,
  type TaxLensInput,
  type TaxLensData,
  type GrossUpInput,
  type GrossUpData,
  type RoundTripInput,
  type RoundTripData,
  type WaterfallStep,
} from "./tax";
export {
  calcTimeToEarnBack,
  calcTaxedCompounding,
  calcCompound,
  earnBackYears,
  EARN_BACK_PRICE_PATHS,
  type EarnBackInput,
  type EarnBackData,
  type EarnBackPath,
  type TaxedCompoundingInput,
  type TaxedCompoundingData,
  type CompoundInput,
  type CompoundData,
} from "./yield";
export {
  preflightTransfer,
  preflightSplit,
  preflightSellBelowThreshold,
  type PreflightTransferInput,
  type PreflightTransferData,
  type PreflightSplitInput,
  type PreflightSplitData,
  type SplitWallet,
  type PreflightSellInput,
  type PreflightSellData,
} from "./preflight";
export {
  calcExpr,
  evaluateExpr,
  type CalcExprInput,
  type CalcExprData,
  type ExprInput,
} from "./expr";
export { KernelInputError } from "./errors";
export { TRAP_TITLES, type TrapHit, type TrapId } from "./common";
export { transferFeeBase, grossUpBase, seasToBase, baseToSeas, baseToString } from "./fee";
export * as KERNEL_CONSTANTS from "./constants";
