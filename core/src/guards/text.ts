/**
 * Text normalisation shared by the input guards (L0) and the output verifier
 * (L6). The display text is only NFKC-normalised and cleaned; the confusable
 * "skeleton" is for detection only and keeps a 1:1 length with its input, so a
 * hit found on the skeleton can be located in the original.
 */

const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
// Zero-width, soft hyphen, Mongolian vowel separator, LRM/RLM/ALM marks.
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff\u00ad\u180e\u200e\u200f\u061c]/g;
// Variation selectors carry "emoji smuggling" payloads; losing one on an emoji is harmless.
const VARIATION = /[︀-️\u{E0100}-\u{E01EF}]/gu;

export interface NormalizedInput {
  text: string;
  /** ASCII hidden in Unicode tag characters (U+E0020–E007E), decoded for scanning only. */
  hidden: string;
  flags: { tags: boolean; bidi: boolean; zeroWidthInWord: boolean; variationRun: boolean };
}

/** Eastern Arabic and Persian digits become ASCII, so every parser sees one digit set. */
export function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => {
    const cp = d.charCodeAt(0);
    return String(cp >= 0x06f0 ? cp - 0x06f0 : cp - 0x0660);
  });
}

export function collapseWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strip invisible characters and NFKC-normalise; keeps line structure. */
export function cleanText(raw: string): string {
  return asciiDigits(
    raw
      .replace(TAG_CHARS, "")
      .replace(BIDI_CONTROLS, "")
      .replace(ZERO_WIDTH, "")
      .replace(VARIATION, "")
      .normalize("NFKC"),
  );
}

export function normalizeInput(raw: string): NormalizedInput {
  let hidden = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xe0020 && cp <= 0xe007e) hidden += String.fromCharCode(cp - 0xe0000);
  }
  const flags = {
    tags: /[\u{E0000}-\u{E007F}]/u.test(raw),
    bidi: /[‪-‮⁦-⁩]/.test(raw),
    // Only inside Latin/Cyrillic words: ZWJ/ZWNJ are legitimate in Persian, Indic scripts and emoji.
    zeroWidthInWord:
      /[A-Za-z\u00c0-\u024f\u0400-\u04ff][\u200b-\u200d\u2060\ufeff\u00ad\u180e]+[A-Za-z\u00c0-\u024f\u0400-\u04ff]/.test(
        raw,
      ),
    variationRun: /[\u{E0100}-\u{E01EF}]{2,}|[︀-️]{3,}/u.test(raw),
  };
  return { text: collapseWhitespace(cleanText(raw)), hidden, flags };
}

// --- confusable skeleton ------------------------------------------------------------

const CYR_TO_LAT: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  һ: "h",
  ӏ: "l",
  ү: "y",
  ɡ: "g",
};
const GREEK_TO_LAT: Record<string, string> = {
  α: "a",
  β: "b",
  γ: "y",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ω: "w",
  ς: "s",
  ϲ: "c",
  μ: "u",
};
const OTHER_TO_LAT: Record<string, string> = {
  ı: "i",
  ȷ: "j",
  ɑ: "a",
  ɩ: "i",
  ʟ: "l",
  օ: "o",
  ս: "u",
  ɵ: "o",
  ᴀ: "a",
  ᴄ: "c",
  ᴏ: "o",
};
const LAT_TO_CYR: Record<string, string> = {
  a: "а",
  b: "в",
  c: "с",
  e: "е",
  h: "н",
  k: "к",
  m: "м",
  o: "о",
  p: "р",
  t: "т",
  x: "х",
  y: "у",
};
const LEET_LAT: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
};
const LEET_CYR: Record<string, string> = { "0": "о", "3": "з", "4": "ч", "6": "б" };
// Number-with-unit tokens are quantities, not leetspeak ("10x", "1000bps", "3rd").
const UNIT_TOKEN = /^\d+(?:[.,]\d+)?(?:x|k|m|b|bn|mn|bps|st|nd|rd|th)?$/;

const isLatinLetter = (c: string) => /[a-zß-ɏ]/.test(c);
const isCyrillic = (c: string) => /[Ѐ-ӿ]/.test(c);
const isGreek = (c: string) => /[Ͱ-Ͽ]/.test(c);

