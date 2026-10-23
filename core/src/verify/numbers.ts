/**
 * Sentence splitting and a multilingual number parser for numeric provenance
 *: decimal commas ("20,17 %"), thousands separators, 万/億,
 * "75.9M", "1 млрд", "$0.35", "1000 bps", ranges. Dates, times of day, years,
 * list markers and identifiers (Token-2022, Q1, E1J26…) are not quantities.
 */
import { asciiDigits, mask } from "../guards/text";

export type NumUnit = "%" | "bps" | "x" | "usd" | "seas";

export interface ParsedNumber {
  value: number;
  raw: string;
  unit?: NumUnit;
}

export interface ScannedNumber extends ParsedNumber {
  start: number;
  end: number;
  /** Digits after the decimal point as written (for rounding tolerance). */
  decimals: number;
  /** 1, 1e3, 1e6, 1e9, 1e4 (万), 1e8 (億)… */
  magnitude: number;
  /** "about", "~", "≈" … before the number: trailing zeros are rounding. */
  approx: boolean;
  /** Other readings of an ambiguous form ("1.000" is 1 in English and 1000 in German). */
  alts: number[];
}

// --- sentences ----------------------------------------------------------------------

const ABBREVIATIONS =
  /^(?:e\.g|i\.e|u\.s|u\.k|u\.s\.a|etc|vs|approx|dr|mr|mrs|ms|fig|cf|ca|z\.b|d\.h|usw|bzw|ggf|p\.ej|aprox|т\.е|т\.к|т\.д|т\.п|др|см|incl|excl|est|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|inc|ltd|co|no|nr|vol|pp|ch)$/i;
