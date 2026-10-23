/**
 * get_supply: total $SEAS supply read live; circulating only as a dated,
 * clearly labelled almanac value (it needs the 61 lock escrows, which this
 * module does not enumerate).
 */
import { fmtNum, makeEnvelope, makeReceipt, numberForms, pctForms } from "../kernel/numbers";

import { CIRCULATING_ALMANAC, SEAS_MINT, solscanToken } from "./constants";
import { ChainError } from "./http";
import { createRpcClient } from "./rpc";

import type { ChainConfig, ToolEnvelope } from "../types";

export const SUPPLY_TTL_SECONDS = 3600;

export interface SupplyData {
  totalSupply: number;
  totalSupplyRaw: string;
  decimals: number;
  /** 1,000,000,000 minted at genesis minus the small amount burned since. */
  burnedSinceGenesis: number;
  circulating: {
    value: number;
    pctOfSupply: number;
    live: false;
    asOf: string;
    definition: string;
    lockedNet: number;
    withheldInEscrows: number;
    escrows: number;
  };
}

interface TokenSupply {
  context?: { slot?: number };
  value: { amount: string; decimals: number; uiAmountString?: string };
}

const toNumber = (raw: bigint, scale: bigint) =>
  Number(raw / scale) + Number(raw % scale) / Number(scale);

export function parseSupply(r: TokenSupply): {
  total: number;
  raw: string;
  decimals: number;
  burned: number;
} {
  const v = r?.value;
  if (!v || typeof v.amount !== "string" || !/^\d+$/.test(v.amount))
    throw new ChainError("invalid_response", "getTokenSupply returned no amount");
  const raw = BigInt(v.amount);
  const scale = 10n ** BigInt(v.decimals);
  // Burned vs the 1,000,000,000 genesis mint, in base units (no float drift).
  const genesis = 1_000_000_000n * scale;
  return {
    total: toNumber(raw, scale),
    raw: v.amount,
    decimals: v.decimals,
    burned: raw < genesis ? toNumber(genesis - raw, scale) : 0,
  };
}

export async function getSupply(cfg: ChainConfig): Promise<ToolEnvelope<SupplyData>> {
  const rpc = createRpcClient(cfg);
  const res = await rpc.call<TokenSupply>(
    "getTokenSupply",
    [SEAS_MINT, { commitment: "confirmed" }],
    { ttlSeconds: SUPPLY_TTL_SECONDS },
  );
  const { total, raw, decimals, burned } = parseSupply(res.result);
  const slot = res.result.context?.slot;
  const a = CIRCULATING_ALMANAC;
  const data: SupplyData = {
    totalSupply: total,
    totalSupplyRaw: raw,
    decimals,
    burnedSinceGenesis: burned,
    circulating: {
      value: a.circulating,
      pctOfSupply: a.circulatingPctOfSupply,
      live: false,
      asOf: a.asOf,
      definition: `total supply minus the ${a.escrows} time-lock escrows (net balances plus fees withheld in them)`,
      lockedNet: a.lockedNet,
      withheldInEscrows: a.withheldInEscrows,
      escrows: a.escrows,
    },
  };
  const receipts = [
    makeReceipt({
      id: "r:supply:total",
      kind: "chain",
      label: "Total $SEAS supply",
      locator: `getTokenSupply ${SEAS_MINT}`,
      value: `${fmtNum(total, 8)} $SEAS (1,000,000,000 minted at genesis; ${fmtNum(data.burnedSinceGenesis, 8)} burned since)`,
      numbers: [...numberForms(total), 1_000_000_000, ...numberForms(data.burnedSinceGenesis)],
      read_at: res.at,
      slot,
      url: solscanToken(SEAS_MINT),
    }),
    makeReceipt({
      id: "r:supply:circulating_almanac",
      kind: "almanac",
      label: `Circulating $SEAS (almanac, as of ${a.asOf}; not a live read)`,
      locator: a.locator,
      value: `≈${fmtNum(a.circulating, 0)} $SEAS (≈${a.circulatingPctOfSupply}% of supply) as of ${a.asOf}: ${data.circulating.definition}. Locked ${fmtNum(a.lockedNet, 2)} + withheld ${fmtNum(a.withheldInEscrows, 2)} = ${fmtNum(a.outOfCirculation, 2)}.`,
      numbers: [
        ...numberForms(a.circulating),
        333_000_000,
        333,
        ...pctForms(a.circulatingPctOfSupply / 100),
        ...numberForms(a.lockedNet, a.withheldInEscrows, a.outOfCirculation),
        600.3,
        66.7,
        667,
        60.03,
        6.67,
        a.escrows,
      ],
      read_at: a.readAt,
    }),
  ];
  return makeEnvelope({
    data,
    source: "solana-rpc+almanac",
    locator: `getTokenSupply ${SEAS_MINT}; circulating from almanac (${a.asOf})`,
    asOf: res.at,
    slot,
    ttlSeconds: SUPPLY_TTL_SECONDS,
    // Circulating is a dated value here; the live recomputation needs the escrow list.
    unavailable: ["circulating_supply_live"],
    receipts,
  });
}