/** Lower-case one code unit at a time, so the result has the input's length. */
export function lower1to1(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = c.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdfff) {
      out += c;
      continue;
    }
    const l = c.toLowerCase();
    out += l.length === 1 ? l : c;
  }
  // Curly apostrophes inside words become ASCII so "don’t" matches "don't".
  return out.replace(/(?<=\p{L})[’ʼ](?=\p{L})/gu, "'");
}

/**
 * Detection skeleton: lower-case; per token, look-alike letters are mapped to
 * the token's dominant script (Cyrillic tokens stay Cyrillic, so Russian
 * patterns still match), and leetspeak digits are read as letters.
 */
export function skeleton(s: string): string {
  const low = lower1to1(s);
  // Tokens are Latin/Cyrillic/Greek/Armenian runs only: digits next to kana or Han ("100%安全") are not leetspeak.
  return low.replace(
    /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{M}\p{N}@]+/gu,
    (tok) => {
      let lat = 0;
      let cyr = 0;
      let letters = 0;
      for (const c of tok) {
        if (isLatinLetter(c)) lat++;
        else if (isCyrillic(c)) cyr++;
        else if (isGreek(c)) lat++;
        if (/\p{L}/u.test(c)) letters++;
      }
      const leet = letters > 0 && !UNIT_TOKEN.test(tok);
      const toCyr = cyr > lat;
      let out = "";
      for (let i = 0; i < tok.length; i++) {
        const c = tok[i]!;
        let m: string | undefined;
        if (toCyr) m = LAT_TO_CYR[c] ?? (leet ? LEET_CYR[c] : undefined);
        else
          m =
            CYR_TO_LAT[c] ?? GREEK_TO_LAT[c] ?? OTHER_TO_LAT[c] ?? (leet ? LEET_LAT[c] : undefined);
        out += m ?? c;
      }
      return out;
    },
  );
}

/** Collapse letter-spaced runs ("i g n o r e", "S.E.A.S") into words. Not length-preserving. */
export function despace(s: string): string {
  return s.replace(/(?<![\p{L}\p{N}])\p{L}(?:[ .\-_*·•|/]{1,3}\p{L}(?![\p{L}\p{N}])){3,}/gu, (m) =>
    m
      .split(/[ .\-_*·•|]{2,}|\s*\/\s*/)
      .map((w) => w.replace(/[ .\-_*·•|]/g, ""))
      .filter(Boolean)
      .join(" "),
  );
}

export const hasLetterSpacing = (s: string) => despace(s) !== s;

// --- quotes --------------------------------------------------------------------------

const PAIRS: Record<string, string[]> = {
  '"': ['"'],
  "“": ["”", "“"],
  "„": ["“", "”"],
  "«": ["»"],
  "‹": ["›"],
  "「": ["」"],
  "『": ["』"],
  "‘": ["’"],
  "'": ["'"],
  "‚": ["‘", "’"],
};

/** Spans [open, close] of quoted text; apostrophes inside words are not quotes. */
export function quoteSpans(s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const closers = PAIRS[c];
    if (!closers) continue;
    const single = c === "'" || c === "‘" || c === "‚";
    if (single) {
      const prev = s[i - 1];
      const next = s[i + 1];
      if ((prev && /[\p{L}\p{N}]/u.test(prev)) || !next || /\s/.test(next)) continue;
    }
    let j = i + 1;
    for (; j < s.length && j - i < 400; j++) {
      const d = s[j]!;
      if (!closers.includes(d)) continue;
      if (single || d === "’") {
        const after = s[j + 1];
        const before = s[j - 1];
        // "don't" inside the quote: an apostrophe between letters is not the closer.
        if (after && /\p{L}/u.test(after)) continue;
        if (before && /\s/.test(before)) continue;
      }
      break;
    }
    if (j < s.length && j - i < 400 && closers.includes(s[j]!)) {
      spans.push([i, j]);
      i = j;
    }
  }
  return spans;
}

export const insideQuote = (spans: Array<[number, number]>, start: number, end: number) =>
  spans.some(([a, b]) => a < start && end <= b + 1);

// --- claim scoping: negation, clauses, disavowal ----------------------------------------

const B = "(?<![\\p{L}\\p{N}'])";
const E = "(?![\\p{L}\\p{N}])";

