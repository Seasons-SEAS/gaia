/**
 * get_builder_week: aggregate state of the builder_claims program: current
 * week and root (config PDA), that week's builder count and cumulative
 * entitlement (WeekRecord PDA), and the claims vault balance. Aggregates only;
 * no per-wallet data.
 */
import { fmtNum, makeEnvelope, makeReceipt, numberForms } from "../kernel/numbers";

import { base58Encode, classifyAuthority, findProgramAddress, type AuthorityType } from "./base58";
import {
  BUILDER_CLAIMS_PROGRAM,
  BUILDER_CONFIG_PDA,
  BUILDER_VAULT,
  SEAS_MINT,
  solscanAccount,
} from "./constants";
import { ChainError } from "./http";
import { createRpcClient } from "./rpc";

import type { ChainConfig, Receipt, ToolEnvelope } from "../types";

export const BUILDER_TTL_SECONDS = 600;

/** Anchor discriminators: sha256("account:Config")[0..8], sha256("account:WeekRecord")[0..8]. */
const CONFIG_DISC = "9b0caae01efacc82";
const WEEK_DISC = "ec7d1f2d3dcd8fab";

export interface BuilderConfig {
  authority: string;
  mint: string;
  vault: string;
  currentWeek: number;
  currentRoot: string;
}

export interface WeekRecord {
  week: number;
  root: string;
  builderCount: number;
  /** Cumulative entitlement of all Builders up to this week, in $SEAS. */
  totalCumulative: number;
  publishedSlot: number;
}

export interface BuilderWeekData {
  program: string;
  config: BuilderConfig;
  rootAuthorityType: AuthorityType;
  week: WeekRecord | null;
  weekRecordAddress: string;
  vault: { address: string; balance: number; withheld: number } | null;
}

function b64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Layout from programs/builder_claims (lib.rs): disc ‖ authority ‖ mint ‖ vault ‖ week u32 ‖ root[32] ‖ bump. */
export function decodeConfig(bytes: Uint8Array): BuilderConfig {
  if (bytes.length < 141 || hex(bytes.slice(0, 8)) !== CONFIG_DISC)
    throw new ChainError("invalid_response", "not a builder_claims Config account");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    authority: base58Encode(bytes.slice(8, 40)),
    mint: base58Encode(bytes.slice(40, 72)),
    vault: base58Encode(bytes.slice(72, 104)),
    currentWeek: dv.getUint32(104, true),
    currentRoot: hex(bytes.slice(108, 140)),
  };
}

/** disc ‖ week u32 ‖ root[32] ‖ builder_count u32 ‖ total_cumulative u64 ‖ published_slot u64 ‖ bump (checked against week 8). */
export function decodeWeekRecord(bytes: Uint8Array): WeekRecord {
  if (bytes.length < 64 || hex(bytes.slice(0, 8)) !== WEEK_DISC)
    throw new ChainError("invalid_response", "not a builder_claims WeekRecord account");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cumulative = dv.getBigUint64(48, true);
  return {
    week: dv.getUint32(8, true),
    root: hex(bytes.slice(12, 44)),
    builderCount: dv.getUint32(44, true),
    totalCumulative: Number(cumulative / 100_000_000n) + Number(cumulative % 100_000_000n) / 1e8,
    publishedSlot: Number(dv.getBigUint64(56, true)),
  };
}

interface AccountB64 {
  context?: { slot?: number };
  value: null | { owner: string; data: [string, string] };
}

interface VaultParsed {
  context?: { slot?: number };
  value: null | {
    data: {
      parsed?: {
        info?: {
          mint?: string;
          tokenAmount?: { amount: string };
          extensions?: Array<{ extension: string; state?: { withheldAmount?: number } }>;
        };
      };
    };
  };
}

export async function weekRecordAddress(week: number): Promise<string> {
  const le = new Uint8Array(4);
  new DataView(le.buffer).setUint32(0, week, true);
  return (await findProgramAddress([new TextEncoder().encode("week"), le], BUILDER_CLAIMS_PROGRAM))
    .address;
}

