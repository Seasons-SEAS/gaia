/**
 * get_distribution_receipts: Director payout rounds read from the Set #2
 * distributor's own history.
 *
 * Signatures are clustered by gaps > 3 h; clusters of ≥ 40 transactions are
 * payout rounds (small ones are funding and swap preparation). The latest
 * round's transactions are parsed from token-balance deltas: the distributor
 * only loses tokens in payout transactions, and both loses $SEAS and gains
 * basket assets in swaps, which is how the two are told apart.
 */
import {
  fmtAmount,
  fmtNum,
  fmtUsd,
  makeEnvelope,
  makeReceipt,
  numberForms,
  pctForms,
} from "../kernel/numbers";

import {
  JUPITER_PRICE_API,
  KNOWN_MINTS,
  SEAS_MINT,
  SET2_DISTRIBUTOR,
  solscanAccount,
  solscanTx,
  WEEKDAYS,
} from "./constants";
import { cacheGet, cachePut, ChainError, getJson, sleep } from "./http";
import { createRpcClient, isPublicMainnetRpc, type RpcClient } from "./rpc";

import type { ChainConfig, Receipt, ToolEnvelope } from "../types";

export const DIST_TTL_SECONDS = 1800;
const TX_CACHE_TTL_SECONDS = 7 * 86_400; // finalized transactions never change
const GAP_SECONDS = 3 * 3600;
const MIN_ROUND_TX = 40;
/** Rounds inspected for the weekday check when one signature page provides them. */
const STREAK_WINDOW = 8;

// --- signatures and clustering ----------------------------------------------------------

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export interface SigCluster {
  startSec: number;
  endSec: number;
  txCount: number;
  failedCount: number;
  /** Successful signatures, oldest first. */
  signatures: string[];
  kind: "payout_round" | "preparation";
  /** False for the oldest cluster when older history was not read (it may continue). */
  complete: boolean;
  /** The newest cluster ended less than 3 h ago: more payouts may still land. */
  possiblyInProgress: boolean;
}

/** Newest first. Pure; exported for tests. */
export function clusterSignatures(
  sigs: SignatureInfo[],
  o: { historyExhausted: boolean; nowSec: number; gapSeconds?: number; minRoundTx?: number },
): SigCluster[] {
  const gap = o.gapSeconds ?? GAP_SECONDS;
  const minTx = o.minRoundTx ?? MIN_ROUND_TX;
  const dated = sigs
    .filter((s) => typeof s.blockTime === "number")
    .sort((a, b) => a.blockTime! - b.blockTime!);
  const groups: SignatureInfo[][] = [];
  for (const s of dated) {
    const g = groups[groups.length - 1];
    if (g && s.blockTime! - g[g.length - 1]!.blockTime! <= gap) g.push(s);
    else groups.push([s]);
  }
  const clusters = groups.map((g, i): SigCluster => {
    const failed = g.filter((s) => s.err !== null && s.err !== undefined);
    return {
      startSec: g[0]!.blockTime!,
      endSec: g[g.length - 1]!.blockTime!,
      txCount: g.length,
      failedCount: failed.length,
      signatures: g.filter((s) => s.err === null || s.err === undefined).map((s) => s.signature),
      kind: g.length >= minTx ? "payout_round" : "preparation",
      complete: i > 0 || o.historyExhausted,
      possiblyInProgress: i === groups.length - 1 && o.nowSec - g[g.length - 1]!.blockTime! < gap,
    };
  });
  return clusters.reverse();
}

// --- transaction parsing --------------------------------------------------------------------

