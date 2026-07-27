import type { Prisma } from "@prisma/client";
import { transitionFindingStatus } from "../domain/finding-transitions.js";
import { evaluateRoutingPolicy, type RoutingDecisionResult, type RoutingPolicyInput } from "./routing-policy.js";

export interface ApplyRoutingPolicyParams {
  runId: string;
  findingId: string;
  input: RoutingPolicyInput;
}

/**
 * Evaluates the routing policy, records the decision (policy version,
 * inputs, decision, human-readable reason) as an immutable RoutingDecision
 * row, and — only on escalation — advances the finding to
 * `validation_queued` via the sanctioned state transition. The finding must
 * already be `source_confirmed`; the state machine enforces that.
 */
export async function applyRoutingPolicy(
  tx: Prisma.TransactionClient,
  params: ApplyRoutingPolicyParams,
): Promise<RoutingDecisionResult> {
  const result = evaluateRoutingPolicy(params.input);

  await tx.routingDecision.create({
    data: {
      runId: params.runId,
      findingId: params.findingId,
      policyVersion: result.policyVersion,
      inputs: result.inputs as unknown as Prisma.InputJsonValue,
      escalate: result.decision === "escalate",
      reason: result.reason,
    },
  });

  if (result.decision === "escalate") {
    await transitionFindingStatus(tx, {
      findingId: params.findingId,
      to: "validation_queued",
      actor: { type: "system" },
      eventType: "finding.validation_queued",
      runId: params.runId,
      metadata: { reason: result.reason, policyVersion: result.policyVersion },
    });
  }

  return result;
}
