import { describe, expect, it } from "vitest";

import { hardAnswers } from "../src/canon";
import { screenInput } from "../src/guards";
import { degradedTemplate, pinnedTemplate, quickSmallTalk } from "../src/pipeline/templates";

const pin = (text: string) => screenInput(text, { hardAnswers }).floors.pin ?? null;

describe("answers that need no model", () => {
  it("recognises greetings and thanks, and nothing longer", () => {
    for (const hi of ["Привет", "привет!", "Здравствуйте", "hi", "Hello!", "Hola", "こんにちは"])
      expect(quickSmallTalk(hi), hi).toBe("greeting");
    for (const ty of [
      "Спасибо",
      "спасибо большое!",
      "Thanks!",
      "thank you so much",
      "danke",
      "gracias",
    ])
      expect(quickSmallTalk(ty), ty).toBe("thanks");
    for (const q of [
      "Привет, как работают выплаты?",
      "Спасибо, а когда выплаты?",
      "Как зарабатывать с Seasons?",
    ])
      expect(quickSmallTalk(q), q).toBeNull();
  });

  it("pins the everyday money questions, so an outage still gets the approved answer", () => {
    expect(pin("Как зарабатывать с Seasons?")).toBe("HA-RETURNS");
    expect(pin("Когда я начну зарабатывать?")).toBe("HA-RETURNS");
    expect(pin("Через сколько я верну свои деньги?")).toBe("HA-PAYBACK");
    expect(pin("How do I earn with Seasons?")).toBe("HA-RETURNS");
    expect(pin("Can you guarantee I won't lose money?")).toBe("HA-RETURNS");
  });

  it("never dead-ends: without a pin the fallback offers topics in the user's language", () => {
    expect(pinnedTemplate(null, "ru")).toBe(degradedTemplate("ru"));
    expect(degradedTemplate("ru")).toMatch(/выплаты Seasons.*Director-нодой/);
    expect(degradedTemplate("en")).toMatch(/pick a topic/);
  });
});
