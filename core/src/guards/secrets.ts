/**
 * Secret detectors. HARD hits mean the message is a
 * secret: the turn short-circuits to an authored template. SOFT hits are
 * redacted before anything else sees the text. Only the kind is reported;
 * the secret itself is never kept.
 */
import { wordlist as czech } from "@scure/bip39/wordlists/czech.js";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { wordlist as french } from "@scure/bip39/wordlists/french.js";
import { wordlist as italian } from "@scure/bip39/wordlists/italian.js";
import { wordlist as japanese } from "@scure/bip39/wordlists/japanese.js";
import { wordlist as korean } from "@scure/bip39/wordlists/korean.js";
import { wordlist as portuguese } from "@scure/bip39/wordlists/portuguese.js";
import { wordlist as simplifiedChinese } from "@scure/bip39/wordlists/simplified-chinese.js";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish.js";
import { wordlist as traditionalChinese } from "@scure/bip39/wordlists/traditional-chinese.js";

import { base58Decode, classifyBase58 } from "./base58";

import type { SecretLevel } from "../types";

export const REDACTED = "[secret removed]";

export interface SecretSpan {
  start: number;
  end: number;
  kind: string;
  level: "soft" | "hard";
}

export interface SecretScan {
  level: SecretLevel;
  kinds: string[];
  spans: SecretSpan[];
}

const LISTS = [
  english,
  spanish,
  french,
  italian,
  portuguese,
  czech,
  japanese,
  korean,
  simplifiedChinese,
  traditionalChinese,
];
const stripMarks = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC");

let WORDS: Set<string> | null = null;
/** Union of every bundled BIP39 list, so mixed-language seeds are caught too. */
function words(): Set<string> {
  if (!WORDS) {
    WORDS = new Set();
    for (const list of LISTS)
      for (const w of list) {
        const n = w.normalize("NFKC").toLowerCase();
        WORDS.add(n);
        WORDS.add(stripMarks(n));
      }
  }
  return WORDS;
}

export function isSeedWord(token: string): boolean {
  const t = token.normalize("NFKC").toLowerCase();
  const set = words();
  return set.has(t) || set.has(stripMarks(t));
}

interface Tok {
  start: number;
  end: number;
  inList: boolean;
  /** Index into [...recent, current]; the current message is the last. */
  msg: number;
}

// The soft-redaction placeholder in an earlier message stands for ≥ 8 words of a run.
const PLACEHOLDER_WORDS = 8;

function tokensOf(text: string, msg: number): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/\[secret removed\]|[\p{L}\p{M}]+/gu)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (m[0] === REDACTED) {
      for (let k = 0; k < PLACEHOLDER_WORDS; k++) out.push({ start, end, inList: true, msg });
      continue;
    }
    out.push({ start, end, inList: isSeedWord(m[0]), msg });
  }
  return out;
}

const WINDOW = 12;

