/**
 * get_token_trust_facts: the $SEAS mint's powers, read live.
 * Who can mint, freeze, change or collect the 10% fee, and whether a fee
 * change is already scheduled. GAIA answers "can they rug / change the tax"
 * only from this tool's receipts.
 */
import { fmtNum, makeEnvelope, makeReceipt, numberForms, pctForms } from "../kernel/numbers";

import { classifyAuthority, type AuthorityType } from "./base58";
import {
  SEAS_DECIMALS,
  SEAS_MINT,
  solscanAccount,
  solscanToken,
  TOKEN_2022_PROGRAM,
} from "./constants";
import { ChainError } from "./http";
import { createRpcClient } from "./rpc";

import type { Receipt, ToolEnvelope, ChainConfig } from "../types";

export const TRUST_TTL_SECONDS = 600;

/** Extensions that would let someone freeze, move, pause or re-route holders' tokens. */
export const RISKY_EXTENSIONS = [
  "permanentDelegate",
  "transferHook",
  "defaultAccountState",
  "pausableConfig",
  "mintCloseAuthority",
  "confidentialTransferMint",
  "nonTransferable",
  "scaledUiAmountConfig",
  "interestBearingConfig",
] as const;

export interface TransferFeeTier {
  epoch: number;
  bps: number;
  /** maximumFee in $SEAS. */
  maximumFee: number;
  maximumFeeRaw: string;
}

export interface AuthorityFact {
  address: string | null;
  type: AuthorityType;
}

export interface TrustFactsData {
  mint: string;
  program: string;
  programName: string;
  decimals: number;
  mintAuthority: AuthorityFact;
  freezeAuthority: AuthorityFact;
  metadataUpdateAuthority: AuthorityFact;
  metadataPointerAuthority: AuthorityFact;
  metadata: { name: string | null; symbol: string | null };
  extensions: string[];
  riskyExtensionsPresent: string[];
  transferFee: {
    older: TransferFeeTier;
    newer: TransferFeeTier;
    /** The tier in force at the current epoch. */
    current: TransferFeeTier;
    currentEpoch: number;
    /** newer.epoch > current epoch: a different fee is already scheduled. */
    pendingChange: boolean;
    /** Token-2022 schedules a new fee two epochs ahead of the one it was set in. */
    changeDelayEpochs: 2;
    configAuthority: AuthorityFact;
    withdrawWithheldAuthority: AuthorityFact;
    /** Fees harvested to the mint and not yet withdrawn, in $SEAS. */
    withheldOnMint: number;
  };
  epoch: { epoch: number; slotIndex: number; slotsInEpoch: number; progressPct: number };
}

interface ParsedMint {
  context?: { slot?: number };
  value: null | {
    owner: string;
    data: {
      program?: string;
      parsed?: {
        type?: string;
        info?: {
          decimals: number;
          mintAuthority: string | null;
          freezeAuthority: string | null;
          supply: string;
          extensions?: Array<{ extension: string; state?: Record<string, unknown> }>;
        };
      };
    };
  };
}

interface EpochInfo {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
}

const toSeas = (raw: unknown): number => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return n / 10 ** SEAS_DECIMALS;
};

function feeTier(x: unknown): TransferFeeTier {
  const o = (x ?? {}) as Record<string, unknown>;
  const epoch = Number(o.epoch);
  const bps = Number(o.transferFeeBasisPoints);
  if (!Number.isFinite(epoch) || !Number.isFinite(bps))
    throw new ChainError("invalid_response", "transferFeeConfig is malformed");
  return { epoch, bps, maximumFee: toSeas(o.maximumFee), maximumFeeRaw: String(o.maximumFee) };
}

const authority = (a: unknown): AuthorityFact => {
  const address = typeof a === "string" && a.length > 0 ? a : null;
  return { address, type: classifyAuthority(address) };
};

const AUTH_TEXT: Record<AuthorityType, string> = {
  none: "none (revoked)",
  single_key_wallet: "a single-key wallet (on-curve address: one private key signs)",
  pda: "a program-derived address (off-curve; controlled by a program, possibly a multisig)",
};