export interface TokenBalance {
  accountIndex?: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface TxLike {
  slot?: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction?: { signatures?: string[] };
}

/** Only what the parser needs; keeps cache entries small. */
export interface TrimmedTx {
  signature: string;
  blockTime: number | null;
  err: unknown;
  pre: Array<[owner: string, mint: string, amount: string, decimals: number]>;
  post: Array<[owner: string, mint: string, amount: string, decimals: number]>;
}

export function trimTx(tx: TxLike, signature: string): TrimmedTx {
  const row = (b: TokenBalance): [string, string, string, number] => [
    b.owner ?? `account#${b.accountIndex ?? "?"}`,
    b.mint,
    b.uiTokenAmount.amount,
    b.uiTokenAmount.decimals,
  ];
  return {
    signature,
    blockTime: tx.blockTime ?? null,
    err: tx.meta ? (tx.meta.err ?? null) : "no_meta",
    pre: (tx.meta?.preTokenBalances ?? []).map(row),
    post: (tx.meta?.postTokenBalances ?? []).map(row),
  };
}

export type TxKind = "payout" | "swap" | "inflow" | "other" | "failed";

export interface ParsedTx {
  signature: string;
  blockTime: number | null;
  kind: TxKind;
  /** Non-zero balance changes of the distributor, by mint (base units). */
  distributorDeltas: Record<string, bigint>;
  /** Payout transactions only: what each recipient received, by mint. */
  credits: Array<{ owner: string; mint: string; amount: bigint }>;
  decimals: Record<string, number>;
}

export function parseDistributorTx(tx: TrimmedTx, distributor = SET2_DISTRIBUTOR): ParsedTx {
  const out: ParsedTx = {
    signature: tx.signature,
    blockTime: tx.blockTime,
    kind: "other",
    distributorDeltas: {},
    credits: [],
    decimals: {},
  };
  if (tx.err !== null && tx.err !== undefined) {
    out.kind = "failed";
    return out;
  }
  const delta = new Map<string, bigint>();
  const key = (o: string, m: string) => `${o}\u0000${m}`;
  for (const [o, m, a, d] of tx.pre) {
    delta.set(key(o, m), (delta.get(key(o, m)) ?? 0n) - BigInt(a));
    out.decimals[m] = d;
  }
  for (const [o, m, a, d] of tx.post) {
    delta.set(key(o, m), (delta.get(key(o, m)) ?? 0n) + BigInt(a));
    out.decimals[m] = d;
  }
  const others: Array<{ owner: string; mint: string; amount: bigint }> = [];
  for (const [k, v] of delta) {
    if (v === 0n) continue;
    const [owner, mint] = k.split("\u0000") as [string, string];
    if (owner === distributor) out.distributorDeltas[mint] = v;
    else others.push({ owner, mint, amount: v });
  }
  const vals = Object.values(out.distributorDeltas);
  const gains = vals.some((v) => v > 0n);
  const losses = vals.some((v) => v < 0n);
  if (gains && losses) out.kind = "swap";
  else if (losses) {
    out.kind = "payout";
    const paid = new Set(Object.keys(out.distributorDeltas));
    out.credits = others.filter((c) => c.amount > 0n && paid.has(c.mint));
  } else if (gains) out.kind = "inflow";
  return out;
}

export interface BasketAsset {
  mint: string;
  symbol: string;
  name: string;
  /** Label comes from the verified known-mint map. */
  known: boolean;
  decimals: number;
  totalPaid: number;
  totalPaidExact: string;
  recipients: number;
}

export interface RoundTotals {
  kinds: Record<TxKind, number>;
  uniqueRecipients: number;
  assets: BasketAsset[];
  /** $SEAS the distributor sold in this round's swaps. */
  seasSold: number;
  swaps: number;
  firstPayoutSignature?: string;
  lastPayoutSignature?: string;
}

const toDecimal = (v: bigint, decimals: number) => {
  const scale = 10n ** BigInt(decimals);
  const frac = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return {
    n: Number(v / scale) + Number(v % scale) / Number(scale),
    s: `${v / scale}${frac ? "." + frac : ""}`,
  };
};

/** Pure: parsed transactions of one round → basket totals. */
export function summarizeRound(parsed: ParsedTx[]): RoundTotals {
  const kinds: Record<TxKind, number> = { payout: 0, swap: 0, inflow: 0, other: 0, failed: 0 };
  const paid = new Map<string, bigint>();
  const recipientsByMint = new Map<string, Set<string>>();
  const all = new Set<string>();
  const decimals: Record<string, number> = {};
  let seasSold = 0n;
  const payouts: ParsedTx[] = [];
  for (const p of parsed) {
    kinds[p.kind]++;
    Object.assign(decimals, p.decimals);
    if (p.kind === "swap") {
      const s = p.distributorDeltas[SEAS_MINT];
      if (s !== undefined && s < 0n) seasSold += -s;
    }
    if (p.kind !== "payout") continue;
    payouts.push(p);
    for (const c of p.credits) {
      paid.set(c.mint, (paid.get(c.mint) ?? 0n) + c.amount);
      if (!recipientsByMint.has(c.mint)) recipientsByMint.set(c.mint, new Set());
      recipientsByMint.get(c.mint)!.add(c.owner);
      all.add(c.owner);
    }
  }
  const assets: BasketAsset[] = [...paid.entries()].map(([mint, total]) => {
    const known = KNOWN_MINTS[mint];
    const d = decimals[mint] ?? known?.decimals ?? 0;
    const dec = toDecimal(total, d);
    return {
      mint,
      symbol: known?.symbol ?? `unknown (${mint.slice(0, 4)}…${mint.slice(-4)})`,
      name: known?.name ?? "unlabelled mint",
      known: Boolean(known),
      decimals: d,
      totalPaid: dec.n,
      totalPaidExact: dec.s,
      recipients: recipientsByMint.get(mint)?.size ?? 0,
    };
  });
  // Stable order: known basket order first, then others.
  const order = Object.keys(KNOWN_MINTS);
  assets.sort((a, b) => (order.indexOf(a.mint) + 1 || 99) - (order.indexOf(b.mint) + 1 || 99));
  payouts.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  return {
    kinds,
    uniqueRecipients: all.size,
    assets,
    seasSold: toDecimal(seasSold, 8).n,
    swaps: kinds.swap,
    firstPayoutSignature: payouts[0]?.signature,
    lastPayoutSignature: payouts[payouts.length - 1]?.signature,
  };
}

// --- listing and weekday check ------------------------------------------------------------------

export interface RoundListing {
  startUtc: string;
  endUtc: string;
  /** UTC weekday of the round's first transaction. */
  weekday: string;
  txCount: number;
  failedCount: number;
  /** Hours since the previous round started (undefined for the oldest listed). */
  gapHoursFromPrevious?: number;
}

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");
const weekdayOf = (sec: number) => WEEKDAYS[new Date(sec * 1000).getUTCDay()]!;

function listing(c: SigCluster, prev?: SigCluster): RoundListing {
  const l: RoundListing = {
    startUtc: iso(c.startSec),
    endUtc: iso(c.endSec),
    weekday: weekdayOf(c.startSec),
    txCount: c.txCount,
    failedCount: c.failedCount,
  };
  if (prev) l.gapHoursFromPrevious = Math.round(((c.startSec - prev.startSec) / 3600) * 10) / 10;
  return l;
}

export interface WeekdayStreak {
  /** Complete rounds inspected (newest first). */
  windowRounds: number;
  weekdays: string[];
  allSundayOrWednesday: boolean;
  /** Consecutive most recent rounds that started on a Sunday or Wednesday (UTC). */
  streak: number;
}

export function weekdayStreak(rounds: Array<{ weekday: string }>): WeekdayStreak {
  const ok = (w: string) => w === "Sunday" || w === "Wednesday";
  let streak = 0;
  for (const r of rounds) {
    if (!ok(r.weekday)) break;
    streak++;
  }
  return {
    windowRounds: rounds.length,
    weekdays: rounds.map((r) => r.weekday),
    allSundayOrWednesday: rounds.every((r) => ok(r.weekday)),
    streak,
  };
}

// --- the tool -------------------------------------------------------------------------------------

export interface DistributionOptions {
  /** Rounds to list (the latest is parsed in full). Default 1, max 12. */
  rounds?: number;
  distributor?: string;
  pageSize?: number;
  maxPages?: number;
  /** getTransaction calls per JSON-RPC batch. Default 10, or 1 on the public endpoint. */
  batchSize?: number;
  /** Pause between batches. Default 100 ms, or 1,100 ms on the public endpoint. */
  delayMs?: number;
  /** Stop fetching after this long and report the round as partial. */
  budgetMs?: number;
  /** Most transactions parsed for one round. */
  maxTransactions?: number;
  /** Value the basket at Jupiter prices read now (labelled as such). Default true. */
  valueUsd?: boolean;
  now?: Date;
}

export interface BasketUsd {
  totalUsd: number;
  perAsset: Array<{
    symbol: string;
    mint: string;
    priceUsd: number;
    usd: number;
    sharePct: number;
  }>;
  pricedAt: string;
  note: string;
}

export interface LatestRound extends RoundListing {
  complete: boolean;
  parsedTransactions: number;
  totals?: RoundTotals;
  firstPayoutTx?: string;
  lastPayoutTx?: string;
}

export interface DistributionData {
  distributor: string;
  method: string;
  rounds: RoundListing[];
  latest: LatestRound | null;
  inProgress?: RoundListing;
  weekdayStreak: WeekdayStreak;
  basketUsd?: BasketUsd;
}

interface JupiterPrice {
  [mint: string]: { usdPrice?: number; blockId?: number } | undefined;
}

async function fetchRoundTxs(
  cfg: ChainConfig,
  rpc: RpcClient,
  signatures: string[],
  o: { batchSize: number; delayMs: number; deadline: number },
): Promise<{ txs: TrimmedTx[]; missing: number }> {
  const txs: TrimmedTx[] = [];
  const queue: Array<{ sig: string; tries: number }> = [];
  for (const sig of signatures) {
    const hit = await cacheGet<TrimmedTx>(cfg.cache, `tx:${sig}`);
    if (hit) txs.push(hit.v);
    else queue.push({ sig, tries: 0 });
  }
  let first = true;
  while (queue.length > 0 && Date.now() <= o.deadline) {
    if (!first && o.delayMs > 0) await sleep(o.delayMs);
    first = false;
    const chunk = queue.splice(0, o.batchSize);
    const calls = chunk.map(({ sig }) => ({
      method: "getTransaction" as const,
      params: [
        sig,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ],
    }));
    // One item: a plain call (no batch body), friendlier to strict public endpoints.
    const results =
      chunk.length === 1
        ? [
            await rpc
              .call<TxLike | null>(calls[0]!.method, calls[0]!.params)
              .catch((e: unknown) => ({ ok: false as const, error: e })),
          ]
        : await rpc.batch<TxLike | null>(calls);
    let failed = false;
    for (let j = 0; j < chunk.length; j++) {
      const r = results[j];
      const item = chunk[j]!;
      if (!r || !r.ok || !r.result) {
        failed = true;
        // Up to three attempts per transaction, spread over the budget.
        if (item.tries < 2) queue.push({ sig: item.sig, tries: item.tries + 1 });
        continue;
      }
      const t = trimTx(r.result, item.sig);
      txs.push(t);
      await cachePut(
        cfg.cache,
        `tx:${item.sig}`,
        { at: new Date().toISOString(), v: t },
        TX_CACHE_TTL_SECONDS,
      );
    }
    // Back off after a rate-limited or failed read instead of hammering the endpoint.
    if (failed) await sleep(Math.max(o.delayMs, 1500));
  }
  return { txs, missing: signatures.length - txs.length };
}

export async function getDistributionReceipts(
  cfg: ChainConfig,
  opts: DistributionOptions = {},
): Promise<ToolEnvelope<DistributionData>> {
  const rounds = Math.min(12, Math.max(1, Math.floor(opts.rounds ?? 1)));
  const distributor = opts.distributor ?? SET2_DISTRIBUTOR;
  const valueUsd = opts.valueUsd ?? true;
  const gentle = cfg.gentle ?? isPublicMainnetRpc(cfg.rpcUrl);
  const batchSize = Math.max(1, Math.min(20, opts.batchSize ?? (gentle ? 1 : 10)));
  const delayMs = Math.max(0, opts.delayMs ?? (gentle ? 1100 : 100));
  const budgetMs = opts.budgetMs ?? (gentle ? 100_000 : 25_000);
  const maxTx = opts.maxTransactions ?? 250;
  const pageSize = Math.max(10, Math.min(1000, opts.pageSize ?? 1000));
  const maxPages = Math.max(1, Math.min(10, opts.maxPages ?? 3));
  const started = Date.now();
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);

