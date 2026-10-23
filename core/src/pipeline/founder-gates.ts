import { disputedClaims, facts } from "../canon";
import { splitSentences } from "../verify";

import type { Violation } from "../types";

/**
 * Claims that wait on a founder decision (canon status needs_founder) are
 * blocked until the founders decide: D3 how payouts are funded, D12 public
 * wallet names, D4 lock-bucket labels, D-VOL trading activity, D9 Growth use.
 * Each fact's `disputed` patterns only apply to sentences on that fact's
 * topic, so an honest line elsewhere ("any rate up to 100%") never trips them.
 */
const TOPIC: Record<string, RegExp> = {
  "funding.observed_path":
    /payout|round|distribut|yield|reward|fund|paid|pays|pay for|выплат|раунд|Auszahl|pago|配当|分配/i,
  "wallets.public_names": /wallet|кошел|Wallet|billetera|ウォレット/i,
  "locks.bucket_labels": /lock|unlock|escrow|vest|блок|Sperr|bloque|ロック/i,
  "market.trading_activity":
    /volume|trad(e|ing)|bots?\b|market[- ]?mak|organic|wash|объём|торг|Volumen|volumen|出来高/i,
  "growth.fund_use": /growth/i,
  "supply.allocation": /allocation|tokenomics|распредел|Verteilung|asignaci/i,
};

export function founderGateViolations(draft: string): Violation[] {
  const violations: Violation[] = [];
  const sentences = splitSentences(draft);
  for (const fact of facts) {
    if (fact.status !== "needs_founder") continue;
    const topic = TOPIC[fact.key];
    const patterns = disputedClaims(fact.key);
    for (const sentence of sentences) {
      if (topic && !topic.test(sentence)) continue;
      const hit = patterns.find((pattern) => pattern.test(sentence));
      if (hit)
        violations.push({
          check: "needs_founder",
          severity: "block",
          detail: `${fact.key} awaits a founder decision; say it with the approved interim wording instead: "${fact.text}"`,
          sentence,
        });
    }
  }
  return violations;
}