/** Pure: mint account + epoch info → trust facts. Exported for offline tests. */
export function parseTrustFacts(mint: ParsedMint, epoch: EpochInfo): TrustFactsData {
  const v = mint.value;
  const info = v?.data?.parsed?.info;
  if (!v || !info || v.data.parsed?.type !== "mint")
    throw new ChainError("invalid_response", "mint account is missing or not a parsed mint");
  const exts = info.extensions ?? [];
  const ext = (name: string) => exts.find((e) => e.extension === name)?.state ?? null;
  const fee = ext("transferFeeConfig");
  if (!fee) throw new ChainError("invalid_response", "mint has no transferFeeConfig extension");
  const meta = ext("tokenMetadata");
  const pointer = ext("metadataPointer");
  const older = feeTier(fee.olderTransferFee);
  const newer = feeTier(fee.newerTransferFee);
  const current = epoch.epoch >= newer.epoch ? newer : older;
  const names = exts.map((e) => e.extension);
  return {
    mint: SEAS_MINT,
    program: v.owner,
    programName: v.owner === TOKEN_2022_PROGRAM ? "Token-2022" : (v.data.program ?? "unknown"),
    decimals: info.decimals,
    mintAuthority: authority(info.mintAuthority),
    freezeAuthority: authority(info.freezeAuthority),
    metadataUpdateAuthority: authority(meta?.updateAuthority),
    metadataPointerAuthority: authority(pointer?.authority),
    metadata: {
      name: typeof meta?.name === "string" ? meta.name : null,
      symbol: typeof meta?.symbol === "string" ? meta.symbol : null,
    },
    extensions: names,
    riskyExtensionsPresent: names.filter((n) =>
      (RISKY_EXTENSIONS as readonly string[]).includes(n),
    ),
    transferFee: {
      older,
      newer,
      current,
      currentEpoch: epoch.epoch,
      pendingChange: newer.epoch > epoch.epoch,
      changeDelayEpochs: 2,
      configAuthority: authority(fee.transferFeeConfigAuthority),
      withdrawWithheldAuthority: authority(fee.withdrawWithheldAuthority),
      withheldOnMint: toSeas(fee.withheldAmount),
    },
    epoch: {
      epoch: epoch.epoch,
      slotIndex: epoch.slotIndex,
      slotsInEpoch: epoch.slotsInEpoch,
      progressPct: epoch.slotsInEpoch > 0 ? (epoch.slotIndex / epoch.slotsInEpoch) * 100 : 0,
    },
  };
}