  const toolKey = `dist:${distributor}:r${rounds}:u${valueUsd ? 1 : 0}`;
  const cachedEnv = await cacheGet<ToolEnvelope<DistributionData>>(cfg.cache, toolKey);
  if (cachedEnv) return cachedEnv.v;

  const rpc = createRpcClient(cfg);
  const sigs: SignatureInfo[] = [];
  let before: string | undefined;
  let exhausted = false;
  let sigsAt = "";
  let clusters: SigCluster[] = [];
  const need = Math.max(rounds, STREAK_WINDOW) + 1;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && delayMs > 0) await sleep(delayMs);
    const res = await rpc.call<SignatureInfo[]>("getSignaturesForAddress", [
      distributor,
      { limit: pageSize, commitment: "confirmed", ...(before ? { before } : {}) },
    ]);
    if (!Array.isArray(res.result))
      throw new ChainError("invalid_response", "getSignaturesForAddress returned no list");
    if (!sigsAt) sigsAt = res.at;
    sigs.push(...res.result);
    exhausted = res.result.length < pageSize;
    clusters = clusterSignatures(sigs, { historyExhausted: exhausted, nowSec });
    const completeRounds = clusters.filter((c) => c.kind === "payout_round" && c.complete).length;
    if (exhausted || completeRounds >= need || res.result.length === 0) break;
    before = res.result[res.result.length - 1]!.signature;
  }

  const payoutClusters = clusters.filter((c) => c.kind === "payout_round" && c.complete);
  const inProgressCluster = payoutClusters[0]?.possiblyInProgress ? payoutClusters[0] : undefined;
  const settled = payoutClusters.filter((c) => !c.possiblyInProgress);
  const listed = settled.slice(0, rounds).map((c) => listing(c, settled[settled.indexOf(c) + 1]));
  // Every settled round that was read counts toward the weekday check.
  const streak = weekdayStreak(settled.map((c) => ({ weekday: weekdayOf(c.startSec) })));

  const unavailable: string[] = [];
  let degraded = false;
  let latest: LatestRound | null = null;
  const latestCluster = settled[0];
  if (latestCluster) {
    const sigList = latestCluster.signatures.slice(0, maxTx);
    const { txs, missing } = await fetchRoundTxs(cfg, rpc, sigList, {
      batchSize,
      delayMs,
      deadline: started + budgetMs,
    });
    const complete = missing === 0 && latestCluster.signatures.length <= maxTx;
    latest = { ...listing(latestCluster, settled[1]), complete, parsedTransactions: txs.length };
    if (complete) {
      const totals = summarizeRound(txs.map((t) => parseDistributorTx(t, distributor)));
      latest.totals = totals;
      if (totals.firstPayoutSignature) latest.firstPayoutTx = totals.firstPayoutSignature;
      if (totals.lastPayoutSignature) latest.lastPayoutTx = totals.lastPayoutSignature;
    } else {
      // Partial totals would understate the round; report none rather than a wrong number.
      degraded = true;
      unavailable.push("basket_totals", "unique_recipients");
    }
  } else {
    unavailable.push("latest_round");
  }

  const data: DistributionData = {
    distributor,
    method:
      "Distributor signatures clustered by gaps over 3 h; clusters of 40+ transactions are payout rounds. Basket totals and recipients come from token-balance changes in the round's payout transactions.",
    rounds: listed,
    latest,
    weekdayStreak: streak,
  };
  if (inProgressCluster) data.inProgress = listing(inProgressCluster, settled[0]);

  let usdAt = "";
  if (valueUsd && latest?.totals && latest.totals.assets.length > 0) {
    try {
      const mints = latest.totals.assets.map((a) => a.mint);
      const url = `${JUPITER_PRICE_API}?ids=${mints.join(",")}`;
      const j = await getJson<JupiterPrice>(cfg, url, {
        ttlSeconds: 30,
        cacheKey: `jup:${mints.join(",")}`,
      });
      usdAt = j.at;
      const perAsset = latest.totals.assets.map((a) => {
        const price = j.data?.[a.mint]?.usdPrice;
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0)
          throw new ChainError("invalid_response", "price missing");
        return {
          symbol: a.symbol,
          mint: a.mint,
          priceUsd: price,
          usd: a.totalPaid * price,
          sharePct: 0,
        };
      });
      const total = perAsset.reduce((s, x) => s + x.usd, 0);
      for (const x of perAsset) x.sharePct = total > 0 ? (x.usd / total) * 100 : 0;
      data.basketUsd = {
        totalUsd: total,
        perAsset,
        pricedAt: j.at,
        note: "Valued at Jupiter price v3 when read, not at the time of the payout.",
      };
    } catch {
      unavailable.push("basket_usd");
    }
  }

  const receipts = distributionReceipts(data, sigsAt, usdAt);
  const env = makeEnvelope({
    data,
    source: "solana-rpc",
    locator: `getSignaturesForAddress ${distributor} + getTransaction (jsonParsed) × ${latest?.parsedTransactions ?? 0}`,
    asOf: sigsAt,
    ttlSeconds: DIST_TTL_SECONDS,
    degraded,
    unavailable,
    receipts,
  });
  // Only complete results are cached; a partial read resumes from the per-transaction cache.
  if (!degraded) await cachePut(cfg.cache, toolKey, { at: sigsAt, v: env }, DIST_TTL_SECONDS);
  return env;
}

