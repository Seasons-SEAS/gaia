import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { getHardAnswer, registry } from "../src/canon";
import { almanacReceipts, relevantAlmanac } from "../src/pipeline/almanac";
import { founderGateViolations } from "../src/pipeline/founder-gates";
import { verifyDraft } from "../src/verify";

import type { Mode, VerifyContext } from "../src/types";

/**
 * The eval set's output_screen items: bad draft replies that the
 * deterministic layer (verifier + founder gates) must catch before the
 * semantic post-check even runs. No live receipts exist in these turns, so
 * only the Almanac vouches for numbers.
 */
type Item = {
  id: string;
  lang: string;
  question: string;
  candidate_reply?: string;
  expect_verifier?: "block" | "flag";
  expect_mode?: Mode | Mode[];
  expect_pin?: string;
};

const items = (
  YAML.parse(readFileSync(new URL("../evals/seed.yaml", import.meta.url), "utf8")) as Item[]
).filter((item) => item.candidate_reply);
const almanac = almanacReceipts();

function screen(item: Item) {
  const mode = [item.expect_mode ?? "normal"].flat()[0] as Mode;
  const ctx: VerifyContext = {
    mode,
    lang: item.lang,
    receipts: relevantAlmanac(item.candidate_reply!, almanac),
    userText: item.question,
    pinned: item.expect_pin ? (getHardAnswer(item.expect_pin) ?? null) : null,
    registry,
  };
  const draft = item.candidate_reply!;
  return [...verifyDraft(draft, ctx).violations, ...founderGateViolations(draft)];
}

describe("eval output_screen items", () => {
  it("has items to screen", () => expect(items.length).toBeGreaterThan(5));

  for (const item of items)
    it(`${item.id} [${item.lang}] is caught`, () => {
      const violations = screen(item);
      // Portuguese has no lexicon yet (tier C): the semantic post-check covers it.
      if (item.lang === "pt") return;
      expect(violations.length, `${item.candidate_reply}`).toBeGreaterThan(0);
      if (item.expect_verifier === "block" && [item.expect_mode].flat()[0] !== "normal")
        expect(violations.some((v) => v.severity === "block")).toBe(true);
    });
});
