/**
 * get_price: $SEAS price from the two main pools (DexScreener pair endpoints)
 * and Jupiter price v3, each with source and read time, the gap between them,
 * exit-side (USDC) depth, and market caps that always name their definition.
 * There is no fallback price: a source that fails is listed as unavailable.
 */
import {
  fmtNum,
  fmtUsd,
  makeEnvelope,
  makeReceipt,
  numberForms,
  pctForms,
} from "../kernel/numbers";

import {
  CIRCULATING_ALMANAC,
  DEXSCREENER_PAIRS_API,
  dexscreenerPair,
  JUPITER_PRICE_API,
  METEORA_DAMM_PAIR,
  RAYDIUM_CLMM_PAIR,
  SEAS_MINT,
} from "./constants";
import { getJson } from "./http";

import type { ChainConfig, Receipt, ToolEnvelope } from "../types";

export const PRICE_TTL_SECONDS = 30;
/** Provisional flag threshold until founders set one (decision D7). */
export const DEFAULT_DIVERGENCE_PCT = 2;

const POOLS = [
  {
    key: "raydium_clmm",
    pair: RAYDIUM_CLMM_PAIR,
    venue: "Raydium CLMM SEAS/USDC",
    canonical: true,
  },
  {
    key: "meteora_damm",
    pair: METEORA_DAMM_PAIR,
    venue: "Meteora DAMM v2 SEAS/USDC",
    canonical: false,
  },
] as const;

export interface PriceQuote {
  key: string;
  source: "dexscreener" | "jupiter";
  venue: string;
  pair?: string;
  priceUsd: number;
  /** Time GAIA read the value (neither API timestamps the price itself). */
  readAt: string;
  /** Jupiter only: slot the price was computed at. */
  blockId?: number;
  canonical: boolean;
  liquidityUsd?: number;
  /** $SEAS side of the pool. */
  baseLiquidity?: number;
  /** USDC side of the pool: what a seller can actually exit into. */
  exitLiquidityUsdc?: number;
  exitToken?: string;
  url?: string;
}

export interface MarketCap {
  key: string;
  usd: number;
  definition: string;
  circulatingBasis?: number;
}

export interface PriceData {
  prices: PriceQuote[];
  canonical: string;
  canonicalNote: string;
  gaps: Array<{ source: string; vs: string; gapPct: number }>;
  maxSpreadPct?: number;
  divergent: boolean;
  divergenceThresholdPct: number;
  totalExitLiquidityUsdc?: number;
  marketCaps: MarketCap[];
}

interface DexPair {
  pairAddress?: string;
  dexId?: string;
  url?: string;
  labels?: string[];
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
}

interface DexPairsResponse {
  pairs?: DexPair[] | null;
  pair?: DexPair | null;
}

type JupiterPrices = Record<string, { usdPrice?: number; blockId?: number } | undefined>;