const CLOSERS = /["'”’»)\]*_」』]/;

/** Split into sentences on . ! ? 。！？ and line breaks; decimals, domains and "e.g." don't split. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) out.push(t);
  };
  for (const line of text.split(/\n+/)) {
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (c === "。" || c === "！" || c === "？") {
        let k = i;
        while (k + 1 < line.length && CLOSERS.test(line[k + 1]!)) k++;
        push(line.slice(start, k + 1));
        start = k + 1;
        i = k;
        continue;
      }
      if (c !== "." && c !== "!" && c !== "?") continue;
      let j = i;
      while (j + 1 < line.length && /[.!?]/.test(line[j + 1]!)) j++;
      let k = j;
      while (k + 1 < line.length && CLOSERS.test(line[k + 1]!)) k++;
      const next = line[k + 1];
      // "seasons.wtf", "0.35", "U.S.": no whitespace after the dot, no boundary.
      if (next !== undefined && !/\s/.test(next)) {
        i = j;
        continue;
      }
      if (c === "." && j === i) {
        const word = /(\S+)$/.exec(line.slice(start, i))?.[1] ?? "";
        const bare = word.replace(/^[("'“«*_]+/, "");
        const after = line.slice(k + 1).trimStart();
        if (ABBREVIATIONS.test(bare) && !(/^(?:no|nr)$/i.test(bare) && !/^\d/.test(after)))
          continue;
        // An ordinal list marker ("1. First") or a single initial ("J. Smith").
        if (/^\d{1,2}$/.test(bare) && !line.slice(start, i - word.length).trim()) continue;
        if (/^\p{Lu}$/u.test(bare) && /^\p{Lu}/u.test(after)) continue;
      }
      push(line.slice(start, k + 1));
      start = k + 1;
      i = k;
    }
    push(line.slice(start));
  }
  return out;
}

// --- numbers --------------------------------------------------------------------------

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|" +
  "январ\\p{L}*|феврал\\p{L}*|март\\p{L}*|апрел\\p{L}*|ма[йя]|июн\\p{L}*|июл\\p{L}*|август\\p{L}*|сентябр\\p{L}*|октябр\\p{L}*|ноябр\\p{L}*|декабр\\p{L}*|янв|фев|мар|апр|авг|сен|окт|ноя|дек|" +
  "januar|februar|märz|mai|juni|juli|oktober|dezember|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|" +
  "janvier|février|mars|avril|juin|juillet|août|septembre|octobre|novembre|décembre|gennaio|febbraio|aprile|maggio|giugno|luglio|settembre|ottobre|dicembre";

const NON_QUANTITY: RegExp[] = [
  /\b(?:https?|hxxps?):\/\/\S+/giu,
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}/gu,
  // Base58 runs (addresses, signatures) and truncated forms "E1J26…Jzm8".
  /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,90}(?![1-9A-HJ-NP-Za-km-z])/g,
  /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{2,10}(?:…|\.{3})[1-9A-HJ-NP-Za-km-z]{2,10}/g,
  // Standards and names that contain digits.
  /token-?2022|web ?3|24\/7|\b[a-z]{2,6}-\d{2,5}\b/giu,
  // Times of day, ISO timestamps, numeric and CJK dates.
  /\d{4}-\d{2}-\d{2}(?:[t\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?z?)?/giu,
  /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:am|pm|utc|gmt|cet|cest|msk|jst|et|pt))?(?!\d)/giu,
  /(?<!\d)\d{1,2}[./]\d{1,2}[./]\d{2,4}(?!\d)/g,
  /\d{1,4}\s?(?:年|月|日|년|월|일)/gu,
  // Durations in hours ("24-hour volume") describe a window, not a Seasons quantity.
  /(?<![\p{N}.,])\d{1,3}[- ]?(?:hours?|hrs?|h|час\p{L}*|stunden?|horas?|時間)(?![\p{L}])/giu,
  // List markers at the start of a line.
  /^\s*(?:[-*•]\s*)?\(?\d{1,2}[.)](?=\s)/gmu,
];
// Day of month next to a month name; the year that follows is caught as a year.
const DAY_BEFORE_MONTH = new RegExp(
  `(?<![\\p{L}\\p{N}])(\\d{1,2})(?:st|nd|rd|th|\\.)?\\s+(?:of\\s+|de\\s+)?(?:${MONTHS})(?![\\p{L}])`,
  "giu",
);
const DAY_AFTER_MONTH = new RegExp(
  `(?<![\\p{L}])(?:${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\p{N}])`,
  "giu",
);

const MAGNITUDES: Array<[RegExp, number]> = [
  [/^\s?(?:trillion|trillions|трлн|billionen|billones|兆|조)(?![\p{L}])/iu, 1e12],
  [
    /^\s?(?:billion|billions|bn|млрд|mrd\.?|milliarden?|mil millones|miliardi?|milliards?)(?![\p{L}])/iu,
    1e9,
  ],
  [/^\s?(?:million|millions|mn|mln|млн|mio\.?|millionen|millones|milioni?)(?![\p{L}])/iu, 1e6],
  [/^\s?(?:thousand|thousands|тыс\.?|tsd\.?|mil)(?![\p{L}])/iu, 1e3],
  [/^(?:億|亿|억)/u, 1e8],
  [/^(?:万|萬|만)/u, 1e4],
  [/^千/u, 1e3],
  [/^B(?![\p{L}])/u, 1e9],
  [/^M(?![\p{L}])/u, 1e6],
  [/^[kK](?![\p{L}])/u, 1e3],
  [/^m(?![\p{L}])/u, 1e6],
];

const APPROX =
  /(?:about|around|roughly|approximately|approx\.?|nearly|almost|some|over|under|more than|less than|up to|at least|~|≈|около|примерно|почти|более|свыше|порядка|etwa|rund|ungefähr|fast|circa|ca\.|über|unos|unas|alrededor de|aproximadamente|casi|más de|約|およそ|ほぼ)\s*(?:\$|us\$)?\s*$/iu;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

interface Core {
  value: number;
  decimals: number;
  alts: number[];
}

/** Read one numeric core with its separators. Returns several values for "1,2,3"-style lists. */
function readCore(core: string): Core[] {
  const seps = core.match(/[.,\s]/g) ?? [];
  const groups = core.split(/[.,\s]/);
  if (!seps.length) return [{ value: Number(core), decimals: 0, alts: [] }];
  const kinds = new Set(seps.map((s) => (/\s/.test(s) ? " " : s)));
  const last = seps[seps.length - 1]!;
  const lastGroup = groups[groups.length - 1]!;
  const tail3 = groups.slice(1).every((g) => g.length === 3);
  if (kinds.size === 1) {
    const sep = [...kinds][0]!;
    if (sep === " ") return [{ value: Number(groups.join("")), decimals: 0, alts: [] }];
    if (seps.length > 1) {
      if (tail3) return [{ value: Number(groups.join("")), decimals: 0, alts: [] }];
      return groups.map((g) => ({ value: Number(g), decimals: 0, alts: [] }));
    }
    const int = groups[0]!;
    const frac = lastGroup;
    const asDecimal = Number(`${int}.${frac}`);
    if (frac.length === 3 && int.length <= 3 && int !== "0") {
      // "1,000" (en) vs "1,000" (de, = 1); "1.000" (de, = 1000) vs "1.000" (en, = 1).
      const asThousands = Number(`${int}${frac}`);
      return sep === ","
        ? [{ value: asThousands, decimals: 0, alts: [asDecimal] }]
        : [{ value: asDecimal, decimals: 3, alts: [asThousands] }];
    }
    return [{ value: asDecimal, decimals: frac.length, alts: [] }];
  }
  // Mixed: the last separator is the decimal mark ("1,000.50", "1.000,50").
  const intPart = core.slice(0, core.lastIndexOf(last)).replace(/[.,\s]/g, "");
  return [{ value: Number(`${intPart}.${lastGroup}`), decimals: lastGroup.length, alts: [] }];
}

function maskedForNumbers(sentence: string): string {
  let s = asciiDigits(sentence.normalize("NFKC"));
  if (s.length !== sentence.length) s = asciiDigits(sentence);
  const ranges: Array<[number, number]> = [];
  for (const re of NON_QUANTITY)
    for (const m of s.matchAll(re)) ranges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  for (const re of [DAY_BEFORE_MONTH, DAY_AFTER_MONTH]) {
    for (const m of s.matchAll(re)) {
      const day = m[1]!;
      const month = m[0].replace(day, "");
      // "May" is a month only when capitalised; "10 may apply" is a number.
      if (
        /^\W*may\W*$/.test(month.replace(/(?:st|nd|rd|th|of|de|\.|\s)/gi, "")) &&
        !/May/.test(m[0])
      )
        continue;
      const at = (m.index ?? 0) + m[0].indexOf(day);
      ranges.push([at, at + day.length]);
    }
  }
  return mask(s, ranges);
}

/** Every quantity in a sentence, with position and precision (years, dates, times excluded). */
export function scanNumbers(sentence: string): ScannedNumber[] {
  const s = maskedForNumbers(sentence);
  const out: ScannedNumber[] = [];
  const re = /(?:\d{1,3}(?:\s\d{3})+(?!\d))|\d+(?:[.,]\d+)*/g;
  for (const m of s.matchAll(re)) {
    const start = m.index ?? 0;
    const prev = s[start - 1] ?? "";
    if (/[\p{L}\p{N}_]/u.test(prev) && !CJK.test(prev)) continue;
    if (prev === "." || prev === ",") {
      if (/\d/.test(s[start - 2] ?? "")) continue;
    }
    if (/[A-Za-z]-$/.test(s.slice(Math.max(0, start - 2), start))) continue;

    let end = start + m[0].length;
    let rest = s.slice(end);
    let magnitude = 1;
    for (const [mre, mag] of MAGNITUDES) {
      const mm = mre.exec(rest);
      if (mm) {
        magnitude = mag;
        end += mm[0].length;
        rest = s.slice(end);
        break;
      }
    }
    let unit: NumUnit | undefined;
    let um: RegExpExecArray | null;
    if ((um = /^\s?%/.exec(rest))) unit = "%";
    else if (
      (um =
        /^\s?(?:bps|bp|basis points?|б\.?\s?п\.?|basispunkte?|puntos básicos)(?![\p{L}])/iu.exec(
          rest,
        ))
    )
      unit = "bps";
    else if ((um = /^[x×х](?![\p{L}\p{N}])/u.exec(rest))) unit = "x";
    else if ((um = /^\s?(?:\$\s?seas|seas|сизонс\p{L}*)(?![\p{L}])/iu.exec(rest))) unit = "seas";
    else if ((um = /^\s?(?:usdc?|dollars?|долл\p{L}*|dollar|dólares)(?![\p{L}])/iu.exec(rest)))
      unit = "usd";
    else um = /^(?:st|nd|rd|th)(?![\p{L}])/u.exec(rest);
    if (um) {
      end += um[0].length;
      rest = s.slice(end);
    }
    const next = rest[0] ?? "";
    if (/\p{L}/u.test(next) && !CJK.test(next) && !/\s/.test(s[end - 1] ?? "")) continue;
    const before = s.slice(Math.max(0, start - 3), start);
    if (!unit && /\$\s?$|us\$\s?$/i.test(before)) unit = "usd";

    const cores = readCore(m[0]);
    const approx = APPROX.test(s.slice(Math.max(0, start - 24), start));
    const negative =
      /(?:^|[\s(])[-−]$/.test(s.slice(Math.max(0, start - 2), start)) &&
      !/\d\s*[-−]$/.test(s.slice(Math.max(0, start - 3), start));
    for (const core of cores) {
      if (!Number.isFinite(core.value)) continue;
      const isYear =
        cores.length === 1 &&
        /^\d{4}$/.test(m[0]) &&
        core.value >= 2024 &&
        core.value <= 2031 &&
        magnitude === 1 &&
        !unit;
      if (isYear) continue;
      const sign = negative ? -1 : 1;
      out.push({
        value: sign * core.value * magnitude,
        raw: sentence.slice(start, end).trim() || m[0],
        unit,
        start,
        end,
        decimals: core.decimals,
        magnitude,
        approx,
        alts: core.alts.map((a) => sign * a * magnitude),
      });
    }
  }
  // Ranges share a unit and magnitude: "5.76–12.17%", "2–4M".
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i]!;
    const b = out[i + 1]!;
    const between = s.slice(a.end, b.start);
    if (!/^\s*(?:[-–—]|to|bis|до|a|〜|~)\s*$/iu.test(between)) continue;
    if (!a.unit && b.unit) a.unit = b.unit;
    if (a.magnitude === 1 && b.magnitude > 1) {
      a.value *= b.magnitude;
      a.alts = a.alts.map((v) => v * b.magnitude);
      a.magnitude = b.magnitude;
    }
  }
  return out;
}

