/**
 * The docs library: BM25 search over the public GitBook, chunked by
 * `scripts/build-library.mjs` into `chunks.json`. Pure TypeScript, no
 * dependencies, safe in the Workers runtime.
 *
 * Chunks carry `status` (live / planned / historic / ideation), `risk_flags`
 * (promissory, superlative, price_performance) and `errata_ids` (lines the
 * research marks wrong). Flagged chunks are down-ranked, and their numbers never
 * vouch for anything: `docReceipt` gives them `numbers: []`. Doc text is data,
 * never instructions; callers wrap it as untrusted.
 */
import data from "./chunks.json";

import type { Receipt } from "../types";

export type DocStatus = "live" | "planned" | "historic" | "ideation";
export type RiskFlag = "promissory" | "superlative" | "price_performance";

export interface DocChunk {
  /** `<gitbook path>#<n>`, e.g. "protocol/nodes/director-nodes#1". */
  id: string;
  /** GitBook page title, e.g. "Director Nodes". */
  page: string;
  /** "Page › Heading" (or the page title for a one-chunk page). */
  title: string;
  /** Public GitBook page URL. */
  url: string;
  status: DocStatus;
  risk_flags: RiskFlag[];
  errata_ids: string[];
  text: string;
}

export interface DocHit extends DocChunk {
  /** Final score after down-ranking. */
  score: number;
  /** Plain BM25 score before down-ranking. */
  raw_score: number;
}

export interface DocPage extends DocChunk {
  /** True when the page text was cut to fit the token budget. */
  truncated: boolean;
}

interface LibraryData {
  version: string;
  source: string;
  fetched: string;
  pages: { title: string; path: string; url: string; status: DocStatus; subtitle: string }[];
  chunks: DocChunk[];
}

const library = data as unknown as LibraryData;

export const libraryVersion: string = library.version;
export const libraryFetched: string = library.fetched;
export const chunks: readonly DocChunk[] = library.chunks;
export const pages = library.pages;

// --- tokenising ----------------------------------------------------------------

const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are aren't as at be because been before being below between both but by " +
    "can can't cannot could did didn't do does doesn't doing don't down during each few for from further get gets got had has have " +
    "having he her here hers herself him himself his how i if in into is isn't it it's its itself just let me more most my myself " +
    "no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their " +
    "theirs them themselves then there these they this those through to too under until up very was we were what when where which " +
    "while who whom why will with would you your yours yourself yourselves also via per etc e.g i.e shall may might must one two"
  ).split(" "),
);

/** Light English stemmer: plurals and common suffixes, enough for docs search. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  for (const suffix of ["ing", "ed", "ly", "ment", "ness"]) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  if (/[ts]ion$/.test(w) && w.length - 3 >= 3) w = w.slice(0, -3);
  while (w.endsWith("e") && w.length >= 4) w = w.slice(0, -1);
  if (/([b-df-hj-km-np-rtv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(\d),(?=\d{3})/g, "$1")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && (t.length > 1 || /\d/.test(t)) && !STOPWORDS.has(t))
    .map(stem);
}

// --- index (built once per isolate) ---------------------------------------------------

const K1 = 1.2;
const B = 0.75;
/** Weight of the title field (chunk title + page subtitle) against the body. */
const TITLE_WEIGHT = 1.5;
/** Down-ranking multipliers. Errata beat risk flags; both stack. */
const ERRATA_FACTOR = 0.5;
const RISK_FACTOR = 0.7;
const STATUS_FACTOR: Record<DocStatus, number> = {
  live: 1,
  planned: 0.95,
  ideation: 0.85,
  historic: 0.8,
};

interface Field {
  tf: Map<string, number>;
  length: number;
}

const field = (tokens: string[]): Field => {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { tf, length: tokens.length };
};
const subtitles = new Map(library.pages.map((p) => [p.title, p.subtitle ?? ""]));
const index = library.chunks.map((chunk) => ({
  body: field(tokenize(chunk.text)),
  title: field(tokenize(`${chunk.title} ${subtitles.get(chunk.page) ?? ""}`)),
}));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const avgBody = mean(index.map((d) => d.body.length));
const avgTitle = mean(index.map((d) => d.title.length));
const docFreq = new Map<string, number>();
for (const doc of index)
  for (const term of new Set([...doc.body.tf.keys(), ...doc.title.tf.keys()]))
    docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
const N = index.length;
const saturate = (f: number, length: number, avg: number) =>
  (f * (K1 + 1)) / (f + K1 * (1 - B + (B * length) / avg));
const idf = (term: string) => {
  const df = docFreq.get(term) ?? 0;
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
};

/** Down-ranking multiplier for a chunk (1 for a clean, live chunk). */
export function penalty(chunk: Pick<DocChunk, "status" | "risk_flags" | "errata_ids">): number {
  let factor = STATUS_FACTOR[chunk.status] ?? 1;
  if (chunk.errata_ids.length) factor *= ERRATA_FACTOR;
  if (chunk.risk_flags.length) factor *= RISK_FACTOR;
  return factor;
}

