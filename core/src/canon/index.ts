/**
 * The compiled canon (the Almanac): facts, Hard Answers, the Official Registry,
 * the Bridge Graph and the docs errata. Source of truth is `canon/*.yaml`,
 * compiled by `node scripts/build-canon.mjs` into `canon.json`; never edit the
 * JSON by hand.
 *
 * Model-facing: `almanacDigest()`, `hardAnswers[].model_brief`, `bridges`.
 * Verifier-side only: `hardAnswers[].verifier`, `disputedClaims()`, `errata`.
 */
import data from "./canon.json";

import type { BridgeEdge, Fact, HardAnswer, Receipt, RegistryEntry } from "../types";

export interface FactInfo {
  /** Short receipt label, e.g. "Transfer fee on the $SEAS mint". */
  label: string;
  /** Receipt display value, e.g. "10% (1000 bps)". */
  value: string;
  /** Open founder decision for needs_founder facts, e.g. "D3". */
  decision?: string;
  /** Claims (regex sources) the interim wording must never make. Verifier-side. */
  disputed?: string[];
}

export interface HardAnswerInfo {
  requires_review: boolean;
  /** Open founder decisions that gate a fuller (L1) wording. */
  decisions: string[];
  /** Whether a pinned answer always logs the question to the founder queue. */
  queue: boolean;
  review_by: string;
}

export interface BridgeInfo {
  fact_keys: string[];
  /** Mentions payouts or rates: not for UK, unknown or restricted packs. */
  yield_anchor: boolean;
  /** May be used for a personal-savings question. */
  personal_savings_ok: boolean;
}

export interface Erratum {
  id: string;
  where: string;
  match: string[];
  correction: string;
}

interface CanonData {
  version: string;
  facts: Fact[];
  factMeta: Record<string, FactInfo>;
  hardAnswers: HardAnswer[];
  hardAnswerMeta: Record<string, HardAnswerInfo>;
  registry: RegistryEntry[];
  bridges: BridgeEdge[];
  bridgeMeta: Record<string, BridgeInfo>;
  errata: Erratum[];
}

const canon = data as unknown as CanonData;

/** Hash of the canon YAML this build came from; stamp it on every decision record. */
export const canonVersion: string = canon.version;

export const facts: Fact[] = canon.facts;
export const hardAnswers: HardAnswer[] = canon.hardAnswers;
export const registry: RegistryEntry[] = canon.registry;
export const bridges: BridgeEdge[] = canon.bridges;
export const errata: Erratum[] = canon.errata;

const factIndex = new Map(canon.facts.map((f) => [f.key, f]));
const hardIndex = new Map(canon.hardAnswers.map((h) => [h.id, h]));

export const getFact = (key: string): Fact | undefined => factIndex.get(key);
export const factInfo = (key: string): FactInfo | undefined => canon.factMeta[key];
export const getHardAnswer = (id: string): HardAnswer | undefined => hardIndex.get(id);
export const hardAnswerInfo = (id: string): HardAnswerInfo | undefined => canon.hardAnswerMeta[id];
export const bridgeInfo = (cluster: string): BridgeInfo | undefined => canon.bridgeMeta[cluster];

/** Verifier-side: the claims a needs_founder fact's interim wording must never make. */
export function disputedClaims(key: string): RegExp[] {
  return (canon.factMeta[key]?.disputed ?? []).map((source) => new RegExp(source, "i"));
}

const toIso = (asOf: string) => (/^\d{4}-\d{2}-\d{2}$/.test(asOf) ? `${asOf}T00:00:00Z` : asOf);

/**
 * Receipt for one Almanac fact. Team-reported facts carry kind "team_statement"
 * so the answer can label them; everything else is "almanac". `read_at` is the
 * fact's `as_of`: a live tool read supersedes it.
 */
export function factReceipt(key: string): Receipt {
  const fact = factIndex.get(key);
  if (!fact) throw new Error(`unknown Almanac key: ${key}`);
  const info = canon.factMeta[key];
  const teamReported = fact.status === "team_reported";
  return {
    id: `r:almanac:${key}`,
    kind: teamReported ? "team_statement" : "almanac",
    label: teamReported ? `${info?.label ?? key} (team-reported)` : (info?.label ?? key),
    locator: `almanac:${key}@${canon.version} · ${fact.source}`,
    value: info?.value ?? fact.text,
    numbers: [...fact.numbers],
    read_at: toIso(fact.as_of),
    ...(fact.url ? { url: fact.url } : {}),
  };
}

let digest: string | null = null;

/**
 * Compact listing for the brain's cached system prompt: one line per approved or
 * team-reported fact (`key: text [as_of]`). needs_founder facts appear only with
 * their interim neutral wording, marked as such. Byte-stable per canon version.
 */
export function almanacDigest(): string {
  if (digest !== null) return digest;
  digest = canon.facts
    .map((f) => {
      const prefix =
        (f.on_request ? "(on request) " : "") +
        (f.status === "team_reported"
          ? "(team-reported) "
          : f.status === "needs_founder"
            ? "(interim wording) "
            : "");
      const stamp = f.live_tool ? `${f.as_of}; live: ${f.live_tool}` : f.as_of;
      return `${f.key}: ${prefix}${f.text} [${stamp}]`;
    })
    .join("\n");
  return digest;
}
