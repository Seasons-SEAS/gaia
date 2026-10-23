/**
 * get_wallet_tier: $SEAS balance of a pasted address and a balance-based tier
 * estimate. No payouts and no eligibility claims: blacklist, EOA and snapshot
 * rules are applied off-chain by the team.
 */
import { CAVEAT_TIER_ESTIMATE, DEFAULT_FEE_BPS, DEFAULT_MAX_FEE_SEAS } from "../kernel/constants";
import { baseToSeas, baseToString, grossUpBase, maxFeeBase, seasToBase } from "../kernel/fee";
import {
  fmtNum,
  makeEnvelope,
  makeReceipt,
  numberForms,
  requirementForms,
} from "../kernel/numbers";
import { classifyTier, TIER_LABEL, type TierInfo } from "../kernel/tier";

import { classifyAuthority, isValidAddress, type AuthorityType } from "./base58";
import { SEAS_MINT, solscanAccount } from "./constants";
import { ChainError } from "./http";
import { createRpcClient } from "./rpc";

import type { ChainConfig, ToolEnvelope } from "../types";

export const WALLET_TTL_SECONDS = 30;

export interface WalletTierData {
  address: string;
  balance: number;
  balanceExact: string;
  tokenAccounts: number;
  /** single_key_wallet = on-curve (a normal wallet); pda = program-owned (pools, vaults), not counted as a node. */
  addressType: Exclude<AuthorityType, "none">;
  estimate: TierInfo;
  /** Gross amount to receive by transfer or buy so the wallet nets the next tier (10% fee). */
  grossToNext?: number;
  caveat: string;
}

interface TokenAccountsResponse {
  context?: { slot?: number };
  value: Array<{
    pubkey: string;
    account: {
      owner?: string;
      data: {
        parsed?: {
          info?: {
            mint?: string;
            owner?: string;
            tokenAmount?: { amount: string; decimals: number };
          };
        };
      };
    };
  }>;
}

/** Pure: token accounts → summed balance in base units. */
export function sumSeasBalance(r: TokenAccountsResponse): { base: bigint; accounts: number } {
  if (!r || !Array.isArray(r.value))
    throw new ChainError("invalid_response", "getTokenAccountsByOwner returned no list");
  let base = 0n;
  let accounts = 0;
  for (const a of r.value) {
    const info = a.account?.data?.parsed?.info;
    if (info?.mint !== SEAS_MINT || !info.tokenAmount || !/^\d+$/.test(info.tokenAmount.amount))
      continue;
    base += BigInt(info.tokenAmount.amount);
    accounts++;
  }
  return { base, accounts };
}

export async function getWalletTier(
  cfg: ChainConfig,
  address: string,
): Promise<ToolEnvelope<WalletTierData>> {
  const addr = typeof address === "string" ? address.trim() : "";
  if (!isValidAddress(addr)) throw new ChainError("invalid_address", "not a valid Solana address");
  const rpc = createRpcClient(cfg);
  const res = await rpc.call<TokenAccountsResponse>(
    "getTokenAccountsByOwner",
    [addr, { mint: SEAS_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }],
    { ttlSeconds: WALLET_TTL_SECONDS },
  );
  const { base, accounts } = sumSeasBalance(res.result);
  const balance = baseToSeas(base);
  const estimate = classifyTier(balance);
  const addressType = classifyAuthority(addr) as Exclude<AuthorityType, "none">;
  const data: WalletTierData = {
    address: addr,
    balance,
    balanceExact: baseToString(base),
    tokenAccounts: accounts,
    addressType,
    estimate,
    caveat: `${CAVEAT_TIER_ESTIMATE}${addressType === "pda" ? "; program-owned addresses (pools, vaults) are not counted as nodes" : ""}`,
  };
  if (estimate.toNext !== undefined) {
    data.grossToNext = baseToSeas(
      grossUpBase(seasToBase(estimate.toNext), DEFAULT_FEE_BPS, maxFeeBase(DEFAULT_MAX_FEE_SEAS)),
    );
  }
  const slot = res.result.context?.slot;
  const url = solscanAccount(addr);
  const receipts = [
    makeReceipt({
      id: "r:wallet:balance",
      kind: "chain",
      label: "$SEAS balance of the pasted wallet",
      locator: `getTokenAccountsByOwner ${addr} {mint: ${SEAS_MINT}} (jsonParsed)`,
      value: `${fmtNum(balance, 8)} $SEAS across ${accounts} token account${accounts === 1 ? "" : "s"}`,
      numbers: [...numberForms(balance), accounts],
      read_at: res.at,
      slot,
      url,
    }),
    makeReceipt({
      id: "r:wallet:tier_estimate",
      kind: "calc",
      label: "Tier estimate from the balance",
      locator: "node thresholds: Director ≥ 10,000, Builder 1,000–9,999 $SEAS",
      value: `${TIER_LABEL[estimate.tier]} (${data.caveat})`,
      numbers: [...numberForms(balance), 10_000, 1_000],
      read_at: res.at,
    }),
  ];
  if (estimate.nextTier && estimate.toNext !== undefined && data.grossToNext !== undefined) {
    receipts.push(
      makeReceipt({
        id: "r:wallet:to_next",
        kind: "calc",
        label: `Distance to ${TIER_LABEL[estimate.nextTier]}`,
        locator: "threshold − balance; F4 gross-up at 1000 bps",
        value: `${fmtNum(estimate.toNext, 8)} $SEAS more (net); about ${fmtNum(Math.ceil(data.grossToNext * 100) / 100, 2)} $SEAS gross after the 10% fee`,
        numbers: [...requirementForms(estimate.toNext, data.grossToNext), 10_000, 1_000],
        read_at: res.at,
      }),
    );
  }
  return makeEnvelope({
    data,
    source: "solana-rpc",
    locator: `getTokenAccountsByOwner ${addr} (Token-2022, mint ${SEAS_MINT})`,
    asOf: res.at,
    slot,
    ttlSeconds: WALLET_TTL_SECONDS,
    receipts,
  });
}
