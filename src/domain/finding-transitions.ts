import type { FindingStatus, Prisma } from "@prisma/client";
import { findingStateMachine } from "./finding-state-machine.js";
import { recordAuditEvent, type AuditActor } from "../audit/audit-log.js";

export interface TransitionFindingStatusParams {
  findingId: string;
  to: FindingStatus;
  actor: AuditActor;
  eventType: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

/** The only sanctioned way to change Finding.status. */
export async function transitionFindingStatus(
  tx: Prisma.TransactionClient,
  params: TransitionFindingStatusParams,
): Promise<void> {
  const finding = await tx.finding.findUniqueOrThrow({ where: { id: params.findingId } });
  findingStateMachine.assertTransition(finding.status, params.to);

  await tx.finding.update({
    where: { id: finding.id },
    data: { status: params.to },
  });

  await recordAuditEvent(tx, {
    organizationId: finding.organizationId,
    runId: params.runId ?? null,
    findingId: finding.id,
    actor: params.actor,
    eventType: params.eventType,
    previousState: finding.status,
    newState: params.to,
    metadata: params.metadata,
  });
}
