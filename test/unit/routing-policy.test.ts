import { describe, expect, it } from "vitest";
import { evaluateRoutingPolicy, type RoutingPolicyInput } from "../../src/policy/routing-policy.js";

function baseInput(overrides: Partial<RoutingPolicyInput> = {}): RoutingPolicyInput {
  return {
    severity: "medium",
    confidence: "medium",
    category: "misc",
    targetAuthorized: true,
    targetIsProduction: false,
    canBeExercisedDynamically: true,
    alreadyTestedAgainstBuild: false,
    remainingBudgetUsd: 50,
    estimatedValidationCostUsd: 2,
    policyVersion: "2026-01-01",
    ...overrides,
  };
}

describe("evaluateRoutingPolicy — escalation rules", () => {
  it("escalates on critical severity alone", () => {
    const result = evaluateRoutingPolicy(baseInput({ severity: "critical", confidence: "low" }));
    expect(result.decision).toBe("escalate");
  });

  it("escalates on high severity with high confidence", () => {
    const result = evaluateRoutingPolicy(baseInput({ severity: "high", confidence: "high" }));
    expect(result.decision).toBe("escalate");
  });

  it("does not escalate on high severity with only medium confidence (no other trigger)", () => {
    const result = evaluateRoutingPolicy(baseInput({ severity: "high", confidence: "medium" }));
    expect(result.decision).toBe("skip");
  });

  it.each(["authentication", "authorization", "tenant-isolation", "payment-manipulation", "business-logic"])(
    "escalates when category is %s regardless of severity/confidence",
    (category) => {
      const result = evaluateRoutingPolicy(baseInput({ category, severity: "medium", confidence: "low" }));
      expect(result.decision).toBe("escalate");
    },
  );

  it("category matching is case-insensitive", () => {
    const result = evaluateRoutingPolicy(baseInput({ category: "Authorization" }));
    expect(result.decision).toBe("escalate");
  });

  it("escalates when runtime behavior is required to establish impact", () => {
    const result = evaluateRoutingPolicy(baseInput({ runtimeBehaviorRequired: true, severity: "medium" }));
    expect(result.decision).toBe("escalate");
  });

  it("produces a human-readable reason matching the spec's worked example shape", () => {
    const result = evaluateRoutingPolicy(
      baseInput({ category: "authorization", severity: "high", confidence: "high" }),
    );
    expect(result.reason).toContain("Strix validation was requested because");
    expect(result.reason).toContain("high-confidence");
    expect(result.reason).toContain("high-severity");
    expect(result.reason).toContain("authorization");
  });

  it("records the policy version and full input snapshot", () => {
    const input = baseInput({ severity: "critical" });
    const result = evaluateRoutingPolicy(input);
    expect(result.policyVersion).toBe("2026-01-01");
    expect(result.inputs).toEqual(input);
  });
});

describe("evaluateRoutingPolicy — non-escalation (hard gates)", () => {
  it("never escalates an unauthorized target, even for a critical finding", () => {
    const result = evaluateRoutingPolicy(baseInput({ severity: "critical", targetAuthorized: false }));
    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/not authorized/i);
  });

  it("never escalates a production target", () => {
    const result = evaluateRoutingPolicy(baseInput({ severity: "critical", targetIsProduction: true }));
    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/production/i);
  });

  it("skips a finding that cannot be exercised dynamically", () => {
    const result = evaluateRoutingPolicy(baseInput({ severity: "critical", canBeExercisedDynamically: false }));
    expect(result.decision).toBe("skip");
  });

  it("skips low and info severity findings", () => {
    expect(evaluateRoutingPolicy(baseInput({ severity: "low", category: "authorization" })).decision).toBe("skip");
    expect(evaluateRoutingPolicy(baseInput({ severity: "info", category: "authorization" })).decision).toBe("skip");
  });

  it("skips a code-quality issue even with a high severity label", () => {
    const result = evaluateRoutingPolicy(baseInput({ severity: "critical", isCodeQualityIssue: true }));
    expect(result.decision).toBe("skip");
  });

  it("skips a finding already tested against this exact build", () => {
    const result = evaluateRoutingPolicy(baseInput({ severity: "critical", alreadyTestedAgainstBuild: true }));
    expect(result.decision).toBe("skip");
  });

  it("skips when the run has exceeded its budget", () => {
    const result = evaluateRoutingPolicy(
      baseInput({ severity: "critical", remainingBudgetUsd: 1, estimatedValidationCostUsd: 5 }),
    );
    expect(result.decision).toBe("skip");
    expect(result.reason).toMatch(/budget/i);
  });

  it("skips when no escalation rule is matched", () => {
    const result = evaluateRoutingPolicy(baseInput({ severity: "medium", confidence: "low", category: "style" }));
    expect(result.decision).toBe("skip");
  });

  it("hard gates take precedence over escalation signals", () => {
    const result = evaluateRoutingPolicy(
      baseInput({ severity: "critical", category: "authentication", targetAuthorized: false }),
    );
    expect(result.decision).toBe("skip");
  });
});
