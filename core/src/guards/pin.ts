/**
 * Deterministic Hard Answer pin:
 * the user's words against each entry's examples (every language) and intent
 * keywords. No model is involved, so the prefetch can start at once.
 */
import { lower1to1, skeleton } from "./text";

import type { HardAnswer } from "../types";

const STOP = new Set(
  (
    "a an the is are was were be been am do does did this that these those it its it's i me my you your we our they them he she of to in on at for by with " +
    "and or but so if than then what which who whom how why when where there here right just really any some can could would should will shall " +
    "это эт то ли а и в на с по у не ну же что как кто мне я ты вы мы он она они ваш ваша ваше ваши ist das der die ein eine es und oder zu im " +
    "es un una el la los las de del y o que en por para se lo al"
  ).split(" "),
);

function tokens(text: string): string[] {
  const s = skeleton(lower1to1(text.normalize("NFKC")));
  const out: string[] = [];
  for (const m of s.matchAll(/[\p{L}\p{N}$]+/gu)) {
    const t = m[0];
    // Han/kana runs have no spaces: use character bigrams.
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(t)) {
      if (t.length === 1) out.push(t);
      for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
      continue;
    }
    if (!STOP.has(t)) out.push(t);
  }
  return out;
}

const flat = (text: string) => tokens(text).join(" ");

/** Same word modulo inflection: "makers"/"maker", "пирамида"/"пирамиду". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 4) return false;
  let p = 0;
  while (p < min && a[p] === b[p]) p++;
  return p >= Math.max(4, min - 2);
}

const has = (toks: string[], w: string) => toks.some((t) => sameWord(t, w));

function exampleScore(textToks: string[], example: string): number {
  const exFlat = flat(example);
  const textFlat = textToks.join(" ");
  if (!exFlat) return 0;
  if (exFlat === textFlat) return 1;
  if (` ${textFlat} `.includes(` ${exFlat} `)) return 0.95;
  const exToks = tokens(example);
  const hit = exToks.filter((w) => has(textToks, w)).length;
  const containment = hit / exToks.length;
  if (containment < 0.6) return 0;
  const coverage = textToks.length ? hit / textToks.length : 0;
  return 0.75 * containment + 0.25 * Math.min(1, coverage);
}

function intentScore(textToks: string[], intent: string): number {
  const kws = intent
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter((k) => k && !STOP.has(k) && k !== "via");
  if (!kws.length || !kws.every((k) => has(textToks, k))) return 0;
  return 0.6 + 0.05 * Math.min(kws.length, 3);
}

const THRESHOLD = 0.6;

/** Best-matching Hard Answer id, or null. Exact-ish example matches beat keyword intents. */
export function matchPin(text: string, hardAnswers: HardAnswer[] = []): string | null {
  const textToks = tokens(text);
  if (!textToks.length) return null;
  let best: { id: string; score: number } | null = null;
  for (const ha of hardAnswers) {
    let score = 0;
    for (const list of Object.values(ha.examples ?? {}))
      for (const ex of list) score = Math.max(score, exampleScore(textToks, ex));
    for (const intent of ha.intents ?? []) score = Math.max(score, intentScore(textToks, intent));
    if (score >= THRESHOLD && (!best || score > best.score)) best = { id: ha.id, score };
  }
  return best?.id ?? null;
}
