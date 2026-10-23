/**
 * Link and address verdicts against the Official Registry.
 * The wording never turns "not in my list" into "not Seasons": a host or
 * address can be connected to Seasons without being a public user service,
 * and a screenshot of "GAIA says this isn't Seasons" must never be possible.
 * Matching is exact host+path; there are no wildcards.
 */
import { classifyBase58 } from "./base58";
import { normalizeHost, refang, splitLink } from "./extract";
import { editDistance, skeleton } from "./text";

import type { RegistryEntry } from "../types";

export type Verdict =
  | "official"
  | "outdated"
  | "lookalike"
  | "not_in_registry"
  | "seasons_subdomain_unlisted";

export interface VerifyVerdict {
  verdict: Verdict;
  label?: string;
  message: string;
  defanged?: string;
}

export const MSG = {
  official: "Official: in the Seasons public registry",
  outdated: "An old official handle or link; use this one instead",
  lookalikeDomain: "Not an official Seasons domain: look-alike",
  lookalikeAddress: "Not an official Seasons address: look-alike",
  lookalikeHandle: "Not an official Seasons handle: look-alike",
  notInRegistry:
    "Not in the official public registry. That doesn't mean it's unrelated to Seasons; it means I can't vouch for it. Don't send funds or sign anything based on it.",
  subdomain: (parent: string) =>
    `A ${parent} subdomain that isn't a public user service. Don't connect a wallet there.`,
} as const;

// Handles on these hosts are case-insensitive; other paths (e.g. a Solscan mint) are not.
const SOCIAL_HOSTS = new Set([
  "t.me",
  "telegram.me",
  "x.com",
  "twitter.com",
  "instagram.com",
  "youtube.com",
  "facebook.com",
  "discord.gg",
  "discord.com",
  "github.com",
  "linkedin.com",
  "tiktok.com",
  "medium.com",
  "reddit.com",
  "linktr.ee",
  "warpcast.com",
]);