const positive = (x: unknown): number | undefined => {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Pure: DexScreener + Jupiter responses → price data. Exported for tests. */
export function parsePrices(
  dex: { data: DexPairsResponse; at: string } | null,
  jup: { data: JupiterPrices; at: string } | null,
  divergencePct = DEFAULT_DIVERGENCE_PCT,
): { data: PriceData; unavailable: string[] } {
  const unavailable: string[] = [];
  const prices: PriceQuote[] = [];
  const pairs = dex ? [...(dex.data.pairs ?? []), ...(dex.data.pair ? [dex.data.pair] : [])] : [];
  let dexCaps: { marketCap?: number; fdv?: number } = {};
  for (const pool of POOLS) {
    const p = pairs.find((x) => x.pairAddress === pool.pair);
    const price = positive(p?.priceUsd);
    // Only a $SEAS-based pair's priceUsd is the $SEAS price.
    if (!dex || !p || !price || p.baseToken?.address !== SEAS_MINT) {
      unavailable.push(`price_${pool.key}`);
      continue;
    }
    const q: PriceQuote = {
      key: pool.key,
      source: "dexscreener",
      venue: pool.venue,
      pair: pool.pair,
      priceUsd: price,
      readAt: dex.at,
      canonical: pool.canonical,
      url: dexscreenerPair(pool.pair),
    };
    const liq = p.liquidity;
    if (positive(liq?.usd)) q.liquidityUsd = liq!.usd!;
    if (positive(liq?.base)) q.baseLiquidity = liq!.base!;
    const exitSym = p.quoteToken?.symbol;
    if (positive(liq?.quote) && (exitSym === "USDC" || exitSym === "USDT")) {
      q.exitLiquidityUsdc = liq!.quote!;
      q.exitToken = exitSym;
    } else unavailable.push(`exit_liquidity_${pool.key}`);
    if (pool.canonical) dexCaps = { marketCap: positive(p.marketCap), fdv: positive(p.fdv) };
    prices.push(q);
  }
  const jp = jup?.data?.[SEAS_MINT];
  const jPrice = positive(jp?.usdPrice);
  if (jup && jPrice) {
    const q: PriceQuote = {
      key: "jupiter",
      source: "jupiter",
      venue: "Jupiter price v3 (route-derived)",
      priceUsd: jPrice,
      readAt: jup.at,
      canonical: false,
    };
    if (typeof jp?.blockId === "number") q.blockId = jp.blockId;
    prices.push(q);
  } else unavailable.push("price_jupiter");

  const canonical = prices.find((p) => p.canonical);
  if (!canonical) unavailable.push("price_canonical");
  const gaps = canonical
    ? prices
        .filter((p) => p !== canonical)
        .map((p) => ({
          source: p.key,
          vs: canonical.key,
          gapPct: ((p.priceUsd - canonical.priceUsd) / canonical.priceUsd) * 100,
        }))
    : [];
  const values = prices.map((p) => p.priceUsd);
  const maxSpreadPct =
    values.length > 1
      ? ((Math.max(...values) - Math.min(...values)) / Math.min(...values)) * 100
      : undefined;
  const exits = prices
    .map((p) => p.exitLiquidityUsdc)
    .filter((x): x is number => typeof x === "number");

  const marketCaps: MarketCap[] = [];
  if (canonical) {
    marketCaps.push({
      key: "chain_circulating",
      usd: canonical.priceUsd * CIRCULATING_ALMANAC.circulating,
      circulatingBasis: CIRCULATING_ALMANAC.circulating,
      definition: `${canonical.venue} price × ${fmtNum(CIRCULATING_ALMANAC.circulating, 0)} circulating $SEAS (total supply minus the ${CIRCULATING_ALMANAC.escrows} time-lock escrows; almanac as of ${CIRCULATING_ALMANAC.asOf})`,
    });
    if (dexCaps.marketCap) {
      marketCaps.push({
        key: "dexscreener",
        usd: dexCaps.marketCap,
        circulatingBasis: dexCaps.marketCap / canonical.priceUsd,
        definition: `DexScreener's reported market cap (its own circulating figure, ≈${fmtNum(dexCaps.marketCap / canonical.priceUsd, 0)} $SEAS implied)`,
      });
    }
    if (dexCaps.fdv) {
      marketCaps.push({
        key: "fdv_dexscreener",
        usd: dexCaps.fdv,
        definition: "DexScreener's fully diluted value (price × total supply)",
      });
    }
  } else unavailable.push("market_cap");

  const data: PriceData = {
    prices,
    canonical: canonical?.key ?? "unavailable",
    canonicalNote:
      "Canonical is the Raydium CLMM pair (deepest by total liquidity), the current team rule; which price is canonical is an open founder decision (D7). Other sources can differ because the 10% transfer fee affects routing.",
    gaps,
    divergent: gaps.some((g) => Math.abs(g.gapPct) > divergencePct),
    divergenceThresholdPct: divergencePct,
    marketCaps,
  };
  if (maxSpreadPct !== undefined) data.maxSpreadPct = maxSpreadPct;
  if (exits.length) data.totalExitLiquidityUsdc = exits.reduce((a, b) => a + b, 0);
  return { data, unavailable };
}

export function priceReceipts(d: PriceData): Receipt[] {
  const out: Receipt[] = [];
  // Price receipts first, numbers[0] = the price: callers read the first r:price: receipt's first number.
  for (const p of d.prices) {
    out.push(
      makeReceipt({
        id: `r:price:${p.key}`,
        kind: "api",
        label: `$SEAS price: ${p.venue}${p.canonical ? " (canonical)" : ""}`,
        locator:
          p.source === "dexscreener"
            ? `DexScreener ${DEXSCREENER_PAIRS_API}${p.pair}`
            : `Jupiter ${JUPITER_PRICE_API}?ids=${SEAS_MINT}`,
        value: `${fmtUsd(p.priceUsd, 6)} (${p.source === "jupiter" ? "Jupiter" : "DexScreener"}, read ${p.readAt})`,
        numbers: numberForms(p.priceUsd),
        read_at: p.readAt,
        ...(p.blockId !== undefined ? { slot: p.blockId } : {}),
        ...(p.url ? { url: p.url } : {}),
      }),
    );
  }
  if (d.gaps.length) {
    out.push(
      makeReceipt({
        id: "r:price:gap",
        kind: "calc",
        label: "Gap between price sources",
        locator: "(source − canonical) / canonical",
        value: `${d.gaps.map((g) => `${g.source} ${g.gapPct >= 0 ? "+" : ""}${fmtNum(g.gapPct, 2)}%`).join(", ")} vs ${d.canonical}${d.divergent ? ` (over the ${d.divergenceThresholdPct}% flag)` : ""}`,
        numbers: [
          ...d.gaps.flatMap((g) => [...numberForms(g.gapPct), ...numberForms(Math.abs(g.gapPct))]),
          ...numberForms(d.maxSpreadPct),
        ],
        read_at: d.prices[0]?.readAt,
      }),
    );
  }
  const pools = d.prices.filter(
    (p) => p.exitLiquidityUsdc !== undefined || p.liquidityUsd !== undefined,
  );
  if (pools.length) {
    out.push(
      makeReceipt({
        id: "r:price:exit_liquidity",
        kind: "api",
        label: "Exit-side (USDC) liquidity of the main pools",
        locator: "DexScreener pair liquidity.quote / liquidity.usd",
        value: pools
          .map(
            (p) =>
              `${p.venue}: ${p.exitLiquidityUsdc !== undefined ? `${fmtUsd(p.exitLiquidityUsdc, 0)} ${p.exitToken}` : "exit side unavailable"} of ${p.liquidityUsd !== undefined ? fmtUsd(p.liquidityUsd, 0) : "?"} total`,
          )
          .join("; "),
        // Thousands and millions too, so "$78.2k" or "$1.01M" match.
        numbers: [
          ...pools.flatMap((p) =>
            numberForms(
              p.exitLiquidityUsdc,
              p.exitLiquidityUsdc !== undefined ? p.exitLiquidityUsdc / 1e3 : undefined,
              p.liquidityUsd,
              p.liquidityUsd !== undefined ? p.liquidityUsd / 1e3 : undefined,
              p.liquidityUsd !== undefined ? p.liquidityUsd / 1e6 : undefined,
              p.baseLiquidity,
            ),
          ),
          ...numberForms(
            d.totalExitLiquidityUsdc,
            d.totalExitLiquidityUsdc !== undefined ? d.totalExitLiquidityUsdc / 1e3 : undefined,
          ),
        ],
        read_at: pools[0]!.readAt,
      }),
    );
  }
  for (const m of d.marketCaps) {
    out.push(
      makeReceipt({
        id: `r:price:mcap_${m.key}`,
        kind: m.key === "chain_circulating" ? "calc" : "api",
        label:
          m.key === "fdv_dexscreener"
            ? "Fully diluted value (DexScreener)"
            : `Market cap (${m.key === "chain_circulating" ? "chain-defined circulating" : "DexScreener"})`,
        locator:
          m.key === "chain_circulating"
            ? "F20 market cap: canonical price × almanac circulating supply"
            : "DexScreener pair marketCap / fdv",
        value: `≈${fmtUsd(m.usd, 0)}: ${m.definition}`,
        numbers: [
          ...numberForms(m.usd, m.usd / 1e6),
          ...numberForms(
            m.circulatingBasis,
            m.circulatingBasis !== undefined ? m.circulatingBasis / 1e6 : undefined,
          ),
        ],
        read_at: d.prices[0]?.readAt,
      }),
    );
  }
  return out;
}

export async function getPrice(
  cfg: ChainConfig,
  opts: { divergencePct?: number } = {},
): Promise<ToolEnvelope<PriceData>> {
  const dexUrl = `${DEXSCREENER_PAIRS_API}${POOLS.map((p) => p.pair).join(",")}`;
  const jupUrl = `${JUPITER_PRICE_API}?ids=${SEAS_MINT}`;
  const [dex, jup] = await Promise.all([
    getJson<DexPairsResponse>(cfg, dexUrl, {
      ttlSeconds: PRICE_TTL_SECONDS,
      cacheKey: "dex:pairs:seas",
    }).catch(() => null),
    getJson<JupiterPrices>(cfg, jupUrl, {
      ttlSeconds: PRICE_TTL_SECONDS,
      cacheKey: "jup:seas",
    }).catch(() => null),
  ]);
  const { data, unavailable } = parsePrices(dex, jup, opts.divergencePct);
  const receipts = priceReceipts(data);
  return makeEnvelope({
    data,
    source: "dexscreener+jupiter",
    locator: `DexScreener pairs ${RAYDIUM_CLMM_PAIR}, ${METEORA_DAMM_PAIR}; Jupiter price v3 ${SEAS_MINT}`,
    asOf: dex?.at ?? jup?.at ?? new Date().toISOString(),
    ttlSeconds: PRICE_TTL_SECONDS,
    // A missing source is a partial answer, never a stand-in number.
    degraded: unavailable.some((u) => u.startsWith("price_")),
    unavailable,
    receipts,
  });
}
