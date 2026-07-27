import type { FindingStatus, PrismaClient } from "@prisma/client";
import type { AuditActor } from "../audit/audit-log.js";
import { transitionFindingStatus } from "../domain/finding-transitions.js";
import { NotFoundError } from "../domain/errors.js";

export interface SubmitFixParams {
  findingId: string;
  fixCommitSha: string;
  actor: AuditActor;
}

export interface SubmitFixOutcome {
  remediationId: string;
  findingStatus: FindingStatus;
  requiresRuntimeRetest: boolean;
}

// States a fix can be submitted from. still_exploitable covers a second
// (or third) attempt after a prior fix didn't work.
const HOP_TO_FIX_PENDING_FROM: readonly FindingStatus[] = [
  "source_confirmed",
  "confirmed",
  "not_reproduced",
  "inconclusive",
  "still_exploitable",
];

/**
 * Attaches a fix commit to a finding. Determines the verification path a
 * runtime-confirmed finding requires Strix replay in addition to source
 * revalidation; a source-only finding requires only source revalidation.
 * An agent's claim that the fix is complete is never taken at face value —
 * this only records the commit and queues the finding for verification.
 */
export async function submitFix(prisma: PrismaClient, params: SubmitFixParams): Promise<SubmitFixOutcome> {
  return prisma.$transaction(async (tx) => {
    const finding = await tx.finding.findUnique({ where: { id: params.findingId } });
    if (!finding) {
      throw new NotFoundError(`Finding ${params.findingId} not found`);
    }

    if (HOP_TO_FIX_PENDING_FROM.includes(finding.status)) {
      await transitionFindingStatus(tx, {
        findingId: finding.id,
        to: "fix_pending",
        actor: params.actor,
        eventType: "finding.fix_pending",
        metadata: { reason: "Fix commit submission requested" },
      });
    }

    await transitionFindingStatus(tx, {
      findingId: finding.id,
      to: "fix_submitted",
      actor: params.actor,
      eventType: "finding.fix_submitted",
      metadata: { fixCommitSha: params.fixCommitSha },
    });

    const wasEverRuntimeConfirmed = await tx.validation.findFirst({
      where: { findingId: finding.id, status: "confirmed" },
    });
    const requiresRuntimeRetest = Boolean(wasEverRuntimeConfirmed);

    const remediation = await tx.remediation.upsert({
      where: { findingId: finding.id },
      create: {
        findingId: finding.id,
        fixCommitSha: params.fixCommitSha,
        sourceRevalidationStatus: "pending",
        runtimeRetestStatus: requiresRuntimeRetest ? "pending" : "not_applicable",
        regressionTestStatus: "not_applicable",
        finalStatus: "pending",
      },
      update: {
        fixCommitSha: params.fixCommitSha,
        sourceRevalidationStatus: "pending",
        runtimeRetestStatus: requiresRuntimeRetest ? "pending" : "not_applicable",
        finalStatus: "pending",
      },
    });

    return { remediationId: remediation.id, findingStatus: "fix_submitted", requiresRuntimeRetest };
  });
}
