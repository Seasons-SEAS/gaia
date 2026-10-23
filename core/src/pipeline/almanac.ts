import { factReceipt, facts } from "../canon";
import { parseNumbers } from "../verify";

import type { Receipt } from "../types";

/**
 * Almanac facts as receipts (hard line 2: a Seasons number may come from the
 * Almanac). Only facts on the answer's own topics vouch for its numbers, so
 * "the APY is 8%" can't borrow the 8 from "8 decimals".
 */

export const almanacReceipts = (): Receipt[] =>
  facts.filter((fact) => fact.status !== "needs_founder").map((fact) => factReceipt(fact.key));

const GENERIC = new Set([
  "seas",
  "$seas",
  "seasons",
  "the",
  "and",
  "per",
  "with",
  "from",
  "current",
  "last",
  "total",
  "live",
  "public",
]);

/**
 * Topic words in GAIA's other languages (stems), per fact family, so a Russian
 * "ставка 20,17%" is vouched for by apy.last_reported like "APY 20.17%" is.
 */
const ALIASES: Record<string, string[]> = {
  apy: [
    "ставк",
    "доходн",
    "годовых",
    "rendite",
    "zins",
    "rentabilidad",
    "tasa",
    "rendimiento",
    "利回り",
    "年利",
  ],
  yield: [
    "доходн",
    "распредел",
    "выплат",
    "rendite",
    "ausschütt",
    "rendimiento",
    "distribu",
    "利回り",
    "分配",
  ],
  distribution: [
    "выплат",
    "раунд",
    "auszahl",
    "runde",
    "pago",
    "ronda",
    "配当",
    "分配",
    "ラウンド",
  ],
  node: ["нод", "директор", "билдер", "knoten", "nodo", "ノード"],
  tax: ["комисси", "налог", "gebühr", "steuer", "comisión", "impuesto", "手数料", "税"],
  fee: ["комисси", "gebühr", "comisión", "手数料"],
  supply: ["эмисси", "предложени", "выпущен", "angebot", "oferta", "suministro", "供給", "発行"],
  locks: ["блокир", "заблок", "разблок", "sperr", "bloque", "ロック"],
  price: ["цен", "курс", "preis", "precio", "価格"],
  modules: ["модул", "modul", "módulo", "モジュール"],
  inclusion_set: ["корзин", "золот", "биткоин", "korb", "cesta", "バスケット"],
};

const keywords = (receipt: Receipt) => {
  const key = receipt.id.replace(/^r:almanac:/, "");
  return (
    [
      ...key.split(/[._]/),
      ...receipt.label.toLowerCase().split(/[^a-z0-9$]+/),
      ...(ALIASES[key.split(".")[0]] ?? []),
    ]
      .map((word) => word.toLowerCase())
      // eslint-disable-next-line no-control-regex -- "any non-ASCII letter" test
      .filter(
        (word) =>
          word.length >= 2 && !GENERIC.has(word) && (word.length >= 3 || /[^\x00-\x7f]/.test(word)),
      )
  );
};

const CJK = /[\u3040-\u30ff\u4e00-\u9fff]/;
const startsWord = (word: string, text: string) =>
  CJK.test(word)
    ? text.includes(word)
    : new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu").test(
        text,
      );

/** Facts whose topic words appear in the text. */
export function relevantAlmanac(text: string, pool: Receipt[]): Receipt[] {
  const lower = text.toLowerCase();
  return pool.filter((receipt) => keywords(receipt).some((word) => startsWord(word, lower)));
}

/** The Almanac receipts whose numbers appear in a text: what the answer actually leaned on. */
export function almanacUsed(text: string, pool: Receipt[], limit = 3): Receipt[] {
  const numbers = parseNumbers(text).map((n) => n.value);
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.006);
  // Small integers ("2–4 days", "one") match too many facts to count on their own.
  const telling = (n: number) => !(Number.isInteger(n) && n >= 0 && n <= 5);
  return relevantAlmanac(text, pool)
    .map((r) => {
      const hits = numbers.filter((m) => r.numbers.some((n) => close(m, n)));
      return { r, score: hits.filter(telling).length * 2 + hits.length };
    })
    .filter(({ score }) => score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ r }) => r);
}
