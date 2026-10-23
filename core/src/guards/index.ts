/**
 * L0 guards: deterministic, always on, before
 * anything else sees the user's text. Output is safe for any model: secrets
 * are redacted here and never kept anywhere.
 */
import { extractBase58, extractLinks, refang } from "./extract";
import { seasonsMoneyFloor } from "./floors";
import { decodeBase64Text, detectInjection } from "./injection";
import { guessLang } from "./lang";
import { matchPin } from "./pin";
import { detectSecrets, redactSpans, type SecretSpan } from "./secrets";
import { normalizeInput } from "./text";

import type { GuardResult, HardAnswer, SecretLevel } from "../types";

export { classifyBase58, base58Decode, isSolanaKeypair } from "./base58";
export {
  extractBase58,
  extractEmails,
  extractHandles,
  extractLinks,
  refang,
  splitLink,
  type Found,
  type FoundLink,
} from "./extract";
export { mentionsSeasons, seasonsMoneyFloor } from "./floors";
export { decodeBase64Text, decodeBlobs, detectInjection } from "./injection";
export { guessLang } from "./lang";
export { matchPin } from "./pin";
export {
  defang,
  matchLink,
  verifyAddress,
  verifyLink,
  MSG as VERDICT_WORDING,
  type Verdict,
  type VerifyVerdict,
} from "./registry";
export {
  detectSecrets,
  redactSpans,
  REDACTED,
  isSeedWord,
  type SecretScan,
  type SecretSpan,
} from "./secrets";
export { cleanText, despace, normalizeInput, skeleton } from "./text";

export interface ScreenOptions {
  /** The last few user messages (oldest first), so a seed split across messages is caught. */
  recentUserTexts?: string[];
  /** Canon Hard Answers, for the deterministic pin. Passed in, never imported. */
  hardAnswers?: HardAnswer[];
}

const BASE64_BLOB = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g;
// How many earlier messages the split-seed window looks back over.
const RECENT_WINDOW = 6;

const rank: Record<SecretLevel, number> = { none: 0, soft: 1, hard: 2 };

export function screenInput(raw: string, opts: ScreenOptions = {}): GuardResult {
  const norm = normalizeInput(raw);
  let recent = (opts.recentUserTexts ?? []).map((r) => normalizeInput(r).text).filter(Boolean);
  // Callers sometimes include the current message in the history; counting it twice would invent a split seed.
  if (recent.length && recent[recent.length - 1] === norm.text) recent = recent.slice(0, -1);

  const scan = detectSecrets(norm.text, recent.slice(-RECENT_WINDOW));
  const spans: SecretSpan[] = [...scan.spans];
  const kinds = new Set(scan.kinds);
  let level = scan.level;

  // A secret inside a base64 blob (decoded one level) is still a secret.
  for (const m of norm.text.matchAll(BASE64_BLOB)) {
    const decoded = decodeBase64Text(m[0]);
    if (!decoded) continue;
    const inner = detectSecrets(decoded);
    if (inner.level === "none") continue;
    const start = m.index ?? 0;
    spans.push({
      start,
      end: start + m[0].length,
      kind: `${inner.kinds[0]}_encoded`,
      level: inner.level,
    });
    kinds.add(`${inner.kinds[0]}_encoded`);
    if (rank[inner.level] > rank[level]) level = inner.level;
  }
  // Tag characters are already stripped from the text, but a secret smuggled in them still counts.
  if (norm.hidden) {
    const inner = detectSecrets(norm.hidden);
    if (inner.level !== "none") {
      for (const k of inner.kinds) kinds.add(`${k}_hidden`);
      if (rank[inner.level] > rank[level]) level = inner.level;
    }
  }

  const text = redactSpans(norm.text, spans);
  const detect = refang(text);
  const linkHits = extractLinks(detect);
  const { addresses, signatures } = extractBase58(detect, linkHits);
  const injection = detectInjection(text, { hidden: norm.hidden, flags: norm.flags });

  const links = [...new Set(linkHits.map((l) => l.value))];
  const addressList = [...new Set(addresses.map((a) => a.value))];
  const signatureList = [...new Set(signatures.map((s) => s.value))];

  return {
    text,
    secret: level,
    secretKinds: [...kinds],
    links,
    addresses: addressList,
    signatures: signatureList,
    injectionSignals: injection.signals,
    floors: {
      seasonsMoney: seasonsMoneyFloor(text),
      pin: matchPin(text, opts.hardAnswers ?? []),
      safety:
        level !== "none" ||
        links.length > 0 ||
        addressList.length > 0 ||
        signatureList.length > 0 ||
        injection.signals.length > 0,
    },
    lang: guessLang(text),
  };
}