export async function getBuilderWeek(cfg: ChainConfig): Promise<ToolEnvelope<BuilderWeekData>> {
  const rpc = createRpcClient(cfg);
  const unavailable: string[] = [];
  const cfgRes = await rpc.call<AccountB64>(
    "getAccountInfo",
    [BUILDER_CONFIG_PDA, { encoding: "base64", commitment: "confirmed" }],
    {
      ttlSeconds: BUILDER_TTL_SECONDS,
    },
  );
  const acct = cfgRes.result.value;
  if (!acct || acct.owner !== BUILDER_CLAIMS_PROGRAM)
    throw new ChainError("not_found", "builder_claims config account not found");
  const config = decodeConfig(b64(acct.data[0]));
  const weekAddr = await weekRecordAddress(config.currentWeek);

  let week: WeekRecord | null = null;
  let weekAt = cfgRes.at;
  try {
    const w = await rpc.call<AccountB64>(
      "getAccountInfo",
      [weekAddr, { encoding: "base64", commitment: "confirmed" }],
      { ttlSeconds: BUILDER_TTL_SECONDS },
    );
    if (w.result.value && w.result.value.owner === BUILDER_CLAIMS_PROGRAM) {
      week = decodeWeekRecord(b64(w.result.value.data[0]));
      weekAt = w.at;
    } else unavailable.push("week_record");
  } catch {
    unavailable.push("week_record");
  }

  let vault: BuilderWeekData["vault"] = null;
  let vaultAt = cfgRes.at;
  const vaultAddr = config.vault || BUILDER_VAULT;
  try {
    const v = await rpc.call<VaultParsed>(
      "getAccountInfo",
      [vaultAddr, { encoding: "jsonParsed", commitment: "confirmed" }],
      { ttlSeconds: BUILDER_TTL_SECONDS },
    );
    const info = v.result.value?.data?.parsed?.info;
    if (info?.mint === SEAS_MINT && info.tokenAmount && /^\d+$/.test(info.tokenAmount.amount)) {
      const withheld =
        info.extensions?.find((e) => e.extension === "transferFeeAmount")?.state?.withheldAmount ??
        0;
      const amt = BigInt(info.tokenAmount.amount);
      vault = {
        address: vaultAddr,
        balance: Number(amt / 100_000_000n) + Number(amt % 100_000_000n) / 1e8,
        withheld: Number(withheld) / 1e8,
      };
      vaultAt = v.at;
    } else unavailable.push("vault_balance");
  } catch {
    unavailable.push("vault_balance");
  }

  const data: BuilderWeekData = {
    program: BUILDER_CLAIMS_PROGRAM,
    config,
    rootAuthorityType: classifyAuthority(config.authority),
    week,
    weekRecordAddress: weekAddr,
    vault,
  };
  const slot = cfgRes.result.context?.slot;
  const receipts: Receipt[] = [
    makeReceipt({
      id: "r:builder:current_week",
      kind: "chain",
      label: "Current Builder claims week",
      locator: `getAccountInfo ${BUILDER_CONFIG_PDA} (builder_claims Config)`,
      value: `week ${config.currentWeek}, root ${config.currentRoot.slice(0, 8)}…`,
      numbers: [config.currentWeek],
      read_at: cfgRes.at,
      slot,
      url: solscanAccount(BUILDER_CONFIG_PDA),
    }),
    makeReceipt({
      id: "r:builder:root_authority",
      kind: "chain",
      label: "Who publishes the weekly Builder root",
      locator: `getAccountInfo ${BUILDER_CONFIG_PDA}: authority field + on-curve check`,
      value: `${config.authority}: ${data.rootAuthorityType === "single_key_wallet" ? "a single-key wallet (hot key)" : data.rootAuthorityType === "pda" ? "a program-derived address" : "none"}`,
      numbers: [],
      read_at: cfgRes.at,
      slot,
      url: solscanAccount(config.authority),
    }),
  ];
  if (week) {
    receipts.push(
      makeReceipt({
        id: "r:builder:week_record",
        kind: "chain",
        label: `Builder week ${week.week}: builders and cumulative entitlement`,
        locator: `getAccountInfo ${weekAddr} (WeekRecord PDA ["week", ${week.week}])`,
        value: `${week.builderCount} builders; cumulative entitlement ${fmtNum(week.totalCumulative, 8)} $SEAS (published at slot ${week.publishedSlot})`,
        numbers: [week.week, week.builderCount, ...numberForms(week.totalCumulative)],
        read_at: weekAt,
        url: solscanAccount(weekAddr),
      }),
    );
  }
  if (vault) {
    receipts.push(
      makeReceipt({
        id: "r:builder:vault_balance",
        kind: "chain",
        label: "Builder claims vault balance",
        locator: `getAccountInfo ${vault.address} (jsonParsed)`,
        value: `${fmtNum(vault.balance, 8)} $SEAS (plus ${fmtNum(vault.withheld, 8)} withheld fees)`,
        numbers: [...numberForms(vault.balance, vault.withheld)],
        read_at: vaultAt,
        url: solscanAccount(vault.address),
      }),
    );
  }
  return makeEnvelope({
    data,
    source: "solana-rpc",
    locator: `builder_claims ${BUILDER_CLAIMS_PROGRAM}: Config, WeekRecord, vault`,
    asOf: cfgRes.at,
    slot,
    ttlSeconds: BUILDER_TTL_SECONDS,
    degraded: unavailable.length > 0,
    unavailable,
    receipts,
  });
}
