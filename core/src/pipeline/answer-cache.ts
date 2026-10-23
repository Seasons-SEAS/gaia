import type { GaiaShape, GuardResult, Mode, Receipt } from "../types";

/**
 * A short-lived cache of verified answers to the same question (most often a
 * suggestion chip people tap). A hit answers at once, with no model call
 * (no Opus, no Haiku). It is deliberately narrow: only a fresh question with
 * nothing personal in it, only a verified answer that used no personal tool,
 * and only for a few minutes, since answers carry live chain readings.
 */
export const ANSWER_TTL_SECONDS = 600;
const VERSION = "a1";

/** Tools whose results depend on what this user gave (a wallet, a link, a transfer) or that act for them. */
const PERSONAL_TOOLS = new Set([
  "get_wallet_tier",
  "verify_address",
  "verify_link",
  "preflight_transfer",
  "queue_for_team",
]);
const CACHEABLE_MODES = new Set<Mode>(["normal", "trust_question", "sensitive_financial", "brief_plus_bridge"]);

export interface CachedAnswer {
  text: string;
  followup: string | null;
  shape: GaiaShape | null;
  mode: Mode;
  verifier: "pass" | "repaired";
  receipts: Receipt[];
  /** When it was answered (ms since epoch). */
  at: number;
}

/** The question as a cache key, or null when it must be answered afresh. */
export function answerKey(
  guard: GuardResult,
  context: { continues: boolean; lang: string; layer: string; model: string; canon: string },
): string | null {
  if (context.continues) return null;
  if (guard.secret !== "none" || guard.injectionSignals.length || guard.floors.safety) return null;
  if (guard.links.length || guard.addresses.length || guard.signatures.length) return null;
  const question = guard.text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$%\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Amounts, dates, rates: the answer would depend on the user's own numbers.
  if (/\d/.test(question)) return null;
  const words = question.split(" ").filter(Boolean).length;
  if (words < 3 || question.length > 200) return null;
  return `answer:${VERSION}:${context.canon}:${context.model}:${context.lang}:${context.layer}:${question}`;
}

/** Whether a finished answer may be served again to the same question. */
export function mayCache(outcome: { mode: Mode; verifier: string }, toolsUsed: Iterable<string>): boolean {
  if (!CACHEABLE_MODES.has(outcome.mode)) return false;
  if (outcome.verifier !== "pass" && outcome.verifier !== "repaired") return false;
  for (const tool of toolsUsed) if (PERSONAL_TOOLS.has(tool)) return false;
  return true;
}