/** `seasons-wtf[.]app`: the last dot of the host is bracketed, the scheme disarmed. */
export function defang(link: string): string {
  const scheme = /^(?:https?|hxxps?):\/\//i.exec(link)?.[0] ?? "";
  const rest = link.slice(scheme.length);
  const hostEnd = rest.search(/[/?#]/);
  const host = hostEnd < 0 ? rest : rest.slice(0, hostEnd);
  const tail = hostEnd < 0 ? "" : rest.slice(hostEnd);
  const dot = host.lastIndexOf(".");
  const safeHost = dot < 0 ? host : `${host.slice(0, dot)}[.]${host.slice(dot + 1)}`;
  return `${scheme.replace(/^http/i, "hxxp")}${safeHost}${tail}`;
}

interface ParsedEntry {
  entry: RegistryEntry;
  host?: string;
  path?: string;
  handle?: string;
}

function parseEntry(entry: RegistryEntry): ParsedEntry {
  const v = entry.value.trim();
  if (entry.kind === "handle") return { entry, handle: v.replace(/^@/, "").toLowerCase() };
  if (entry.kind === "domain")
    return {
      entry,
      host: normalizeHost(v.replace(/^(?:https?):\/\//i, "").split(/[/?#]/)[0] ?? ""),
    };
  if (entry.kind === "url") {
    const { host, path } = splitLink(v);
    const handle = SOCIAL_HOSTS.has(host)
      ? path.split("/")[1]?.replace(/^@/, "").toLowerCase()
      : undefined;
    return { entry, host, path, handle };
  }
  return { entry };
}

const samePath = (host: string, a: string, b: string) =>
  SOCIAL_HOSTS.has(host) ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The registry entry a link resolves to exactly, if any. */
export function matchLink(
  host: string,
  path: string,
  registry: RegistryEntry[],
): RegistryEntry | null {
  const parsed = registry.map(parseEntry);
  // A url entry pins host AND path; a domain entry covers its host only.
  for (const p of parsed)
    if (p.entry.kind === "url" && p.host === host && samePath(host, p.path ?? "", path))
      return p.entry;
  for (const p of parsed) if (p.entry.kind === "domain" && p.host === host) return p.entry;
  if (SOCIAL_HOSTS.has(host)) {
    const handle = path.split("/")[1]?.replace(/^@/, "").toLowerCase();
    if (handle)
      for (const p of parsed) if (p.entry.kind === "handle" && p.handle === handle) return p.entry;
  }
  return null;
}

function replacementFor(
  entry: RegistryEntry,
  registry: RegistryEntry[],
): RegistryEntry | undefined {
  const label = entry.label
    .toLowerCase()
    .replace(/\s*\((?:old|outdated|legacy|inactive)\)\s*/g, "")
    .trim();
  return registry.find(
    (e) =>
      e.status === "official" &&
      e !== entry &&
      e.label
        .toLowerCase()
        .replace(/\s*\((?:old|outdated|legacy|inactive)\)\s*/g, "")
        .trim() === label,
  );
}

function knownVerdict(
  entry: RegistryEntry,
  display: string,
  registry: RegistryEntry[],
): VerifyVerdict {
  if (entry.status === "official")
    return {
      verdict: "official",
      label: entry.label,
      message: `${MSG.official}. ${entry.label}: ${display}`,
    };
  const next = replacementFor(entry, registry);
  return {
    verdict: "outdated",
    label: entry.label,
    message: next ? `${MSG.outdated}: ${next.value}` : `${MSG.outdated}.`,
  };
}

/** Human-readable difference, e.g. `"о" (U+043E) where the official one has "o"`. */
function describeDiff(input: string, official: string): string {
  if (input.length === official.length) {
    const diffs: string[] = [];
    for (let i = 0; i < input.length; i++) {
      if (input[i] !== official[i]) {
        const cp = input.codePointAt(i)!.toString(16).toUpperCase().padStart(4, "0");
        diffs.push(
          `"${input[i]}" (U+${cp}) at position ${i + 1} where the official one has "${official[i]}"`,
        );
      }
    }
    if (diffs.length && diffs.length <= 3) return diffs.join("; ");
  }
  return `the official one is ${official}`;
}

function brandOf(host: string): string | null {
  const labels = host.split(".");
  const brand = labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!;
  return brand.length >= 5 ? skeleton(brand) : null;
}

/** The official host this one imitates: homoglyph skeleton, small edit distance, or the brand inside it. */
function lookalikeOf(
  host: string,
  officialHosts: string[],
  seasonsBrands: string[],
): string | null {
  const sk = skeleton(host);
  for (const o of officialHosts) {
    if (host === o) continue;
    if (sk === skeleton(o)) return o;
    const max = o.length >= 10 ? 2 : o.length >= 6 ? 1 : 0;
    if (max && editDistance(sk, skeleton(o), max) <= max) return o;
  }
  const flat = sk.replace(/[.\-_]/g, "");
  const parts = sk.split(/[.\-_]/);
  for (const brand of seasonsBrands) {
    if (
      parts.some((p) => p.length >= 4 && editDistance(p, brand, 1) <= 1) ||
      flat.includes(brand)
    ) {
      return officialHosts.find((o) => skeleton(o).includes(brand)) ?? officialHosts[0] ?? null;
    }
  }
  return null;
}

/** verify_link: a URL, a bare domain, a t.me/x.com link or an @handle. */
export function verifyLink(input: string, registry: RegistryEntry[]): VerifyVerdict {
  const raw = refang(input.trim().replace(/^[<("'“«]+|[>)"'”».,;!?]+$/g, ""));
  const official = registry.filter(
    (e) => e.status === "official" || e.status === "outdated" || e.status === "inactive",
  );
  const parsed = official.map(parseEntry);

  if (/^@[A-Za-z0-9_]{2,}$/.test(raw)) {
    const handle = raw.slice(1).toLowerCase();
    const hit = parsed.find((p) => p.handle === handle);
    if (hit) return knownVerdict(hit.entry, raw, registry);
    const sk = skeleton(handle);
    const like = parsed.find(
      (p) =>
        p.handle &&
        p.handle.length >= 5 &&
        (skeleton(p.handle) === sk || editDistance(sk, skeleton(p.handle), 2) <= 2),
    );
    if (like)
      return {
        verdict: "lookalike",
        label: like.entry.label,
        message: `${MSG.lookalikeHandle}; ${describeDiff(handle, like.handle!)}.`,
      };
    return { verdict: "not_in_registry", message: MSG.notInRegistry };
  }

  const { host, path } = splitLink(raw);
  const display = raw;
  const exact = matchLink(host, path, official);
  if (exact) return knownVerdict(exact, display, registry);

  const domainHosts = parsed
    .filter((p) => p.entry.kind === "domain" && p.entry.status === "official")
    .map((p) => p.host!);
  const parent = domainHosts.find((d) => host.endsWith(`.${d}`));
  if (parent)
    return {
      verdict: "seasons_subdomain_unlisted",
      message: MSG.subdomain(parent),
      defanged: defang(display),
    };

  // A handle on a social host that imitates an official one.
  if (SOCIAL_HOSTS.has(host)) {
    const handle = path.split("/")[1]?.replace(/^@/, "").toLowerCase();
    if (handle) {
      const sk = skeleton(handle);
      const like = parsed.find(
        (p) =>
          p.handle &&
          p.handle.length >= 5 &&
          (skeleton(p.handle) === sk || editDistance(sk, skeleton(p.handle), 2) <= 2),
      );
      if (like)
        return {
          verdict: "lookalike",
          label: like.entry.label,
          message: `${MSG.lookalikeHandle}; ${describeDiff(handle, like.handle!)}.`,
          defanged: defang(display),
        };
    }
    return { verdict: "not_in_registry", message: MSG.notInRegistry, defanged: defang(display) };
  }

  const allHosts = [
    ...new Set(parsed.filter((p) => p.host && !SOCIAL_HOSTS.has(p.host)).map((p) => p.host!)),
  ];
  const brands = [...new Set(domainHosts.map(brandOf).filter((b): b is string => Boolean(b)))];
  const like = lookalikeOf(host, allHosts, brands);
  if (like) {
    return {
      verdict: "lookalike",
      message: `${MSG.lookalikeDomain}; ${describeDiff(host, like)}.`,
      defanged: defang(display),
    };
  }
  return { verdict: "not_in_registry", message: MSG.notInRegistry, defanged: defang(display) };
}

/** verify_address: exact registry match, address-poisoning look-alikes, else "can't vouch". */
export function verifyAddress(address: string, registry: RegistryEntry[]): VerifyVerdict {
  const a = address.trim();
  const entries = registry.filter((e) => e.kind === "address");
  const exact = entries.find((e) => e.value === a);
  if (exact) return knownVerdict(exact, a, registry);
  for (const e of entries.filter((x) => x.status === "official")) {
    const poisoned =
      a.length >= 32 && a.slice(0, 4) === e.value.slice(0, 4) && a.slice(-4) === e.value.slice(-4);
    if (poisoned || editDistance(a, e.value, 2) <= 2) {
      return {
        verdict: "lookalike",
        label: e.label,
        message: `${MSG.lookalikeAddress}. It resembles ${e.label} (${e.value}) but isn't the same; compare every character.`,
      };
    }
  }
  const valid = classifyBase58(a) === "address";
  return {
    verdict: "not_in_registry",
    message: valid
      ? MSG.notInRegistry
      : `${MSG.notInRegistry} It also isn't a valid Solana address.`,
  };
}
