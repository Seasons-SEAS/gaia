import { describe, expect, it } from "vitest";

import { answerShape } from "../src/pipeline/turn";
import type { Receipt } from "../src/types";

const receipt = (id: string) =>
  ({ id, kind: "chain", label: id, locator: id, value: "1" }) as unknown as Receipt;
const turn = (over: Partial<Parameters<typeof answerShape>[0]> = {}) =>
  answerShape({ mode: "normal", grateful: false, template: false, chainChecked: false, receipts: [], ...over });

describe("answer symbols (a few only)", () => {
  it("guards with a shield, thanks with a heart", () => {
    expect(turn({ mode: "guarded" })).toBe("shield");
    expect(turn({ mode: "safety_alert", template: true })).toBe("shield");
    expect(turn({ mode: "brief_plus_bridge", grateful: true })).toBe("heart");
  });
  it("checks answers read from the chain, whatever the topic", () => {
    expect(turn({ chainChecked: true, receipts: [receipt("r:schedule:next")] })).toBe("check");
    expect(turn({ mode: "sensitive_financial", chainChecked: true })).toBe("check");
  });
  it("draws nothing for other answers and templates", () => {
    expect(turn()).toBeNull();
    expect(turn({ mode: "sensitive_financial" })).toBeNull();
    expect(turn({ template: true, chainChecked: true })).toBeNull();
  });
});