/** BIP39 windows (≥ 11 of 12 words: all-but-one tolerates a typo) and soft runs (≥ 8). */
function scanMnemonic(text: string, recent: string[], spans: SecretSpan[]): void {
  const cur = recent.length;
  const stream: Tok[] = [];
  recent.forEach((r, i) => stream.push(...tokensOf(r, i)));
  stream.push(...tokensOf(text, cur));

  const hardCovered = new Set<number>();
  for (let i = 0; i + WINDOW <= stream.length; i++) {
    let n = 0;
    for (let j = i; j < i + WINDOW; j++) if (stream[j]!.inList) n++;
    if (n < WINDOW - 1) continue;
    const win = stream.slice(i, i + WINDOW);
    const mine = win.filter((t) => t.msg === cur && t.inList);
    if (!mine.length) continue;
    const split = win.some((t) => t.msg !== cur);
    for (let j = i; j < i + WINDOW; j++) if (stream[j]!.msg === cur) hardCovered.add(j);
    spans.push({
      start: mine[0]!.start,
      end: mine[mine.length - 1]!.end,
      kind: split ? "bip39_mnemonic_split" : "bip39_mnemonic",
      level: "hard",
    });
  }

  // Soft: a run of ≥ 8 consecutive wordlist words not already part of a hard window.
  let runStart = -1;
  const flush = (endIdx: number) => {
    const from = runStart;
    runStart = -1;
    if (from < 0 || endIdx - from < 8) return;
    const mine: Tok[] = [];
    for (let j = from; j < endIdx; j++)
      if (stream[j]!.msg === cur && !hardCovered.has(j)) mine.push(stream[j]!);
    if (!mine.length) return;
    spans.push({
      start: mine[0]!.start,
      end: mine[mine.length - 1]!.end,
      kind: "bip39_word_run",
      level: "soft",
    });
  };
  for (let i = 0; i < stream.length; i++) {
    if (stream[i]!.inList) {
      if (runStart < 0) runStart = i;
    } else flush(i);
  }
  flush(stream.length);
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'«»]+/gi;
const KEY_CUE =
  /(?:private|secret|priv)[\s_-]?key|seed(?:\s?phrase)?|mnemonic|recovery\s(?:phrase|words)|приватн\p{L}*\sключ|секретн\p{L}*\sключ|сид|мнемоник|privat\p{L}*\s?schlüssel|geheim\p{L}*\s?schlüssel|clave\s(?:privada|secreta)|frase\ssemilla|秘密鍵|プライベートキー|シードフレーズ/iu;

function inRanges(ranges: Array<[number, number]>, start: number, end: number) {
  return ranges.some(([a, b]) => start >= a && end <= b);
}

function scanKeys(text: string, spans: SecretSpan[]): void {
  const urls: Array<[number, number]> = [...text.matchAll(URL_RE)].map((m) => [
    m.index ?? 0,
    (m.index ?? 0) + m[0].length,
  ]);

  // Solana keypair files: a JSON array of 64 bytes.
  for (const m of text.matchAll(/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g)) {
    const nums = m[0].match(/\d{1,3}/g) ?? [];
    if (nums.every((n) => Number(n) <= 255))
      spans.push({
        start: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
        kind: "keypair_json",
        level: "hard",
      });
  }

  // 64-hex (EVM or raw ed25519 private keys); 128-hex is a full keypair.
  for (const m of text.matchAll(
    /(?<![0-9A-Fa-f])(?:0x)?(?:[0-9A-Fa-f]{128}|[0-9A-Fa-f]{64})(?![0-9A-Fa-fx])/g,
  )) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (inRanges(urls, start, end)) continue;
    if (!/[a-f]/i.test(m[0].replace(/^0x/i, "")) || !/\d/.test(m[0])) continue;
    spans.push({ start, end, kind: "hex_private_key", level: "hard" });
  }

  for (const m of text.matchAll(
    /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,90}(?![1-9A-HJ-NP-Za-km-z])/g,
  )) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const kind = classifyBase58(m[0]);
    if (kind === "keypair") {
      spans.push({ start, end, kind: "base58_private_key", level: "hard" });
      continue;
    }
    // Bitcoin WIF private keys (5…, K…, L…): version byte 0x80, 32-byte key (+0x01 when compressed), 4-byte checksum.
    if (!kind && /^[5KL]/.test(m[0]) && (m[0].length === 51 || m[0].length === 52)) {
      const bytes = base58Decode(m[0]);
      if (
        bytes &&
        bytes[0] === 0x80 &&
        (bytes.length === 37 || (bytes.length === 38 && bytes[33] === 0x01))
      ) {
        spans.push({ start, end, kind: "wif_private_key", level: "hard" });
        continue;
      }
    }
    if (!kind || inRanges(urls, start, end)) continue;
    // A 32-byte string right after a key cue is a key, not a "pasted address" (§13.4).
    const before = text.slice(Math.max(0, start - 48), start);
    if (KEY_CUE.test(before)) spans.push({ start, end, kind: "base58_key_cued", level: "soft" });
  }
}

