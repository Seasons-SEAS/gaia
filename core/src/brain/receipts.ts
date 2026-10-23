import type { Receipt } from "../types";

/**
 * Receipts rendered once, as short lines grouped by source and read time.
 * Tool results, the per-turn message and the post-check all use this, so the
 * model and the judges read the same evidence in far fewer tokens than raw
 * JSON (the Receipt objects the verifier checks are unchanged).
 */
export function receiptBlock(receipts: Receipt[], { urls }: { urls: boolean }): string {
  const groups = new Map<string, Receipt[]>();
  for (const receipt of receipts) {
    const key = `${receipt.kind}, read ${receipt.read_at.replace(/\.\d{3}Z$/, "Z")}`;
    groups.set(key, [...(groups.get(key) ?? []), receipt]);
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [header, list] of groups) {
    lines.push(`[${header}]`);
    for (const r of list) {
      const link = urls && r.url && !seen.has(r.url) ? ` <${r.url}>` : "";
      if (r.url) seen.add(r.url);
      lines.push(`- ${r.label}: ${r.value}${link}`);
    }
  }
  return lines.join("\n");
}