const NEGATION = new RegExp(
  `${B}(?:not|no|never|nothing|nobody|none|neither|nor|without|cannot|can't|won't|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|hasn't|haven't|hadn't|shouldn't|wouldn't|couldn't|mustn't|needn't|ain't|no one|no-one|hardly|rather than|instead of|far from|whether|refuse[sd]?|nicht|kein|keine|keinen|keiner|keinem|keines|nie|niemals|niemand|nichts|ohne|weder|ob|nunca|jamás|jamas|nadie|nada|ningún|ningun|ninguna|ninguno|sin|tampoco|ni|non|mai|nessun|nessuno|niente|senza|ne|pas|jamais|aucun|aucune|rien|sans|não|nao|nenhum|nenhuma|sem|ninguém|не|нет|ни|никто|ничего|ничто|никогда|нигде|никак|никакой|никакие|никакого|никаких|без|нельзя|вряд|ли)${E}`,
  "u",
);
const JA_NEG_AFTER =
  /^[^。！？!?\n]{0,14}?(?:ない|ません|ず|ぬ|無い|なし|無し|じゃな|ではな|できな|かどうか|わけではな)/;
const JA_NEG_BEFORE = /(?:何も|誰も|決して|一切|どうか)[^。！？!?\n]{0,10}$/;

const DISAVOW = new RegExp(
  `${B}(?:wrong|false|incorrect|untrue|inaccurate|misleading|outdated|out of date|out-of-date|not true|isn't true|myth|flagged|errata|retracted|red flag|warning sign|неверн\\p{L}*|неправд\\p{L}*|ошибочн\\p{L}*|устарел\\p{L}*|ложн\\p{L}*|falsch\\p{L}*|veraltet\\p{L}*|irreführend\\p{L}*|stimmt nicht|unzutreffend|fals[oa]s?|incorrect[oa]s?|erróne[oa]s?|engaños[oa]s?|desactualizad[oa]s?|no es cierto)|誤り|間違い|古い|正しくな|正しくありません|不正確|誤解を招`,
  "u",
);

const REPORT_FRAME = new RegExp(
  `${B}(?:say|says|said|saying|claim|claims|claimed|claiming|suggest|suggests|suggested|state|states|stated|promis\\p{L}*|offer\\p{L}*|copy|line|wording|docs|website|someone|anyone|anybody|whoever|говор\\p{L}*|пишут|утвержд\\p{L}*|обеща\\p{L}*|sagen|sagt|behaupt\\p{L}*|versprech\\p{L}*|dicen|dice|afirma\\p{L}*|promet\\p{L}*)${E}|と(?:言|書)|という`,
  "u",
);

// A clause starts after hard punctuation, a contrastive conjunction, or a comma
// that opens a new subject ("No, the APY is…"). A plain list comma does not
// reset scope, so "Nothing is fixed, promised or guaranteed" stays negated.
const NEW_SUBJECT =
  "(?:the|it|this|that|these|those|they|we|you|i|he|she|there|your|our|its|their|seasons|\\$seas|yes|payouts|fees|it's|that's|there's|here's|я|мы|вы|ты|он|она|оно|они|это|да|die|der|das|es|sie|wir|ich|du|er|ja|el|la|los|las|esto|eso|yo|tú|usted|sí)";
const CLAUSE_BOUNDARY = new RegExp(
  `[;()\\[\\]!?\\u2014]|\\s[\\u2013-]\\s|(?<!\\d):|,(?=\\s*(?:and\\s+|but\\s+|so\\s+|yet\\s+|и\\s+|а\\s+|но\\s+|und\\s+|aber\\s+|y\\s+|pero\\s+)?${NEW_SUBJECT}${E})|${B}(?:but|however|yet|although|though|while|whereas|so|because|но|однако|зато|поэтому|хотя|потому|aber|jedoch|sondern|obwohl|deshalb|pero|sino|aunque|porque)${E}|${B}(?:and|и|und|y)(?=\\s+${NEW_SUBJECT}${E})|[。！？、]`,
  "gu",
);

function lastBoundaryEnd(s: string, before: number, from = 0): number {
  const re = new RegExp(CLAUSE_BOUNDARY.source, "gu");
  let end = from;
  const part = s.slice(0, before);
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(part))) {
    end = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  return end;
}

const wordCount = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;

/** Start of the clause that contains position `pos`. */
export function clauseStart(s: string, pos: number): number {
  let start = lastBoundaryEnd(s, pos);
  // "…, is guaranteed": a clause with no subject of its own inherits the previous one.
  if (start > 0 && wordCount(s.slice(start, pos)) <= 2)
    start = lastBoundaryEnd(s, Math.max(0, start - 1));
  return start;
}

