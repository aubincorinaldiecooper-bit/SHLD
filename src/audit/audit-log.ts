import type { ActorType, Prisma } from "@prisma/client";

export interface AuditActor {
  type: ActorType;
  id?: string | null;
}

export interface RecordAuditEventParams {
  organizationId: string;
  runId?: string | null;
  findingId?: string | null;
  actor: AuditActor;
  eventType: string;
  previousState?: string | null;
  newState?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Every important state change must create an immutable audit event. This is
 * the single writer for AuditEvent rows — callers never insert directly so
 * the shape stays consistent and every event carries an actor.
 */
export async function recordAuditEvent(
  tx: Prisma.TransactionClient,
  params: RecordAuditEventParams,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      organizationId: params.organizationId,
      runId: params.runId ?? null,
      findingId: params.findingId ?? null,
      actorType: params.actor.type,
      actorId: params.actor.id ?? null,
      eventType: params.eventType,
      previousState: params.previousState ?? null,
      newState: params.newState ?? null,
      metadata: (params.metadata as Prisma.InputJsonValue) ?? undefined,
    },
  });
}
