import type { PrismaClient } from "@prisma/client";
import type { AuditActor } from "../audit/audit-log.js";
import { transitionFindingStatus } from "../domain/finding-transitions.js";
import { NotFoundError, DomainError } from "../domain/errors.js";

export class RemediationNotFoundError extends DomainError {}

export interface StartFixVerificationParams {
  findingId: string;
  organizationId: string;
  repositoryId: string;
  requestedByAgentId: string;
  targetEnvironmentId?: string;
  policyVersion: string;
  idempotencyKey: string;
  actor: AuditActor;
}

export interface StartFixVerificationOutcome {
  runId: string;
  requiresRuntimeRetest: boolean;
  fixCommitSha: string;
}

/**
 * Begins verification for a submitted fix: creates the fix_verification
 * run (left at its default `queued` status — the job pipeline advances it
 * the same way it would any other run) and moves the finding
 * fix_submitted -> retesting. Job dispatch (run_deepsec_revalidation, and
 * run_strix_retest when required) is the caller's responsibility.
 */
export async function startFixVerification(
  prisma: PrismaClient,
  params: StartFixVerificationParams,
): Promise<StartFixVerificationOutcome> {
  return prisma.$transaction(async (tx) => {
    const finding = await tx.finding.findUnique({ where: { id: params.findingId } });
    if (!finding) {
      throw new NotFoundError(`Finding ${params.findingId} not found`);
    }
    const remediation = await tx.remediation.findUnique({ where: { findingId: params.findingId } });
    if (!remediation) {
      throw new RemediationNotFoundError(`No fix has been submitted for finding ${params.findingId}`);
    }

    const run = await tx.securityRun.create({
      data: {
        organizationId: params.organizationId,
        repositoryId: params.repositoryId,
        requestedByAgentId: params.requestedByAgentId,
        runType: "fix_verification",
        baseSha: finding.lastSeenCommit,
        headSha: remediation.fixCommitSha,
        targetEnvironmentId: params.targetEnvironmentId,
        policyVersion: params.policyVersion,
        idempotencyKey: params.idempotencyKey,
      },
    });

    await transitionFindingStatus(tx, {
      findingId: finding.id,
      to: "retesting",
      actor: params.actor,
      eventType: "finding.retesting",
      runId: run.id,
      metadata: { fixCommitSha: remediation.fixCommitSha },
    });

    return {
      runId: run.id,
      requiresRuntimeRetest: remediation.runtimeRetestStatus !== "not_applicable",
      fixCommitSha: remediation.fixCommitSha,
    };
  });
}
