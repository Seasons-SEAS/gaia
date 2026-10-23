/**
 * L6: deterministic output checks. The verifier checks
 * claims, not topics, and every check can be satisfied by an honest answer.
 * It returns the draft with auto-fixes ($SEAS spelling, defanged non-registry
 * domains) plus violations; the pipeline decides repair or template.
 */
import {
  extractBase58,
  extractEmails,
  extractHandles,
  extractLinks,
  type FoundLink,
} from "../guards/extract";
import { SEASONS_ANCHOR } from "../guards/floors";
import { decodeBase64Text } from "../guards/injection";
import { defang, matchLink } from "../guards/registry";
import { detectSecrets } from "../guards/secrets";
import {
  claimNeutralised,
  cleanText,
  clauseEnd,
  clauseStart,
  despace,
  lower1to1,
  quoteSpans,
  skeleton,
} from "../guards/text";

import {
  CONCEDE,
  HOSTILE_LABEL,
  ROT13_CLAIM_WORDS,
  RULES,
  SEASONS_CLAIM_WORDS,
  type LexRule,
} from "./lexicon";
import { numberMatches, scanNumbers, splitSentences } from "./numbers";

import type { RegistryEntry, VerifyContext, VerifyResult, Violation } from "../types";

export {
  parseNumbers,
  scanNumbers,
  splitSentences,
  type NumUnit,
  type ParsedNumber,
} from "./numbers";
export { RULES as LEXICON_RULES } from "./lexicon";

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