function dateNumbers(isoTime: string): number[] {
  const d = new Date(isoTime);
  return [
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  ];
}

const hm = (isoTime: string) => isoTime.slice(11, 16);

export function distributionReceipts(
  d: DistributionData,
  readAt: string,
  usdAt = readAt,
): Receipt[] {
  const url = solscanAccount(d.distributor);
  const sigLoc = `getSignaturesForAddress ${d.distributor}, clustered by > 3 h gaps`;
  const out: Receipt[] = [];
  const L = d.latest;
  if (L) {
    out.push(
      makeReceipt({
        id: "r:dist:latest_round",
        kind: "chain",
        label: "Latest Director payout round",
        locator: sigLoc,
        value: `${L.weekday} ${L.startUtc.slice(0, 10)}, ${hm(L.startUtc)}–${hm(L.endUtc)} UTC, ${L.txCount} transactions`,
        numbers: [
          ...dateNumbers(L.startUtc),
          ...dateNumbers(L.endUtc),
          L.txCount,
          L.gapHoursFromPrevious,
        ],
        read_at: readAt,
        url: L.firstPayoutTx ? solscanTx(L.firstPayoutTx) : url,
      }),
    );
    if (L.totals) {
      const t = L.totals;
      const txLoc = `getTransaction × ${L.parsedTransactions} (jsonParsed): token-balance changes of ${t.kinds.payout} payout transactions`;
      out.push(
        makeReceipt({
          id: "r:dist:recipients",
          kind: "chain",
          label: "Wallets paid in the latest round",
          locator: txLoc,
          value: `${t.uniqueRecipients} unique wallets (${t.assets.map((a) => `${a.recipients} received ${a.symbol}`).join(", ")})`,
          numbers: [
            t.uniqueRecipients,
            ...t.assets.map((a) => a.recipients),
            t.kinds.payout,
            L.parsedTransactions,
          ],
          read_at: readAt,
          url,
        }),
      );
      for (const a of t.assets) {
        out.push(
          makeReceipt({
            id: `r:dist:paid_${a.known ? a.symbol.replace(/[^A-Za-z0-9]/g, "") : a.mint.slice(0, 8)}`,
            kind: "chain",
            label: `${a.symbol} paid in the latest round`,
            locator: `${txLoc}; mint ${a.mint}`,
            value: `${fmtAmount(a.totalPaid, a.decimals)} ${a.symbol} (exact ${a.totalPaidExact}) to ${a.recipients} wallets`,
            numbers: [...numberForms(a.totalPaid), a.recipients],
            read_at: readAt,
            url,
          }),
        );
      }
      if (t.swaps > 0) {
        out.push(
          makeReceipt({
            id: "r:dist:seas_sold",
            kind: "chain",
            label: "$SEAS the distributor swapped into the basket this round",
            locator: `getTransaction: distributor $SEAS balance change in ${t.swaps} swap transactions`,
            value: `${fmtNum(t.seasSold, 8)} $SEAS sold in ${t.swaps} swaps`,
            numbers: [...numberForms(t.seasSold), t.swaps],
            read_at: readAt,
            url,
          }),
        );
      }
    }
  }
  if (d.rounds.length > 1) {
    out.push(
      makeReceipt({
        id: "r:dist:rounds",
        kind: "chain",
        label: `Last ${d.rounds.length} payout rounds`,
        locator: sigLoc,
        value: d.rounds
          .map((r) => `${r.weekday.slice(0, 3)} ${r.startUtc.slice(0, 10)} (${r.txCount} tx)`)
          .join("; "),
        numbers: d.rounds.flatMap((r) => [
          ...dateNumbers(r.startUtc).slice(0, 3),
          r.txCount,
          r.gapHoursFromPrevious,
        ]),
        read_at: readAt,
        url,
      }),
    );
  }
  const s = d.weekdayStreak;
  if (s.windowRounds > 0) {
    out.push(
      makeReceipt({
        id: "r:dist:weekday_streak",
        kind: "chain",
        label: "Weekday check of recent payout rounds",
        locator: sigLoc,
        value: s.allSundayOrWednesday
          ? `All ${s.windowRounds} recent rounds read started on a Sunday or Wednesday (UTC)`
          : `${s.streak} most recent rounds on Sunday/Wednesday; ${s.windowRounds} read: ${s.weekdays.join(", ")}`,
        numbers: [s.windowRounds, s.streak],
        read_at: readAt,
        url,
      }),
    );
  }
  if (d.basketUsd) {
    const b = d.basketUsd;
    out.push(
      makeReceipt({
        id: "r:dist:basket_usd",
        kind: "api",
        label: "Latest round's basket, valued at the price when read",
        locator: `Jupiter price v3 (${JUPITER_PRICE_API}) × amounts paid`,
        value: `≈${fmtUsd(b.totalUsd)} at prices read ${usdAt || b.pricedAt} (not the value at payout time): ${b.perAsset.map((x) => `${x.symbol} ${fmtUsd(x.usd)} (${fmtNum(x.sharePct, 1)}%)`).join(", ")}`,
        numbers: [
          ...numberForms(b.totalUsd),
          ...b.perAsset.flatMap((x) => [
            ...numberForms(x.usd, x.priceUsd),
            ...pctForms(x.sharePct / 100),
          ]),
        ],
        read_at: usdAt || b.pricedAt,
      }),
    );
  }
  return out;
}
