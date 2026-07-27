import { describe, expect, it } from "vitest";
import { resolveFindingStatusFromValidation } from "../../src/correlation/resolve-finding-status.js";

describe("resolveFindingStatusFromValidation", () => {
  it("maps confirmed to confirmed when the build matches and the test was complete", () => {
    expect(resolveFindingStatusFromValidation({ verdict: "confirmed", buildMatches: true, testComplete: true })).toBe(
      "confirmed",
    );
  });

  it("maps not_reproduced to not_reproduced when the build matches and the test was complete", () => {
    expect(
      resolveFindingStatusFromValidation({ verdict: "not_reproduced", buildMatches: true, testComplete: true }),
    ).toBe("not_reproduced");
  });

  it("collapses not_reproduced to inconclusive on a build mismatch", () => {
    expect(
      resolveFindingStatusFromValidation({ verdict: "not_reproduced", buildMatches: false, testComplete: true }),
    ).toBe("inconclusive");
  });

  it("collapses confirmed to inconclusive on a build mismatch", () => {
    expect(resolveFindingStatusFromValidation({ verdict: "confirmed", buildMatches: false, testComplete: true })).toBe(
      "inconclusive",
    );
  });

  it("collapses not_reproduced to inconclusive when the test was incomplete", () => {
    expect(
      resolveFindingStatusFromValidation({ verdict: "not_reproduced", buildMatches: true, testComplete: false }),
    ).toBe("inconclusive");
  });

  it("returns null for a failed execution regardless of build/completeness", () => {
    expect(resolveFindingStatusFromValidation({ verdict: "failed", buildMatches: true, testComplete: true })).toBeNull();
    expect(resolveFindingStatusFromValidation({ verdict: "failed", buildMatches: false, testComplete: false })).toBeNull();
  });

  it("passes through an already-inconclusive verdict", () => {
    expect(
      resolveFindingStatusFromValidation({ verdict: "inconclusive", buildMatches: true, testComplete: true }),
    ).toBe("inconclusive");
  });
});