export function trustReceipts(
  d: TrustFactsData,
  readAt: string,
  slot: number | undefined,
  epochReadAt = readAt,
): Receipt[] {
  const loc = `getAccountInfo ${SEAS_MINT} (jsonParsed)`;
  const url = solscanToken(SEAS_MINT);
  const r = (
    id: string,
    label: string,
    value: string,
    numbers: Array<number | undefined>,
    extra: { locator?: string; url?: string; read_at?: string } = {},
  ) =>
    makeReceipt({
      id: `r:trust:${id}`,
      kind: "chain",
      label,
      locator: extra.locator ?? loc,
      value,
      numbers,
      read_at: extra.read_at ?? readAt,
      slot,
      url: extra.url ?? url,
    });
  const auth = (a: AuthorityFact) =>
    a.address ? `${a.address}: ${AUTH_TEXT[a.type]}` : AUTH_TEXT.none;
  const tf = d.transferFee;
  const cur = tf.current;
  return [
    r("mint_authority", "Mint authority of $SEAS", auth(d.mintAuthority), []),
    r("freeze_authority", "Freeze authority of $SEAS", auth(d.freezeAuthority), []),
    r(
      "metadata_authority",
      "Token metadata update authority",
      `update authority ${auth(d.metadataUpdateAuthority)}; metadata pointer authority ${auth(d.metadataPointerAuthority)}`,
      [],
    ),
    r(
      "extensions",
      "Token-2022 extensions on the mint",
      `${d.extensions.join(", ")}${d.riskyExtensionsPresent.length ? `; present: ${d.riskyExtensionsPresent.join(", ")}` : "; no permanent delegate, transfer hook, default account state or pause extension"}`,
      [d.extensions.length],
    ),
    r(
      "fee_bps",
      "Transfer fee on the $SEAS mint",
      `${fmtNum(cur.bps / 100, 2)}% (${cur.bps} bps)`,
      [cur.bps, ...pctForms(cur.bps / 10_000)],
    ),
    r("fee_max", "Maximum fee per transfer (maximumFee)", `${fmtNum(cur.maximumFee, 8)} $SEAS`, [
      ...numberForms(cur.maximumFee),
      Number(cur.maximumFeeRaw),
    ]),
    r(
      "fee_schedule",
      "Transfer fee schedule (older / newer)",
      `older: epoch ${tf.older.epoch}, ${tf.older.bps} bps; newer: epoch ${tf.newer.epoch}, ${tf.newer.bps} bps; current epoch ${tf.currentEpoch}`,
      [tf.older.epoch, tf.newer.epoch, tf.older.bps, tf.newer.bps, tf.currentEpoch],
    ),
    r(
      "pending_change",
      "Scheduled fee change",
      tf.pendingChange
        ? `PENDING: ${tf.newer.bps} bps from epoch ${tf.newer.epoch} (current epoch ${tf.currentEpoch}); now ${tf.older.bps} bps`
        : `No change pending (newer fee epoch ${tf.newer.epoch} ≤ current epoch ${tf.currentEpoch}). A new rate can only take effect ${tf.changeDelayEpochs} epochs after it is set, and it is visible on-chain immediately.`,
      [tf.newer.epoch, tf.currentEpoch, tf.changeDelayEpochs, tf.newer.bps],
    ),
    r("fee_config_authority", "Who can change the transfer fee", auth(tf.configAuthority), [], {
      url: tf.configAuthority.address ? solscanAccount(tf.configAuthority.address) : url,
    }),
    r(
      "withdraw_authority",
      "Who can collect withheld fees",
      auth(tf.withdrawWithheldAuthority),
      [],
      {
        url: tf.withdrawWithheldAuthority.address
          ? solscanAccount(tf.withdrawWithheldAuthority.address)
          : url,
      },
    ),
    r(
      "withheld_on_mint",
      "Fees harvested to the mint, not yet withdrawn",
      `${fmtNum(tf.withheldOnMint, 8)} $SEAS (lower bound; most withheld fees sit in other token accounts)`,
      numberForms(tf.withheldOnMint),
    ),
    r("decimals", "Decimals of $SEAS", String(d.decimals), [d.decimals]),
    r("program", "Token program of $SEAS", `${d.programName} (${d.program})`, [2022]),
    makeReceipt({
      id: "r:trust:epoch",
      kind: "chain",
      label: "Current Solana epoch",
      locator: "getEpochInfo",
      value: `epoch ${d.epoch.epoch}, ${fmtNum(d.epoch.progressPct, 1)}% through (${d.epoch.slotIndex} of ${d.epoch.slotsInEpoch} slots)`,
      numbers: [
        d.epoch.epoch,
        ...numberForms(d.epoch.progressPct),
        d.epoch.slotIndex,
        d.epoch.slotsInEpoch,
      ],
      read_at: epochReadAt,
    }),
  ];
}

export async function getTokenTrustFacts(cfg: ChainConfig): Promise<ToolEnvelope<TrustFactsData>> {
  const rpc = createRpcClient(cfg);
  const mint = await rpc.call<ParsedMint>(
    "getAccountInfo",
    [SEAS_MINT, { encoding: "jsonParsed", commitment: "confirmed" }],
    {
      ttlSeconds: TRUST_TTL_SECONDS,
    },
  );
  const epoch = await rpc.call<EpochInfo>("getEpochInfo", [{ commitment: "confirmed" }], {
    ttlSeconds: TRUST_TTL_SECONDS,
  });
  const data = parseTrustFacts(mint.result, epoch.result);
  const slot = mint.result.context?.slot;
  return makeEnvelope({
    data,
    source: "solana-rpc",
    locator: `getAccountInfo ${SEAS_MINT} (jsonParsed) + getEpochInfo`,
    asOf: mint.at,
    slot,
    ttlSeconds: TRUST_TTL_SECONDS,
    receipts: trustReceipts(data, mint.at, slot, epoch.at),
  });
}
