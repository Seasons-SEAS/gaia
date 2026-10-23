import { describe, expect, it } from "vitest";

import { spokenText } from "../src/voice/elevenlabs";

describe("spoken text", () => {
  it("reads the ticker as the word Seas, never as dollars or letters", () => {
    expect(spokenText("Hold 10,000 $SEAS to be a Director.")).toBe(
      "Hold 10,000 Seas to be a Director.",
    );
    expect(spokenText("Держите $SEAS в своём кошельке")).toBe("Держите Seas в своём кошельке");
    expect(spokenText("The SEAS supply is fixed.")).toBe("The Seas supply is fixed.");
  });

  it("keeps real dollar amounts and the word count", () => {
    const text = "The round paid about $5,858 to $SEAS Directors.";
    expect(spokenText(text)).toBe("The round paid about $5,858 to Seas Directors.");
    expect(spokenText(text).split(" ").length).toBe(text.split(" ").length);
  });
});
