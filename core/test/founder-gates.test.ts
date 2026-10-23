import { describe, expect, it } from "vitest";

import { founderGateViolations } from "../src/pipeline/founder-gates";

describe("founder gates", () => {
  it("blocks the fee-funded payout narrative while D3 is open", () => {
    expect(founderGateViolations("Payouts come from the 10% transfer fee.").length).toBeGreaterThan(
      0,
    );
    expect(founderGateViolations("The fee funds the payouts every round.").length).toBeGreaterThan(
      0,
    );
    expect(
      founderGateViolations("It mentions that the 10% fee funds Director node payouts.").length,
    ).toBeGreaterThan(0);
  });
  it("blocks internal wallet names", () => {
    expect(
      founderGateViolations("The YMS wallet sends $SEAS to the distributor.").length,
    ).toBeGreaterThan(0);
  });
  it("lets honest lines on other topics through", () => {
    expect(founderGateViolations("Token-2022 lets that key set any rate from 0 to 100%.")).toEqual(
      [],
    );
    expect(
      founderGateViolations(
        "A team-operated wallet sends $SEAS to the distributor, which swaps it into XAUt0, wBTC and jlUSDc.",
      ),
    ).toEqual([]);
  });
});
