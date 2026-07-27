import type { FindingConfidence, FindingSeverity } from "@prisma/client";

export type RoutingDecisionOutcome = "escalate" | "skip";

export interface RoutingPolicyInput {
  severity: FindingSeverity;
  confidence: FindingConfidence;
  category: string;
  /** Analyst/classifier signal that this is a lint-style issue, not a security finding. */
  isCodeQualityIssue?: boolean;
  /** True when dynamic behavior is required to establish real-world impact. */
  runtimeBehaviorRequired?: boolean;
  targetAuthorized: boolean;
  /** Defensive input even though TargetEnvironmentType structurally excludes "production". */
  targetIsProduction?: boolean;
  canBeExercisedDynamically: boolean;
  /** Same finding fingerprint already validated against this exact target build. */
  alreadyTestedAgainstBuild: boolean;
  remainingBudgetUsd: number;
  estimatedValidationCostUsd: number;
  policyVersion: string;
}

export interface RoutingDecisionResult {
  decision: RoutingDecisionOutcome;
  reason: string;
  policyVersion: string;
  inputs: RoutingPolicyInput;
}

const AUTO_ESCALATE_CATEGORIES = new Set([
  "authentication",
  "authorization",
  "tenant-isolation",
  "payment-manipulation",
  "business-logic",
]);

function decide(decision: RoutingDecisionOutcome, reason: string, inputs: RoutingPolicyInput): RoutingDecisionResult {
  return { decision, reason, policyVersion: inputs.policyVersion, inputs };
}

/**
 * Pure decision function — no I/O. The "do not escalate" rules are hard
 * gates checked first and always win: a critical finding on an unauthorized
 * or production target, or one that has exhausted its budget, never
 * escalates regardless of how many escalation signals it matches.
 */
export function evaluateRoutingPolicy(input: RoutingPolicyInput): RoutingDecisionResult {
  if (!input.targetAuthorized) {
    return decide("skip", "The target environment is not authorized for testing.", input);
  }
  if (input.targetIsProduction) {
    return decide("skip", "The target is a production environment; production testing is disabled by default.", input);
  }
  if (!input.canBeExercisedDynamically) {
    return decide("skip", "This finding cannot be exercised dynamically (no reachable runtime surface).", input);
  }
  if (input.severity === "low" || input.severity === "info") {
    return decide("skip", `Severity is ${input.severity}, below the threshold for runtime validation.`, input);
  }
  if (input.isCodeQualityIssue) {
    return decide("skip", "This is a code-quality issue, not a security finding.", input);
  }
  if (input.alreadyTestedAgainstBuild) {
    return decide("skip", "This finding has already been tested against this exact target build.", input);
  }
  if (input.remainingBudgetUsd < input.estimatedValidationCostUsd) {
    return decide(
      "skip",
      `Estimated validation cost ($${input.estimatedValidationCostUsd.toFixed(2)}) exceeds the remaining budget ($${input.remainingBudgetUsd.toFixed(2)}).`,
      input,
    );
  }

  const normalizedCategory = input.category.trim().toLowerCase();
  const reasons: string[] = [];
  if (input.severity === "critical") reasons.push("severity is critical");
  if (input.severity === "high" && input.confidence === "high") reasons.push("severity is high with high confidence");
  if (AUTO_ESCALATE_CATEGORIES.has(normalizedCategory)) reasons.push(`category is "${normalizedCategory}"`);
  if (input.runtimeBehaviorRequired) reasons.push("runtime behavior is required to establish impact");

  if (reasons.length === 0) {
    return decide(
      "skip",
      "No escalation rule matched: severity, confidence, and category do not meet the automatic escalation bar.",
      input,
    );
  }

  const reason = `Strix validation was requested because this is a ${input.confidence}-confidence, ${input.severity}-severity ${normalizedCategory} finding (${reasons.join("; ")}).`;
  return decide("escalate", reason, input);
}