/** The quantities in a sentence (what numeric provenance checks). */
export function parseNumbers(sentence: string): ParsedNumber[] {
  return scanNumbers(sentence).map(({ value, raw, unit }) =>
    unit ? { value, raw, unit } : { value, raw },
  );
}

// --- matching ----------------------------------------------------------------------------

interface Candidate {
  value: number;
  step: number;
}

/** Readings of a written number: 10% ≡ 0.1 ≡ 1000 bps. */
function candidates(n: ScannedNumber): Candidate[] {
  const v = Math.abs(n.value);
  let step = Math.pow(10, -n.decimals) * n.magnitude;
  // "about 25,000": trailing zeros after an approximation mark are rounding.
  if (n.approx && n.decimals === 0) {
    const digits = String(Math.round(v / n.magnitude));
    const zeros = digits.length - digits.replace(/0+$/, "").length;
    if (zeros) step *= Math.pow(10, Math.min(zeros, digits.length - 1));
  }
  const out: Candidate[] = [
    { value: v, step },
    ...n.alts.map((a) => ({
      value: Math.abs(a),
      step: Math.abs(a) < v ? step / 1000 : step * 1000,
    })),
  ];
  if (n.unit === "%")
    out.push({ value: v / 100, step: step / 100 }, { value: v * 100, step: step * 100 });
  else if (n.unit === "bps")
    out.push({ value: v / 100, step: step / 100 }, { value: v / 10000, step: step / 10000 });
  else if (!n.unit && v <= 1)
    out.push({ value: v * 100, step: step * 100 }, { value: v * 10000, step: step * 10000 });
  return out;
}

function close(c: Candidate, r: number): boolean {
  const rr = Math.abs(r);
  if (c.value === rr) return true;
  const rel = Math.abs(c.value - rr) / Math.max(c.value, rr);
  if (rel <= 0.006) return true;
  return Math.abs(c.value - rr) <= c.step / 2 + 1e-9 * Math.max(1, c.step);
}

/** Does a written number match any of the vouched-for numbers? */
export function numberMatches(n: ScannedNumber, allowed: number[]): boolean {
  const cands = candidates(n);
  return allowed.some((r) => Number.isFinite(r) && cands.some((c) => close(c, r)));
}
