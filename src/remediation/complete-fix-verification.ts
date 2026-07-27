import type { FindingStatus, PrismaClient, RemediationOutcome } from "@prisma/client";
import type { AuditActor } from "../audit/audit-log.js";
import { transitionFindingStatus } from "../domain/finding-transitions.js";
import { determineVerificationOutcome, type VerificationOutcome } from "./determine-verification-outcome.js";

export interface CompleteFixVerificationParams {
  findingId: string;
  runId: string;
  actor: AuditActor;
  sourceRevalidationPassed: boolean | null;
  runtimeRetestRequired: boolean;
  runtimeRetestPassed: boolean | null;
  targetBuildMatchesFixCommit: boolean;
  operationalFailure?: boolean;
}

export interface CompleteFixVerificationOutcome {
  outcome: VerificationOutcome;
  findingStatus: FindingStatus | null;
}

function boolToRemediationOutcome(passed: boolean | null): RemediationOutcome {
  if (passed === null) return "inconclusive";
  return passed ? "passed" : "failed";
}

// verification_failed is an operational outcome (tooling crashed) and
// leaves the finding untouched at `retesting` so it can be retried;
// partially_fixed has no dedicated finding state and maps to the FSM's
// general non-terminal negative outcome, `inconclusive`.
function outcomeToFindingStatus(outcome: VerificationOutcome): FindingStatus | null {
  switch (outcome) {
    case "verified_fixed":
      return "verified_fixed";
    case "still_exploitable":
      return "still_exploitable";
    case "partially_fixed":
    case "inconclusive":
      return "inconclusive";
    case "verification_failed":
      return null;
  }
}

/**
 * Applies the fix-verification decision and persists it: updates the
 * Remediation row's three constituent checks plus final status, and
 * transitions the finding to match — unless verification itself failed
 * operationally, in which case the finding is left alone for retry.
 */
export async function completeFixVerification(
  prisma: PrismaClient,
  params: CompleteFixVerificationParams,
): Promise<CompleteFixVerificationOutcome> {
  const outcome = determineVerificationOutcome({
    sourceRevalidationPassed: params.sourceRevalidationPassed,
    runtimeRetestRequired: params.runtimeRetestRequired,
    runtimeRetestPassed: params.runtimeRetestPassed,
    targetBuildMatchesFixCommit: params.targetBuildMatchesFixCommit,
    operationalFailure: params.operationalFailure,
  });

  return prisma.$transaction(async (tx) => {
    await tx.remediation.update({
      where: { findingId: params.findingId },
      data: {
        sourceRevalidationStatus: boolToRemediationOutcome(params.sourceRevalidationPassed),
        runtimeRetestStatus: params.runtimeRetestRequired
          ? boolToRemediationOutcome(params.runtimeRetestPassed)
          : "not_applicable",
        finalStatus: outcome,
      },
    });

    const findingStatus = outcomeToFindingStatus(outcome);
    if (findingStatus) {
      await transitionFindingStatus(tx, {
        findingId: params.findingId,
        to: findingStatus,
        actor: params.actor,
        eventType: `finding.${findingStatus}`,
        runId: params.runId,
        metadata: { verificationOutcome: outcome },
      });
    }

    return { outcome, findingStatus };
  });
}