// "my seed / private key / password is …" in en, ru, de, es, ja.
const SOFT_CUES: Array<{ kind: string; value: "seed" | "key" | "password"; re: RegExp }> = [
  {
    kind: "seed_phrase_cue",
    value: "seed",
    re: /(?:my|the|our)\s+(?:(?:wallet|phantom|solflare|metamask|backup|ledger)\s+)?(?:seed(?:\s+phrase)?|recovery\s+(?:phrase|words|seed)|secret\s+(?:recovery\s+)?phrase|mnemonic(?:\s+phrase)?|backup\s+phrase|12\s+words|24\s+words)\s*(?:is|are|:|=|-|—)\s*/giu,
  },
  {
    kind: "private_key_cue",
    value: "key",
    re: /(?:my|the|our)\s+(?:wallet'?s?\s+)?(?:private|secret|priv)\s*key\s*(?:is|:|=|-|—)\s*/giu,
  },
  {
    kind: "password_cue",
    value: "password",
    re: /(?:my|the)\s+(?:wallet\s+|account\s+|phantom\s+|email\s+|exchange\s+)?(?:password|passcode|passphrase|pin(?:\s+code)?|2fa\s+code)\s*(?:is|:|=|-|—)\s*/giu,
  },
  {
    kind: "seed_phrase_cue",
    value: "seed",
    re: /мо[йяеи]\s+(?:сид(?:[-\s]?фраза)?|мнемоник\p{L}*|фраза\s+восстановления|секретн\p{L}*\s+фраза|seed(?:\s+phrase)?)\s*(?:—|-|:|это|=)?\s*/giu,
  },
  {
    kind: "private_key_cue",
    value: "key",
    re: /мо[йяеи]\s+(?:приватн\p{L}*|секретн\p{L}*)\s+ключ\s*(?:—|-|:|это|=)?\s*/giu,
  },
  {
    kind: "password_cue",
    value: "password",
    re: /мо[йяеи]\s+(?:пароль|пин-?код)\s*(?:—|-|:|это|=)?\s*/giu,
  },
  {
    kind: "seed_phrase_cue",
    value: "seed",
    re: /(?:mein|meine)\s+(?:seed(?:[-\s]?phrase)?|wiederherstellungs(?:phrase|wörter)|geheime\s+phrase|mnemonic)\s*(?:ist|lautet|sind|lauten|:|=)\s*/giu,
  },
  {
    kind: "private_key_cue",
    value: "key",
    re: /mein\s+(?:privater\s+schlüssel|privatschlüssel|private\s+key|geheimer\s+schlüssel)\s*(?:ist|lautet|:|=)\s*/giu,
  },
  {
    kind: "password_cue",
    value: "password",
    re: /mein\s+(?:passwort|kennwort|pin)\s*(?:ist|lautet|:|=)\s*/giu,
  },
  {
    kind: "seed_phrase_cue",
    value: "seed",
    re: /mis?\s+(?:frase\s+semilla|semilla|frase\s+de\s+recuperación|frase\s+secreta|palabras\s+secretas|seed(?:\s+phrase)?)\s*(?:es|son|:|=)\s*/giu,
  },
  {
    kind: "private_key_cue",
    value: "key",
    re: /mi\s+clave\s+(?:privada|secreta)\s*(?:es|:|=)\s*/giu,
  },
  {
    kind: "password_cue",
    value: "password",
    re: /mi\s+(?:contraseña|clave|pin)\s*(?:es|:|=)\s*/giu,
  },
  {
    kind: "seed_phrase_cue",
    value: "seed",
    re: /(?:シードフレーズ|シード|リカバリーフレーズ|復元フレーズ|秘密のフレーズ)(?:は|：|:)\s*/gu,
  },
  { kind: "private_key_cue", value: "key", re: /(?:秘密鍵|プライベートキー)(?:は|：|:)\s*/gu },
  { kind: "password_cue", value: "password", re: /パスワード(?:は|：|:)\s*/gu },
];

// Words that describe a password rather than being one ("my password is weak").
const NOT_A_PASSWORD = new Set(
  "weak strong wrong correct incorrect not too long short safe secure unsafe lost forgotten stolen compromised the a an same different changed expired invalid saved stored written hidden fine ok okay good bad simple easy hard complex leaked known private secret mine required needed empty blank there here in on at what where how when why that this also still now слабый сильный неправильный правильный утерян украден забыт скомпрометирован не тот такой же простой сложный schwach stark falsch richtig verloren gestohlen vergessen nicht einfach débil fuerte incorrecta correcta perdida robada olvidada segura simple".split(
    " ",
  ),
);

function scanCues(text: string, spans: SecretSpan[]): void {
  for (const cue of SOFT_CUES) {
    for (const m of text.matchAll(cue.re)) {
      const from = (m.index ?? 0) + m[0].length;
      const lineEnd = text.indexOf("\n", from);
      const rest = text.slice(from, Math.min(lineEnd < 0 ? text.length : lineEnd, from + 400));
      if (!rest.trim()) continue;
      if (cue.value === "seed") {
        const toks = [...rest.matchAll(/[\p{L}\p{M}]+/gu)].slice(0, 30);
        const hits = toks.filter((t) => isSeedWord(t[0])).length;
        const long = /[A-Za-z0-9+/=_-]{16,}/.exec(rest);
        if (hits >= 3 || long)
          spans.push({ start: from, end: from + rest.length, kind: cue.kind, level: "soft" });
        continue;
      }
      if (cue.value === "key") {
        const long = /[A-Za-z0-9+/=_-]{16,}/.exec(rest);
        if (long)
          spans.push({
            start: from + long.index,
            end: from + long.index + long[0].length,
            kind: cue.kind,
            level: "soft",
          });
        continue;
      }
      const tok = /^["'«“]?([^\s"'»”]+)/.exec(rest);
      if (!tok) continue;
      const value = tok[1]!.replace(/[.,;:!?)]+$/, "");
      if (value.length < 3 || NOT_A_PASSWORD.has(value.toLowerCase()) || /^\?/.test(value))
        continue;
      const start = from + tok[0].indexOf(tok[1]!);
      spans.push({ start, end: start + value.length, kind: cue.kind, level: "soft" });
    }
  }
}

/**
 * Detect secrets in `text`. `recentUserTexts` are the previous user messages
 * (oldest first), so a mnemonic split across messages is caught as HARD.
 */
export function detectSecrets(text: string, recentUserTexts: string[] = []): SecretScan {
  const spans: SecretSpan[] = [];
  scanKeys(text, spans);
  scanMnemonic(text, recentUserTexts, spans);
  scanCues(text, spans);
  const level: SecretLevel = spans.some((s) => s.level === "hard")
    ? "hard"
    : spans.length
      ? "soft"
      : "none";
  return { level, kinds: [...new Set(spans.map((s) => s.kind))], spans };
}

/** Replace every secret span with the placeholder; overlapping spans merge. */
export function redactSpans(text: string, spans: Array<{ start: number; end: number }>): string {
  if (!spans.length) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    // Separators between two secret spans are part of the secret run.
    if (
      last &&
      (s.start <= last.end || /^[\s,.;:\-–—|()0-9]*$/.test(text.slice(last.end, s.start)))
    )
      last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  let out = "";
  let pos = 0;
  for (const s of merged) {
    out += text.slice(pos, s.start) + REDACTED;
    pos = s.end;
  }
  return out + text.slice(pos);
}
