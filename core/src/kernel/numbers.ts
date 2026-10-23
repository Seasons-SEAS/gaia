/**
 * Number forms, formatting and receipt/envelope builders shared by the kernel
 * and the chain tools. The verifier matches numbers in GAIA's answer against
 * receipt `numbers`, so each receipt lists the raw value plus the rounded
 * forms a sentence would naturally use.
 */
import type { Receipt, ReceiptKind, ToolEnvelope } from "../types";

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function roundTo(x: number, dp: number): number {
  const f = 10 ** dp;
  // EPSILON nudge so 1.005 rounds to 1.01 like people expect.
  return Math.round((x + Math.sign(x) * Number.EPSILON * Math.abs(x)) * f) / f;
}

export function ceilTo(x: number, dp: number): number {
  const f = 10 ** dp;
  // Subtract a tiny relative amount so exact values (11111.12) do not bump up.
  return Math.ceil(x * f - 1e-12 * Math.max(1, Math.abs(x * f))) / f;
}

export function floorTo(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.floor(x * f + 1e-12 * Math.max(1, Math.abs(x * f))) / f;
}

function sig(x: number, digits: number): number {
  return x === 0 ? 0 : Number(x.toPrecision(digits));
}

/**
 * Raw value plus 2/1/0-decimal and 3/4-significant-digit roundings. A form that
 * rounds a non-zero value to 0 is dropped (it would vouch for a misleading 0).
 */
export function numberForms(...xs: Array<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const x of xs) {
    if (!isNum(x)) continue;
    out.push(x);
    for (const v of [roundTo(x, 2), roundTo(x, 1), roundTo(x, 0), sig(x, 3), sig(x, 4)]) {
      if (v === 0 && x !== 0) continue;
      out.push(v);
    }
  }
  return out;
}

/**
 * Forms for an amount someone must reach (a gross-up, a minimum balance):
 * only exact and rounded-UP values, so the verifier never vouches for an
 * amount that would fall short (11,111.11 nets 9,999.99…).
 */
export function requirementForms(...xs: Array<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const x of xs) {
    if (!isNum(x)) continue;
    out.push(x, ceilTo(x, 2), ceilTo(x, 1), ceilTo(x, 0));
  }
  return out;
}

/** A fraction (0.1946) as itself and as a percentage (19.46), with rounded forms of both. */
export function pctForms(...fractions: Array<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const f of fractions) {
    if (!isNum(f)) continue;
    out.push(...numberForms(f), ...numberForms(f * 100));
  }
  return out;
}

export function uniqNumbers(xs: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of xs) {
    if (!isNum(x)) continue;
    // Normalise float noise (0.1 + 0.2) so duplicates collapse.
    const v = Number(x.toPrecision(15));
    const key = Object.is(v, -0) ? 0 : v;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

// --- formatting (English, display only; the brain localises prose) ------------

export function fmtNum(x: number, maxDp = 2, minDp = 0): string {
  return x.toLocaleString("en-US", { maximumFractionDigits: maxDp, minimumFractionDigits: minDp });
}

export function fmtSeas(x: number, maxDp = 2): string {
  return `${fmtNum(x, maxDp)} $SEAS`;
}

/** A requirement ("send at least …"): rounded UP to 2 dp so the text never falls short. */
export function fmtSeasAtLeast(x: number): string {
  return `${fmtNum(ceilTo(x, 2), 2)} $SEAS`;
}

export function fmtUsd(x: number, maxDp = 2): string {
  const s = fmtNum(Math.abs(x), maxDp, Math.min(2, maxDp));
  return `${x < 0 ? "−" : ""}$${s}`;
}

/** Fraction → "23.46%". */
export function fmtPct(fraction: number, dp = 2): string {
  return `${fmtNum(fraction * 100, dp)}%`;
}

/** Small amounts keep significant digits ("0.02108091 wBTC"). */
export function fmtAmount(x: number, decimals: number): string {
  return fmtNum(x, Math.min(decimals, 8));
}

// --- receipts and envelopes ------------------------------------------------------

export interface ReceiptInit {
  id: string;
  kind: ReceiptKind;
  label: string;
  locator: string;
  value: string;
  numbers: Array<number | null | undefined>;
  read_at?: string;
  slot?: number;
  url?: string;
}

export function makeReceipt(r: ReceiptInit): Receipt {
  const out: Receipt = {
    id: r.id,
    kind: r.kind,
    label: r.label,
    locator: r.locator,
    value: r.value,
    numbers: uniqNumbers(r.numbers.filter(isNum)),
    read_at: r.read_at ?? new Date().toISOString(),
  };
  if (r.slot !== undefined) out.slot = r.slot;
  if (r.url) out.url = r.url;
  return out;
}

export interface EnvelopeInit<T> {
  data: T;
  source: string;
  locator: string;
  asOf?: string;
  slot?: number;
  ttlSeconds: number;
  degraded?: boolean;
  unavailable?: string[];
  receipts: Receipt[];
}

export function makeEnvelope<T>(e: EnvelopeInit<T>): ToolEnvelope<T> {
  const env: ToolEnvelope<T> = {
    data: e.data,
    source: e.source,
    locator: e.locator,
    asOf: e.asOf ?? new Date().toISOString(),
    ttlSeconds: e.ttlSeconds,
    degraded: e.degraded ?? false,
    unavailable: [...new Set(e.unavailable ?? [])],
    receipts: e.receipts,
  };
  if (e.slot !== undefined) env.slot = e.slot;
  return env;
}

/** FNV-1a 32-bit, hex. Deterministic short tag for receipt ids and cache keys. */
export function shortHash(s: string, len = 6): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, len);
}

/** JSON with sorted keys, so equal inputs give equal hashes. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}
