import type { Prisma, SecurityRunStatus } from "@prisma/client";
import { runStateMachine } from "./run-state-machine.js";
import { recordAuditEvent, type AuditActor } from "../audit/audit-log.js";

const TERMINAL_STATUSES: readonly SecurityRunStatus[] = ["completed", "blocked", "failed", "cancelled"];

export interface TransitionRunStatusParams {
  runId: string;
  to: SecurityRunStatus;
  actor: AuditActor;
  eventType: string;
  metadata?: Record<string, unknown>;
  failureReason?: string;
}

/**
 * The only sanctioned way to change SecurityRun.status. Validates the
 * transition against the state machine, persists it, and records an
 * immutable audit event in the same transaction.
 */
export async function transitionRunStatus(
  tx: Prisma.TransactionClient,
  params: TransitionRunStatusParams,
): Promise<void> {
  const run = await tx.securityRun.findUniqueOrThrow({ where: { id: params.runId } });
  runStateMachine.assertTransition(run.status, params.to);

  const now = new Date();
  await tx.securityRun.update({
    where: { id: run.id },
    data: {
      status: params.to,
      startedAt: run.startedAt ?? (params.to === "classifying" ? now : null) ?? run.startedAt,
      completedAt: TERMINAL_STATUSES.includes(params.to) ? now : run.completedAt,
      failureReason: params.failureReason ?? run.failureReason,
    },
  });

  await recordAuditEvent(tx, {
    organizationId: run.organizationId,
    runId: run.id,
    actor: params.actor,
    eventType: params.eventType,
    previousState: run.status,
    newState: params.to,
    metadata: params.metadata,
  });
}