/** Names Seasons or one of its own objects: always a "Seasons sentence". */
const STRONG = new RegExp(
  `\\$\\s?seas|${B}seas${E}|${B}seasons${E}|сизонс\\p{L}*|シーズンズ|${B}(?:nodes?|directors?|builders?|нод\\p{L}*|узл\\p{L}*|директор\\p{L}*|билдер\\p{L}*|nodos?)${E}|ノード|ディレクター|ビルダー`,
  "u",
);
/** Seasons-type quantities; they count when the answer is about Seasons. */
const WEAK = new RegExp(
  `${B}(?:apy|apr|yields?|payouts?|paid out|distributions?|distributed|rounds?|fees?|tax(?:es)?|thresholds?|tiers?|supply|locks?|locked|unlocks?|unlocked|time-?locks?|escrows?|circulating|market cap|mcap|withheld|epochs?|allocations?|treasury|basket)${E}` +
    `|доходност\\p{L}*|выплат\\p{L}*|распредел\\p{L}*|раунд\\p{L}*|комисси\\p{L}*|налог\\p{L}*|порог\\p{L}*|эмисси\\p{L}*|разблокир\\p{L}*|заблокир\\p{L}*|блокировк\\p{L}*` +
    `|rendite\\p{L}*|ausschüttung\\p{L}*|auszahlung\\p{L}*|verteilung\\p{L}*|runde\\p{L}*|gebühr\\p{L}*|steuer\\p{L}*|schwelle\\p{L}*|sperr\\p{L}*|entsperr\\p{L}*` +
    `|rendimiento\\p{L}*|${B}pagos?${E}|distribuci\\p{L}*|ronda\\p{L}*|comisi\\p{L}*|impuesto\\p{L}*|umbral\\p{L}*|suministro|bloque\\p{L}*|desbloque\\p{L}*` +
    `|利回り|年利|配当|支払|分配|ラウンド|手数料|税|閾値|しきい値|ティア|供給|ロック|アンロック`,
  "u",
);
const OTHER_ASSET = new RegExp(
  `${B}(?:bitcoin|btc|ether(?:eum)?|eth|solana|sol|usdc|usdt|tether|stocks?|shares|s&p|nasdaq|dogecoin|doge|bonk|jup|биткоин\\p{L}*|эфир\\p{L}*|aktien?|acciones)${E}|ビットコイン|イーサリアム`,
  "u",
);
const SEAS_TICKER = /(?<![\p{L}\p{N}$#@_-])SEAS(?![\p{L}\p{N}_])/u;
const SEAS_TICKER_ALL = new RegExp(SEAS_TICKER.source, "gu");
/** Another asset, or a bank product: general-knowledge sentences about them are not Seasons claims. */
const OTHER_OR_BANK = new RegExp(
  `${OTHER_ASSET.source}|${B}(?:banks?|savings|treasur\\p{L}*|t-bills?|bonds?|cds?|fdic|deposit insurance|банк\\p{L}*|вклад\\p{L}*|облигаци\\p{L}*|sparkonto|anleihe\\p{L}*|banco\\p{L}*|bonos?|ahorro\\p{L}*)${E}|銀行|国債|預金`,
  "u",
);

interface Sentence {
  raw: string;
  /** NFKC, invisible characters removed. */
  D: string;
  /** Lower-case, 1:1 with D. */
  L: string;
  /** Detection skeleton, 1:1 with D. */
  K: string;
  question: boolean;
  /** K with letter-spaced runs collapsed (computed once; not 1:1). */
  Kd: string;
}

function prepare(raw: string): Sentence {
  let D = cleanText(raw);
  let L = lower1to1(D);
  let K = skeleton(D);
  if (L.length !== D.length || K.length !== D.length) {
    // Should not happen; keep indices safe rather than mis-locate a hit.
    D = raw;
    L = lower1to1(raw);
    K = skeleton(raw);
  }
  return { raw, D, L, K, question: /[?？]\s*["'”’»)\]]*\s*$/.test(raw.trim()), Kd: despace(K) };
}

const strictMode = (ctx: VerifyContext) =>
  ctx.mode === "sensitive_financial" || ctx.mode === "trust_question" || Boolean(ctx.pinned);

function nearMatch(
  text: string,
  start: number,
  end: number,
  near: NonNullable<LexRule["near"]>,
): boolean {
  const words = [...text.matchAll(/[\p{L}\p{N}'$%]+/gu)];
  let before = 0;
  let after = text.length;
  const idxBefore = words.filter((w) => (w.index ?? 0) + w[0].length <= start);
  if (idxBefore.length > near.tokens)
    before = idxBefore[idxBefore.length - near.tokens]!.index ?? 0;
  if (near.side === "before") after = end;
  else {
    const idxAfter = words.filter((w) => (w.index ?? 0) >= end);
    if (idxAfter.length > near.tokens) {
      const last = idxAfter[near.tokens - 1]!;
      after = (last.index ?? 0) + last[0].length;
    }
  }
  // The hit itself may carry the subject ("a fixed APY").
  return near.re.test(text.slice(before, after));
}

function seasonsContext(s: Sentence, draftMentionsSeasons: boolean): boolean {
  if (
    STRONG.test(s.K) ||
    SEAS_TICKER.test(s.D) ||
    /(?<![\p{L}])(?:token|this token|your tokens|токен\p{L}*|トークン)(?![\p{L}])/u.test(s.K)
  )
    return true;
  return draftMentionsSeasons && !OTHER_ASSET.test(s.K);
}

/** The subject side of the hit (the words before it) is another asset or a bank product, not Seasons. */
function aboutOther(s: Sentence, hitStart: number): boolean {
  const words = [...s.K.slice(0, hitStart).matchAll(/[\p{L}\p{N}'$%&-]+/gu)];
  const from = words.length > 8 ? (words[words.length - 8]!.index ?? 0) : 0;
  const before = s.K.slice(from, hitStart);
  return OTHER_OR_BANK.test(before) && !STRONG.test(before);
}

/** Lexicon hits in one sentence that GAIA actually asserts. */
function lexiconHits(
  s: Sentence,
  rules: LexRule[],
  ctx: VerifyContext,
  draftMentionsSeasons: boolean,
  forSuggestion: boolean,
): Array<{ rule: LexRule; hit: string }> {
  const out: Array<{ rule: LexRule; hit: string }> = [];
  const seen = new Set<string>();
  const variants: Array<{ L: string; K: string }> = [{ L: s.L, K: s.K }];
  // Letter-spaced output ("g u a r a n t e e d") is read as words too.
  if (s.Kd !== s.K) variants.push({ L: despace(s.L), K: s.Kd });

  for (const rule of rules) {
    if (seen.has(rule.id)) continue;
    if (rule.assertOnly && s.question) continue;
    if (rule.seasons && !seasonsContext(s, draftMentionsSeasons)) continue;
    for (const v of variants) {
      const text = rule.on === "L" ? v.L : v.K;
      let hitFound = false;
      // matchAll clones the (global) rule regex, so shared rules keep no state between calls.
      for (const m of text.matchAll(rule.re)) {
        const hs = m.index ?? 0;
        const he = hs + m[0].length;
        if (
          rule.minCapture !== undefined &&
          m[1] !== undefined &&
          !(Number(m[1].replace(",", ".")) > rule.minCapture)
        )
          continue;
        if (rule.exceptAfter && rule.exceptAfter.test(text.slice(he))) continue;
        if (rule.notOther && aboutOther({ ...s, K: v.K }, hs)) continue;
        if (rule.near && !nearMatch(v.K, hs, he, rule.near)) continue;
        if (rule.clauseSubject) {
          const cs = clauseStart(v.K, hs);
          const ce = clauseEnd(v.K, he);
          if (!rule.clauseSubject.test(v.K.slice(cs, ce))) continue;
        }
        if (rule.exceptBefore && rule.exceptBefore.test(v.K.slice(Math.max(0, hs - 80), hs)))
          continue;
        if (
          rule.gapNegation &&
          /(?<![\p{L}])(?:not|no|never|isn't|aren't|не|нет|nicht|kein\p{L}*|no|nunca)(?![\p{L}])|ません|ない/u.test(
            m[0],
          )
        )
          continue;
        if (
          rule.attribution &&
          /(?:says|states|stated|has said|according to|per the|policy|pinned post|пишет|заявля\p{L}*|по словам|laut|según)/u.test(
            v.K,
          )
        )
          continue;
        if (
          claimNeutralised(v.K, hs, he, {
            userText: ctx.userText,
            quoteNeedsRejection: rule.check === "price_target",
            germanAfter: rule.germanAfter,
          })
        )
          continue;
        // A question that only repeats the user's own words ("Will it 10x?") is an echo.
        if (!forSuggestion && s.question && skeleton(ctx.userText).includes(v.K.slice(hs, he)))
          continue;
        hitFound = true;
        // Positions map to D only on the 1:1 variant; the de-spaced one reports its own text.
        out.push({ rule, hit: (v.K === s.K ? s.D.slice(hs, he) : text.slice(hs, he)) || m[0] });
        break;
      }
      if (hitFound) {
        seen.add(rule.id);
        break;
      }
    }
  }
  return out;
}

// --- audit claims (custom: scope decides) -----------------------------------------------------

const AUDITED =
  /(?<![\p{L}])(?:audited|audit-?grade|security[- ]reviewed|security[- ]audited|been audited|аудирован\p{L}*|прош[её]л\p{L}* аудит\p{L}*|прошли аудит|auditiert\p{L}*|auditad[oa]s?)(?![\p{L}])|監査済み|監査を受け(?:ました|ている|た)|監査されて(?:います|いる)|監査された/gu;
const AUDIT_ENTITY =
  /(?<![\p{L}])(?:seasons|\$seas|seas|protocol|token|contracts?|programs?|it|everything|project|distributor|smart contracts?|протокол\p{L}*|токен\p{L}*|контракт\p{L}*|protokoll|verträge|vertrag|protocolo|contratos?|proyecto)(?![\p{L}])|シーズンズ|トークン|プロトコル|コントラクト/u;
const AUDIT_WIDE =
  /(?<![\p{L}])(?:fully|completely|thoroughly|entirely|independently|100\s?%|полностью|vollständig|completamente|totalmente)\s*$|完全に$/u;
const WIDE_SCOPE =
  /(?<![\p{L}])(?:protocol|programs?|contracts?|distribut\p{L}*|claims|everything|all of|the whole|протокол\p{L}*|контракт\p{L}*|protokoll|verträge|protocolo|contratos)(?![\p{L}])|プロトコル|コントラクト/gu;
const TOKEN_SCOPE =
  /quillaudits|(?<![\p{L}])(?:token (?:itself|only)|only the token|token's (?:configuration|config)|token configuration|токен\p{L}* (?:сам|только)|только токен|nur (?:der )?token|s[oó]lo el token|el token en s[ií])(?![\p{L}])|トークン(?:自体|のみ)/u;

function auditHits(s: Sentence, ctx: VerifyContext): string[] {
  if (s.question) return [];
  const out: string[] = [];
  for (const m of s.K.matchAll(new RegExp(AUDITED.source, "gu"))) {
    const hs = m.index ?? 0;
    const he = hs + m[0].length;
    if (claimNeutralised(s.K, hs, he, { userText: ctx.userText })) continue;
    if (!AUDIT_ENTITY.test(s.K)) continue;
    const wide = AUDIT_WIDE.test(s.K.slice(Math.max(0, hs - 24), hs));
    // A wider scope named in the same clause, and not itself negated ("not the whole protocol").
    const clause = s.K.slice(clauseStart(s.K, hs), hs);
    let wideScope = false;
    for (const w of clause.matchAll(new RegExp(WIDE_SCOPE.source, "gu"))) {
      const before = clause.slice(Math.max(0, (w.index ?? 0) - 24), w.index ?? 0);
      if (
        !/(?<![\p{L}])(?:not|no|nor|without|не|nicht|kein\p{L}*|ni)(?![\p{L}])(?:\s+\p{L}+){0,2}\s*$/u.test(
          before,
        )
      )
        wideScope = true;
    }
    if (wide || wideScope || !TOKEN_SCOPE.test(s.K)) out.push(s.D.slice(hs, he));
  }
  return out;
}

// --- phrase lists (pinned must_not, co-occurrence) -------------------------------------------

const PHRASE_CACHE = new Map<string, RegExp>();
const phraseRe = (p: string): RegExp => {
  const cached = PHRASE_CACHE.get(p);
  if (cached) return cached;
  const re = buildPhraseRe(p);
  if (PHRASE_CACHE.size < 2000) PHRASE_CACHE.set(p, re);
  return re;
};
const buildPhraseRe = (p: string) => {
  const k = skeleton(p.normalize("NFKC"));
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Stems ("неизменн", "пирамид") match as prefixes; CJK phrases have no word boundaries.
  return /^[\p{L}\p{N}]/u.test(k) &&
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(k)
    ? new RegExp(`(?<![\\p{L}\\p{N}])${esc}`, "u")
    : new RegExp(esc, "u");
};

function findPhrase(
  s: Pick<Sentence, "K" | "Kd">,
  phrase: string,
): { start: number; end: number } | null {
  if (!phrase.trim()) return null;
  const re = phraseRe(phrase);
  const m = re.exec(s.K) ?? (s.Kd !== s.K ? re.exec(s.Kd) : null);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

// The mint/freeze/metadata authorities really are revoked; a must_not "revoked" is about the fee settings.
const TRUE_REVOKED =
  /(?<![\p{L}])(?:mint|freeze|metadata|update)(?:\s+(?:and|&|,)\s+(?:mint|freeze|metadata|update))*\s+(?:authorit\p{L}*)/u;

function pinnedHits(s: Sentence, ctx: VerifyContext): string[] {
  const pinned = ctx.pinned;
  if (!pinned) return [];
  const langs = [...new Set([ctx.lang, "en"])];
  const out: string[] = [];
  for (const lang of langs) {
    for (const phrase of pinned.verifier.must_not[lang] ?? []) {
      const hit = findPhrase(s, phrase);
      if (!hit) continue;
      if (claimNeutralised(s.K, hit.start, hit.end, { userText: ctx.userText })) continue;
      if (
        /^(?:revoked|renounced|immutable|отозван\p{L}*|неизменн\p{L}*)$/u.test(skeleton(phrase))
      ) {
        const clause = s.K.slice(clauseStart(s.K, hit.start), clauseEnd(s.K, hit.end));
        if (
          TRUE_REVOKED.test(clause) &&
          !/(?<![\p{L}])(?:fees?|tax|rate|комисси\p{L}*|налог\p{L}*)(?![\p{L}])/u.test(clause)
        )
          continue;
      }
      out.push(phrase);
    }
  }
  return out;
}

function anyPhrase(
  whole: Pick<Sentence, "K" | "Kd">,
  lists: Record<string, string[]>,
): string | null {
  for (const list of Object.values(lists)) for (const p of list) if (findPhrase(whole, p)) return p;
  return null;
}

/** Anywhere in the answer, so the whole draft is searched at once. */
function cooccurrence(whole: Pick<Sentence, "K" | "Kd">, ctx: VerifyContext): Violation[] {
  const out: Violation[] = [];
  const pairs: Array<[Record<string, string[]>, Record<string, string[]>]> = [
    [CONCEDE, HOSTILE_LABEL],
  ];
  if (ctx.pinned?.verifier.cooccurrence_block)
    pairs.push([
      ctx.pinned.verifier.cooccurrence_block.concede,
      ctx.pinned.verifier.cooccurrence_block.label,
    ]);
  for (const [concede, label] of pairs) {
    const c = anyPhrase(whole, concede);
    const l = c ? anyPhrase(whole, label) : null;
    if (c && l) {
      out.push({
        check: "ha_cooccurrence",
        severity: "block",
        detail: `Concedes the frame ("${c}") in an answer that uses "${l}" wording.`,
      });
      break;
    }
  }
  return out;
}

// --- numeric provenance ------------------------------------------------------------------------

function allowedNumbers(ctx: VerifyContext): number[] {
  const out: number[] = [];
  for (const r of ctx.receipts) out.push(...r.numbers);
  for (const sent of splitSentences(ctx.userText))
    for (const n of scanNumbers(sent)) out.push(n.value, ...n.alts);
  // The user's own digits, even where the parser would call them a date or year.
  for (const m of ctx.userText.matchAll(/\d+(?:[.,]\d+)?/g))
    out.push(Number(m[0].replace(",", ".")));
  return out;
}

function isSeasonsSentence(s: Sentence, draftStrong: boolean, strict: boolean): boolean {
  if (STRONG.test(s.K) || SEAS_TICKER.test(s.D)) return true;
  return WEAK.test(s.K) && (draftStrong || strict);
}

// --- links, addresses, secrets, encodings --------------------------------------------------------

function linkStatus(
  link: FoundLink,
  registry: RegistryEntry[],
): "official" | "outdated" | "unknown" {
  const entry = matchLink(link.host, link.path, registry);
  if (!entry) return "unknown";
  return entry.status === "official" ? "official" : "outdated";
}

function receiptText(ctx: VerifyContext): string {
  return ctx.receipts.map((r) => `${r.value} ${r.locator} ${r.url ?? ""} ${r.label}`).join(" ");
}

function encodedHits(D: string): string[] {
  const out: string[] = [];
  for (const m of D.matchAll(
    /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{41,}={0,2}(?![A-Za-z0-9+/=_-])/g,
  )) {
    if (decodeBase64Text(m[0])) out.push("base64");
  }
  for (const m of D.matchAll(
    /(?<![\p{L}\p{N}])\p{L}(?:[ .\-_*·•|]{1,3}\p{L}(?![\p{L}\p{N}])){2,}/gu,
  )) {
    const word = m[0].replace(/[^\p{L}]/gu, "").toLowerCase();
    if (SEASONS_CLAIM_WORDS.has(skeleton(word))) out.push(`letter-spaced "${m[0]}"`);
  }
  for (const m of D.matchAll(/[A-Za-z]{4,}/g))
    if (ROT13_CLAIM_WORDS.has(m[0].toLowerCase())) out.push(`ROT13 "${m[0]}"`);
  // Leetspeak of a Seasons word ("s3as0ns", "gu4r4nt33d").
  for (const m of D.matchAll(/[\p{L}\p{N}@]+/gu)) {
    const t = m[0];
    if (t.length > 40 || !/\p{L}/u.test(t) || !/[\d@]/.test(t) || /^\d/.test(t)) continue;
    const sk = skeleton(t);
    if (sk !== t.toLowerCase() && SEASONS_CLAIM_WORDS.has(sk)) out.push(`leetspeak "${t}"`);
  }
  return out;
}

// --- $SEAS spelling and defanging -------------------------------------------------------------

interface Range {
  start: number;
  end: number;
  replace?: string;
}

function protectedRanges(draft: string, links: FoundLink[], userText: string): Range[] {
  const out: Range[] = [];
  for (const m of draft.matchAll(/```[\s\S]*?```|`[^`\n]*`/g))
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const l of links) out.push({ start: l.start, end: l.end });
  for (const m of draft.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,90}/g))
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const e of extractEmails(draft)) out.push({ start: e.start, end: e.end });
  const userSk = skeleton(userText);
  for (const [a, b] of quoteSpans(draft)) {
    const quoted = skeleton(draft.slice(a + 1, b)).trim();
    if (quoted && userSk.includes(quoted)) out.push({ start: a, end: b + 1 });
  }
  return out;
}

function rewrite(draft: string, ranges: Range[]): string {
  // Replacements (defanged links) win over plain protected ranges that start at the same place.
  const sorted = [...ranges].sort(
    (a, b) =>
      a.start - b.start || (a.replace !== undefined ? -1 : 1) - (b.replace !== undefined ? -1 : 1),
  );
  let out = "";
  let pos = 0;
  const fixSpelling = (seg: string) => seg.replace(SEAS_TICKER_ALL, () => "$SEAS");
  for (const r of sorted) {
    if (r.start < pos) continue;
    out += fixSpelling(draft.slice(pos, r.start));
    out += r.replace ?? draft.slice(r.start, r.end);
    pos = r.end;
  }
  return out + fixSpelling(draft.slice(pos));
}

// --- the verifier ------------------------------------------------------------------------------

export function verifyDraft(draft: string, ctx: VerifyContext): VerifyResult {
  const violations: Violation[] = [];
  const sentences = splitSentences(draft).map(prepare);
  const full = cleanText(draft);
  const draftStrong =
    sentences.some((s) => STRONG.test(s.K) || SEAS_TICKER.test(s.D)) ||
    SEASONS_ANCHOR.test(skeleton(full));
  const strict = strictMode(ctx);
  const allowed = allowedNumbers(ctx);

  for (const s of sentences) {
    // 1. Numeric provenance, sentence-scoped.
    if (isSeasonsSentence(s, draftStrong, strict)) {
      const missing = scanNumbers(s.D).filter((n) => !numberMatches(n, allowed));
      if (missing.length)
        violations.push({
          check: "numeric_provenance",
          severity: strict ? "block" : "flag",
          detail: `No receipt or user text for ${missing.map((n) => n.raw).join(", ")}.`,
          sentence: s.raw,
        });
    }
    // 2, 3, 6. Price targets, never-say lexicon, conduct claims.
    for (const { rule, hit } of lexiconHits(s, RULES, ctx, draftStrong, false)) {
      violations.push({
        check: rule.check,
        severity: "block",
        detail: `${rule.id}: "${hit}"`,
        sentence: s.raw,
      });
    }
    for (const hit of auditHits(s, ctx)) {
      violations.push({
        check: "never_say",
        severity: "block",
        detail: `unscoped_audit: "${hit}" (say the token itself was audited by QuillAudits, not the protocol)`,
        sentence: s.raw,
      });
    }
    // 5. Pinned Hard Answer must_not.
    for (const phrase of pinnedHits(s, ctx)) {
      violations.push({
        check: "pinned_must_not",
        severity: "block",
        detail: `${ctx.pinned?.id}: "${phrase}"`,
        sentence: s.raw,
      });
    }
  }

  // 4. Concession of the frame next to Ponzi/scam wording, anywhere in the answer.
  const wholeK = skeleton(full);
  violations.push(...cooccurrence({ K: wholeK, Kd: despace(wholeK) }, ctx));

  // 7. Links and addresses.
  const registry = ctx.registry ?? [];
  const links = extractLinks(draft);
  const ranges = protectedRanges(draft, links, ctx.userText);
  for (const link of links) {
    const status = linkStatus(link, registry);
    if (status === "official") continue;
    if (status === "outdated") {
      violations.push({
        check: "link_allowlist",
        severity: "flag",
        detail: `Outdated registry link: ${link.value}`,
      });
      continue;
    }
    ranges.push({ start: link.start, end: link.end, replace: defang(link.value) });
    violations.push({
      check: "link_allowlist",
      severity: "flag",
      detail: `Not in the registry, defanged: ${defang(link.value)}`,
    });
  }
  for (const e of extractEmails(draft)) {
    const ok = registry.some(
      (r) =>
        r.kind === "email" &&
        r.value.toLowerCase() === e.value.toLowerCase() &&
        r.status === "official",
    );
    if (ok) continue;
    ranges.push({ start: e.start, end: e.end, replace: defang(e.value) });
    violations.push({
      check: "link_allowlist",
      severity: "flag",
      detail: `E-mail not in the registry, defanged: ${defang(e.value)}`,
    });
  }
  for (const h of extractHandles(draft)) {
    const handle = h.value.slice(1).toLowerCase();
    const ok = registry.some(
      (r) =>
        (r.kind === "handle" && r.value.replace(/^@/, "").toLowerCase() === handle) ||
        (r.kind === "url" && r.value.toLowerCase().endsWith(`/${handle}`)),
    );
    if (!ok)
      violations.push({
        check: "link_allowlist",
        severity: "flag",
        detail: `Handle not in the registry: ${h.value}`,
      });
  }
  const { addresses, signatures } = extractBase58(draft, links);
  const known = receiptText(ctx);
  for (const a of addresses) {
    const ok =
      registry.some((r) => r.kind === "address" && r.value === a.value) ||
      ctx.userText.includes(a.value);
    if (!ok)
      violations.push({
        check: "address_allowlist",
        severity: "block",
        detail: `Address not in the registry or the user's message: ${a.value}`,
      });
  }
  for (const sig of signatures) {
    if (ctx.userText.includes(sig.value) || known.includes(sig.value)) continue;
    violations.push({
      check: "address_allowlist",
      severity: "block",
      detail: "Transaction signature not from the user or a receipt.",
    });
  }

  // 8. Secret echo and canary.
  const secrets = detectSecrets(full);
  for (const span of secrets.spans) {
    violations.push({
      check: "secret_echo",
      severity: span.level === "hard" ? "block" : "flag",
      detail: `Looks like a secret (${span.kind}).`,
    });
  }
  if (ctx.canary && ctx.canary.length >= 4) {
    const flatDraft = full.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
    const flatCanary = ctx.canary.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
    if (full.includes(ctx.canary) || (flatCanary.length >= 8 && flatDraft.includes(flatCanary)))
      violations.push({
        check: "canary",
        severity: "block",
        detail: "The canary token appears in the output.",
      });
  }

  // 9. Encoded or obfuscated output.
  for (const kind of new Set(encodedHits(full)))
    violations.push({
      check: "encoded_output",
      severity: "block",
      detail: `Encoded or obfuscated output: ${kind}.`,
    });

  // 10. $SEAS spelling (and the defanging above) applied to the returned text.
  return { text: rewrite(draft, ranges), violations };
}

// --- suggestions ---------------------------------------------------------------------------------

const ACTION_VERBS = new RegExp(
  `${B}(?:claim|claims|claimed|claiming|sign|signs|signed|signing|send|sends|sent|sending|connect|connects|connected|connecting|approve|approves|approved|approving|transfer|transfers|transferred|transferring)${E}(?!\\s*(?:fee|fees|tax|hook|program|vault)${E})` +
    `|${B}(?:подпиш\\p{L}*|подписа\\p{L}*|отправ\\p{L}*|перевед\\p{L}*|перевест\\p{L}*|подключ\\p{L}*|одобр\\p{L}*|заклейм\\p{L}*|клейм\\p{L}*)` +
    `|${B}(?:signier\\p{L}*|unterschreib\\p{L}*|send\\p{L}*|schick\\p{L}*|überweis\\p{L}*|verbind\\p{L}*|genehmig\\p{L}*|übertrag\\p{L}*|beanspruch\\p{L}*)` +
    `|${B}(?:reclam\\p{L}*|firm[ae]\\p{L}*|firmar|envi[aeoó]\\p{L}*|conect\\p{L}*|aprob\\p{L}*|aprueb\\p{L}*|transferir|transfier\\p{L}*)` +
    `|請求|クレーム|署名|サイン|送金|送信|送って|接続|承認|転送`,
  "u",
);

/** A suggestion must be a sendable question with nothing the user didn't bring. Returns the cleaned text or null. */
export function verifySuggestion(text: string, ctx: VerifyContext): string | null {
  const cleaned = cleanText(text).replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 110) return null;
  if (!/[?？]["'”’»)\]]*$/.test(cleaned)) return null;
  const links = extractLinks(cleaned);
  if (links.length || extractEmails(cleaned).length || extractHandles(cleaned).length) return null;
  const { addresses, signatures } = extractBase58(cleaned, links);
  if (addresses.length || signatures.length || /[1-9A-HJ-NP-Za-km-z]{32,}/.test(cleaned))
    return null;
  // No amount or number the user didn't type (years included: a suggestion is never a forecast).
  const userNums = allowedNumbers({ ...ctx, receipts: [] });
  const covered: Array<[number, number]> = [];
  for (const n of scanNumbers(cleaned)) {
    if (!numberMatches(n, userNums)) return null;
    covered.push([n.start, n.end]);
  }
  const userRuns = new Set(ctx.userText.match(/\d+/g) ?? []);
  for (const m of cleaned.matchAll(/\d+/g)) {
    const at = m.index ?? 0;
    if (!covered.some(([a, b]) => at >= a && at < b) && !userRuns.has(m[0])) return null;
  }
  const s = prepare(cleaned);
  if (ACTION_VERBS.test(s.K)) return null;
  const rules = RULES.filter((r) => r.check === "price_target" || r.check === "never_say");
  if (lexiconHits(s, rules, ctx, true, true).length) return null;
  if (ctx.canary && cleaned.includes(ctx.canary)) return null;
  if (detectSecrets(cleaned).level !== "none" || encodedHits(cleaned).length) return null;
  return rewrite(cleaned, protectedRanges(cleaned, links, ctx.userText));
}