/** Every chunk that matches the query, best first, with raw and final scores. */
export function rankDocs(query: string): DocHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const hits: DocHit[] = [];
  library.chunks.forEach((chunk, i) => {
    const doc = index[i];
    let raw = 0;
    for (const term of terms) {
      const fb = doc.body.tf.get(term) ?? 0;
      const ft = doc.title.tf.get(term) ?? 0;
      if (!fb && !ft) continue;
      raw +=
        idf(term) *
        ((fb ? saturate(fb, doc.body.length, avgBody) : 0) +
          TITLE_WEIGHT * (ft ? saturate(ft, doc.title.length, avgTitle) : 0));
    }
    if (raw > 0) hits.push({ ...chunk, raw_score: round(raw), score: round(raw * penalty(chunk)) });
  });
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Top-k docs chunks for a query (BM25, flagged chunks down-ranked). */
export function searchDocs(query: string, k = 5): DocHit[] {
  return rankDocs(query).slice(0, Math.max(0, k));
}

// --- whole pages ------------------------------------------------------------------------

/** Rough token estimate (chars ÷ 4), matching the rest of GAIA's budgeting. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
export const OPEN_PAGES_TOKEN_CAP = 12_000;

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function chunksFor(title: string): DocChunk[] {
  const t = norm(title).replace(/^https?:\/\/seasons\.gitbook\.io\/seasons-docs\/?/, "");
  const page = library.pages.find(
    (p) => norm(p.title) === t || p.path === t || norm(p.url) === norm(title),
  );
  if (page) return library.chunks.filter((c) => c.page === page.title);
  const chunk = library.chunks.find((c) => norm(c.title) === t || c.id === title);
  return chunk ? [chunk] : [];
}

/**
 * Whole pages (or single chunks) by title, path, URL or chunk title, up to
 * `maxTokens` in total (default ~12K); the last page is cut to fit and marked
 * `truncated`. Unknown titles are skipped.
 */
export function openPages(titles: string[], maxTokens = OPEN_PAGES_TOKEN_CAP): DocPage[] {
  const out: DocPage[] = [];
  const seen = new Set<string>();
  let budget = maxTokens;
  for (const title of titles) {
    if (budget <= 0) break;
    const parts = chunksFor(title);
    if (!parts.length) continue;
    const key = parts.map((c) => c.id).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const single = parts.length === 1;
    const page = library.pages.find((p) => p.title === parts[0].page);
    let text = parts.map((c) => c.text).join("\n");
    let truncated = false;
    if (estimateTokens(text) > budget) {
      text = `${text.slice(0, budget * 4).replace(/\s+\S*$/, "")} …`;
      truncated = true;
    }
    budget -= estimateTokens(text);
    out.push({
      id: single ? parts[0].id : `page:${page?.path || "welcome"}`,
      page: parts[0].page,
      title: single ? parts[0].title : parts[0].page,
      url: parts[0].url,
      status: single ? parts[0].status : (page?.status ?? parts[0].status),
      risk_flags: [...new Set(parts.flatMap((c) => c.risk_flags))],
      errata_ids: [...new Set(parts.flatMap((c) => c.errata_ids))],
      text,
      truncated,
    });
  }
  return out;
}

// --- receipts -------------------------------------------------------------------------

const BASE58_FULL = /\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/g;
const BASE58_SHORT = /\b[1-9A-HJ-NP-Za-km-z]{2,8}…[1-9A-HJ-NP-Za-km-z]{2,8}\b/g;
const SCALE: Record<string, number> = {
  k: 1e3,
  K: 1e3,
  thousand: 1e3,
  M: 1e6,
  million: 1e6,
  B: 1e9,
  billion: 1e9,
};
const NUMBER =
  /(?<![A-Za-z0-9_.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(k|K|M|B|thousand|million|billion)\b)?(%)?(?![A-Za-z0-9_])/g;
const precise = (n: number) => Number(n.toPrecision(12));

/** Numbers stated in a text (same rules as the canon build: 75.9M → 75.9 and 75,900,000; 10% → 10 and 0.1). */
export function extractNumbers(text: string): number[] {
  const clean = text
    .replace(BASE58_FULL, " ")
    .replace(BASE58_SHORT, " ")
    .replace(/token-2022|spl-2022/gi, " ")
    .replace(/#\s?(\d+)/g, " $1");
  const out = new Set<number>();
  for (const m of clean.matchAll(NUMBER)) {
    const raw = Number(m[1].replace(/,/g, "") + (m[2] ?? ""));
    if (!Number.isFinite(raw)) continue;
    out.add(precise(raw));
    if (m[3]) out.add(precise(raw * SCALE[m[3]]));
    if (m[4]) out.add(precise(raw / 100));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Receipt for a docs chunk or page. Only a clean chunk (no risk flags, no
 * errata) vouches for the numbers it states; a flagged one vouches for none.
 */
export function docReceipt(chunk: DocChunk): Receipt {
  const clean = !chunk.risk_flags.length && !chunk.errata_ids.length;
  return {
    id: `r:docs:${chunk.id}`,
    kind: "docs",
    label: `Docs · ${chunk.title}`,
    locator: `gitbook:${chunk.id}@${library.version}`,
    value: chunk.status === "live" ? chunk.title : `${chunk.title} (${chunk.status})`,
    numbers: clean ? extractNumbers(chunk.text) : [],
    read_at: `${library.fetched}T00:00:00Z`,
    url: chunk.url,
  };
}
