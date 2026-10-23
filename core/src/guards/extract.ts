/**
 * Deterministic extraction of links, e-mail addresses, handles, Solana
 * addresses and transaction signatures (the primary source for
 * pasted content, and the link/address allowlist on output).
 */
import { classifyBase58 } from "./base58";

export interface Found {
  value: string;
  start: number;
  end: number;
}

export interface FoundLink extends Found {
  kind: "url" | "domain";
  /** Lower-case, punycode-decoded host without "www.", port or trailing dot. */
  host: string;
  /** Path without query or fragment; "" for the root. */
  path: string;
}

// Generic TLDs seen in crypto phishing and normal use, plus every ccTLD.
const TLDS = new Set(
  (
    "com net org info biz io app dev xyz wtf ai gg fi co me tv cc ly finance money tech site online top club live pro link click " +
    "store shop cloud news space vip lol fun one world today network exchange capital fund bank crypto nft dao sol eth art blog " +
    "global digital group systems solutions services agency media studio design email support help foundation claims claim bonus " +
    "gift win promo reward rewards airdrop ltd inc llc company trade trading markets market wallet cash gold games social chat page " +
    "web website run zone life land city bet casino cfd forex loan loans credit financial investments tax wiki center events " +
    "ac ad ae af ag al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cd cf cg ch ci ck " +
    "cl cm cn cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fj fk fm fo fr ga gd ge gf gh gi gl gm gn gp gq gr gs " +
    "gt gu gw gy hk hm hn hr ht hu id ie il im in iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls " +
    "lt lu lv ma mc md mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg " +
    "ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg " +
    "th tj tk tl tm tn to tr tt tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw рф рус"
  ).split(" "),
);
// Bare "file.ext" is far more often a filename than a link.
const FILE_LIKE = new Set([
  "md",
  "py",
  "sh",
  "rs",
  "pl",
  "ps",
  "so",
  "cs",
  "ml",
  "pm",
  "sc",
  "zip",
  "mov",
]);
// "works.Is this…": a missing space after a full stop, not a domain.
const PROSE_TLD = new Set([
  "is",
  "it",
  "in",
  "at",
  "be",
  "me",
  "no",
  "so",
  "to",
  "do",
  "us",
  "as",
  "am",
  "by",
  "my",
]);

