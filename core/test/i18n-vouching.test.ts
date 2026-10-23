import { describe, expect, it } from "vitest";

import { getHardAnswer, hardAnswers } from "../src/canon";
import { almanacReceipts, relevantAlmanac } from "../src/pipeline/almanac";
import { PINNED_RU, pinnedTemplate } from "../src/pipeline/templates";

const ids = (text: string) => relevantAlmanac(text, almanacReceipts()).map((r) => r.id);

describe("Almanac topics in other languages", () => {
  it("vouches a Russian rate with the APY facts", () => {
    expect(ids("В раунде #84 ставка была около 20,17% годовых")).toContain(
      "r:almanac:apy.last_reported",
    );
    expect(ids("Доля распределённого дохода выросла")).toContain(
      "r:almanac:yield.distributed_share",
    );
  });

  it("still won't let a rate borrow the 8 from '8 decimals'", () => {
    expect(ids("ставка 8% годовых")).not.toContain("r:almanac:token.mint");
  });

  it("doesn't treat the ticker as a topic word", () => {
    expect(ids("$SEAS")).toEqual([]);
  });
});

describe("pinned fallback language", () => {
  it("has a Russian short form for every pinned answer", () => {
    for (const h of hardAnswers) expect(PINNED_RU[h.id], h.id).toMatch(/[а-яё]/i);
  });

  it("answers in the user's language", () => {
    const payback = getHardAnswer("HA-PAYBACK")!;
    expect(pinnedTemplate(payback, "ru")).toMatch(/комиссия 10%/);
    expect(pinnedTemplate(payback, "en")).toBe(payback.model_brief.short_form);
    expect(pinnedTemplate(payback, "de")).not.toBe(payback.model_brief.short_form);
  });
});
