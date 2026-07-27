import { describe, expect, it } from "vitest";
import { determineVerificationOutcome } from "../../src/remediation/determine-verification-outcome.js";

describe("determineVerificationOutcome — source-only finding", () => {
  it("verified_fixed when source revalidation passes", () => {
    expect(
      determineVerificationOutcome({
        sourceRevalidationPassed: true,
        runtimeRetestRequired: false,
        runtimeRetestPassed: null,
        targetBuildMatchesFixCommit: false,
      }),
    ).toBe("verified_fixed");
  });

  it("still_exploitable when source revalidation fails", () => {
    expect(
      determineVerificationOutcome({
        sourceRevalidationPassed: false,
        runtimeRetestRequired: false,
        runtimeRetestPassed: null,
        targetBuildMatchesFixCommit: false,
      }),
    ).toBe("still_exploitable");
  });
});

describe("determineVerificationOutcome — operational failures", () => {
  it("verification_failed when the process itself reports an operational failure", () => {
    expect(
      determineVerificationOutcome({
        sourceRevalidationPassed: true,
        runtimeRetestRequired: false,
        runtimeRetestPassed: null,
        targetBuildMatchesFixCommit: false,
        operationalFailure: true,
      }),
    ).toBe("verification_failed");
  });

  it("verification_failed when source revalidation produced no verdict at all", () => {
    expect(
      determineVerificationOutcome({
        sourceRevalidationPassed: null,
        runtimeRetestRequired: false,
        runtimeRetestPassed: null,
        targetBuildMatchesFixCommit: false,
      }),
    ).toBe("verification_failed");
  });
});

describe("determineVerificationOutcome — runtime-confirmed finding", () => {
  it("verified_fixed requires source pass + build match + runtime pass, all three", () => {
    expect(
      determineVerificationOutcome({
        sourceRevalidationPassed: true,
        runtimeRetestRequired: true,
        runtimeRetestPassed: true,
        targetBuildMatchesFixCommit: true,
      }),
    ).toBe("verified_fixed");
  });

  it("inconclusive when the target build does not match the fix commit, even if both checks would pass", () => {
    expect(
      determineVerificationOutcome({
        sourceRevalidationPassed: true,
        runtimeRetestRequired: true,
        runtimeRetestPassed: true,
        targetBuildMatchesFixCommit: false,
      }),
    ).toBe("inconclusive");
  });

  it("inconclusive when the runtime retest itself produced no verdict", () => {
    expect(
      determineVerificationOutcome({
        sourceRevalidationPassed: true,
        runtimeRetestRequired: true,
        runtimeRetestPassed: null,
        targetBuildMatchesFixCommit: true,
      }),
    ).toBe("inconclusive");
  });

  it("still_exploitable when both source and runtime checks fail", () => {
    expect(
      determineVerificationOutcome({
        sourceRevalidationPassed: false,
        runtimeRetestRequired: true,
        runtimeRetestPassed: false,
        targetBuildMatchesFixCommit: true,
      }),
    ).toBe("still_exploitable");
  });

  it("partially_fixed when source passes but the exploit still succeeds", () => {
    expect(
      determineVerificationOutcome({
        sourceRevalidationPassed: true,
        runtimeRetestRequired: true,
        runtimeRetestPassed: false,
        targetBuildMatchesFixCommit: true,
      }),
    ).toBe("partially_fixed");
  });

  it("partially_fixed when the exploit no longer succeeds but source revalidation still flags the issue", () => {
    expect(
      determineVerificationOutcome({
        sourceRevalidationPassed: false,
        runtimeRetestRequired: true,
        runtimeRetestPassed: true,
        targetBuildMatchesFixCommit: true,
      }),
    ).toBe("partially_fixed");
  });

  it("an agent's claim alone (no checks actually run) cannot produce verified_fixed", () => {
    const outcome = determineVerificationOutcome({
      sourceRevalidationPassed: null,
      runtimeRetestRequired: true,
      runtimeRetestPassed: null,
      targetBuildMatchesFixCommit: false,
    });
    expect(outcome).not.toBe("verified_fixed");
  });
});