const URL_RE = /\b(?:https?|hxxps?):\/\/[^\s<>"'«»`]+/giu;
const WWW_RE = /(?<![\p{L}\p{N}.])www\.[^\s<>"'«»`]+/giu;
const DOMAIN_RE =
  /(?<![\p{L}\p{N}@._\-/])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(\p{L}{2,24}|xn--[a-z0-9-]{2,59}))(?![\p{L}\p{N}-])(\/[^\s<>"'«»`]*)?/giu;
// The look-behind anchors each try at a run start; without it a long run backtracks quadratically.
const EMAIL_RE =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@(?:[\p{L}\p{N}-]{1,63}\.){1,8}\p{L}{2,24}/gu;
const HANDLE_RE = /(?<![\p{L}\p{N}_@./])@([A-Za-z0-9_]{3,32})(?![A-Za-z0-9_@])/gu;
const BASE58_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,90}(?![1-9A-HJ-NP-Za-km-z])/g;

/** Trim sentence punctuation and unbalanced closing brackets off a link. */
function trimLink(s: string): string {
  let out = s.replace(/[.,;:!?'"’”»)\]}*_]+$/u, "");
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
  ] as const) {
    while (out.endsWith(close) && out.split(open).length < out.split(close).length)
      out = out.slice(0, -1);
  }
  // Re-add a closing bracket that belongs to the link, e.g. wiki/Foo_(bar).
  const orig = s.slice(out.length);
  if (orig.startsWith(")") && out.split("(").length > out.split(")").length) out += ")";
  return out;
}

// --- punycode (RFC 3492), so "xn--" look-alikes are compared as what they display ---------

function punyDecode(label: string): string {
  const input = label.slice(4);
  const base = 36,
    tMin = 1,
    tMax = 26,
    skew = 38,
    damp = 700;
  const basicEnd = input.lastIndexOf("-");
  const output: number[] =
    basicEnd > 0 ? [...input.slice(0, basicEnd)].map((c) => c.charCodeAt(0)) : [];
  let n = 128,
    i = 0,
    bias = 72;
  const adapt = (delta: number, numPoints: number, first: boolean) => {
    delta = first ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    let k = 0;
    while (delta > ((base - tMin) * tMax) >> 1) {
      delta = Math.floor(delta / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
  };
  const digit = (c: number) =>
    c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
  for (let pos = basicEnd > 0 ? basicEnd + 1 : 0; pos < input.length; ) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (pos >= input.length) return label;
      const d = digit(input.charCodeAt(pos++));
      if (d >= base) return label;
      i += d * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) break;
      w *= base - t;
    }
    bias = adapt(i - oldi, output.length + 1, oldi === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    output.splice(i++, 0, n);
  }
  try {
    return String.fromCodePoint(...output);
  } catch {
    return label;
  }
}

export function normalizeHost(host: string): string {
  let h = host.normalize("NFKC").toLowerCase().replace(/\.$/, "");
  h = h.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
  h = h
    .split(".")
    .map((l) => (l.startsWith("xn--") ? punyDecode(l) : l))
    .join(".");
  return h.replace(/^www\./, "");
}

/** Split a URL or bare domain into host and path. */
export function splitLink(value: string): { host: string; path: string } {
  const noScheme = value.replace(/^(?:https?|hxxps?):\/\//i, "");
  const m = /^([^/?#]*)([^?#]*)/.exec(noScheme);
  const host = normalizeHost(m?.[1] ?? "");
  let path = m?.[2] ?? "";
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "/") path = "";
  return { host, path };
}

/** Undo common defanging ("example[.]app", "hxxps://") for detection. */
export const refang = (s: string) =>
  s.replace(/\[\.\]|\(\.\)|\{\.\}/g, ".").replace(/\bhxxp(s?):\/\//gi, "http$1://");

const within = (ranges: Found[], start: number, end: number) =>
  ranges.some((r) => start >= r.start && end <= r.end);

export function extractEmails(text: string): Found[] {
  return [...text.matchAll(EMAIL_RE)].map((m) => ({
    value: m[0],
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
}

export function extractLinks(text: string): FoundLink[] {
  const out: FoundLink[] = [];
  const emails = extractEmails(text);
  for (const re of [URL_RE, WWW_RE]) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      if (within(out, start, start + 1)) continue;
      const value = trimLink(m[0]);
      const { host, path } = splitLink(value);
      if (!host.includes(".")) continue;
      out.push({ value, start, end: start + value.length, kind: "url", host, path });
    }
  }
  for (const m of text.matchAll(DOMAIN_RE)) {
    const start = m.index ?? 0;
    if (within(out, start, start + 1) || within(emails, start, start + 1)) continue;
    const tldRaw = m[2] ?? "";
    const tld = tldRaw.toLowerCase();
    if (!TLDS.has(tld) && !tld.startsWith("xn--")) continue;
    const hasPath = Boolean(m[3] && m[3].length > 1);
    if (!hasPath && FILE_LIKE.has(tld)) continue;
    if (!hasPath && PROSE_TLD.has(tld) && /^\p{Lu}/u.test(tldRaw)) continue;
    const labels = (m[1] ?? "").split(".");
    // "t.me" is the one common single-letter host; otherwise require a real label.
    if (labels[0]!.length < 2 && (m[1] ?? "").toLowerCase() !== "t.me") continue;
    if (!/\p{L}/u.test(labels.slice(0, -1).join(""))) continue;
    const value = trimLink(m[0]);
    const { host, path } = splitLink(value);
    out.push({ value, start, end: start + value.length, kind: "domain", host, path });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function extractHandles(text: string): Found[] {
  const emails = extractEmails(text);
  return [...text.matchAll(HANDLE_RE)]
    .map((m) => ({ value: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    .filter((h) => !within(emails, h.start, h.end));
}

/** Base58 addresses (32 bytes) and signatures (64 bytes, not a keypair), outside links. */
export function extractBase58(
  text: string,
  links: Found[] = extractLinks(text),
): { addresses: Found[]; signatures: Found[] } {
  const addresses: Found[] = [];
  const signatures: Found[] = [];
  for (const m of text.matchAll(BASE58_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (within(links, start, end)) continue;
    const kind = classifyBase58(m[0]);
    if (kind === "address") addresses.push({ value: m[0], start, end });
    else if (kind === "signature") signatures.push({ value: m[0], start, end });
  }
  return { addresses, signatures };
}