/** End of the clause that contains position `pos`. */
export function clauseEnd(s: string, pos: number): number {
  const re = new RegExp(CLAUSE_BOUNDARY.source, "gu");
  re.lastIndex = pos;
  const m = re.exec(s);
  return m ? m.index : s.length;
}

/** The last `n` word tokens before `pos` (start index). */
function tokenWindowStart(s: string, pos: number, n: number): number {
  const words = [...s.slice(0, pos).matchAll(/[\p{L}\p{N}'$%]+/gu)];
  if (words.length <= n) return 0;
  return words[words.length - n]!.index ?? 0;
}

// ", not the whole protocol," is an aside about another noun, not a negation of the predicate.
const APPOSITIVE_NEGATION = /,\s*(?:but not|and not|not|не|nicht|no)\s[^,;.:]{1,40},/gu;
export const maskAppositives = (s: string) =>
  s.replace(APPOSITIVE_NEGATION, (m) => " ".repeat(m.length));

/** True when a negation cue governs the text right before the hit (within its clause). */
export function negatedBefore(text: string, hitStart: number): boolean {
  const s = maskAppositives(text);
  const from = Math.max(clauseStart(s, hitStart), tokenWindowStart(s, hitStart, 12));
  const window = s.slice(from, hitStart);
  if (NEGATION.test(window)) return true;
  return JA_NEG_BEFORE.test(window);
}

/** Japanese (and German V2) put the negation after the predicate. */
export function negatedAfter(s: string, hitEnd: number, germanWords = false): boolean {
  const rest = s.slice(hitEnd);
  if (JA_NEG_AFTER.test(rest)) return true;
  if (germanWords)
    return /^\s*(?:[\p{L}]+\s+){0,2}?(?:nicht|nichts|kein\p{L}*)(?![\p{L}])/u.test(rest);
  return false;
}

export const hasNegation = (s: string) => NEGATION.test(s) || /ません|ない|ではな/.test(s);
export const hasDisavowal = (s: string) => DISAVOW.test(s);
export const hasReportFrame = (s: string) => REPORT_FRAME.test(s);

export interface ScopeOptions {
  /** Quoted text that repeats the user's own words is an echo, not a claim. */
  userText?: string;
  /** Quoted hits need an explicit rejection (price targets). */
  quoteNeedsRejection?: boolean;
  /** Also look for a negation after the hit (Japanese / German word order). */
  germanAfter?: boolean;
}

/**
 * Is this lexicon hit something GAIA does NOT assert? Negated in its clause,
 * or quoted and rejected / echoed, or reported and disavowed.
 */
// "Guaranteed returns are a red flag": the claim is being warned against, not made.
const WARNING =
  /red flag|warning sign|sign of a scam|hallmark of a scam|classic scam|красный флаг|тревожный (?:признак|сигнал)|признак мошенничества|warnsignal|alarmzeichen|señal de alarma|bandera roja|危険信号|詐欺のサイン/u;

export function claimNeutralised(
  sentence: string,
  hitStart: number,
  hitEnd: number,
  opts: ScopeOptions = {},
): boolean {
  if (negatedBefore(sentence, hitStart)) return true;
  if (!opts.quoteNeedsRejection && WARNING.test(sentence)) return true;
  if (negatedAfter(sentence, hitEnd, opts.germanAfter)) return true;
  const spans = quoteSpans(sentence);
  if (insideQuote(spans, hitStart, hitEnd)) {
    if (hasDisavowal(sentence) || hasNegation(sentence)) return true;
    if (!opts.quoteNeedsRejection && opts.userText) {
      const span = spans.find(([a, b]) => a < hitStart && hitEnd <= b + 1);
      if (span) {
        const quoted = sentence.slice(span[0] + 1, span[1]).trim();
        if (quoted && skeleton(opts.userText).includes(quoted)) return true;
      }
    }
    return false;
  }
  const before = sentence.slice(0, hitStart);
  if (hasReportFrame(before) && hasDisavowal(sentence)) return true;
  return false;
}

// --- misc -----------------------------------------------------------------------------

export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Replace [start, end) ranges with spaces, keeping indices stable. */
export function mask(s: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return s;
  const chars = s.split("");
  for (const [a, b] of ranges) for (let i = a; i < b && i < chars.length; i++) chars[i] = " ";
  return chars.join("");
}
