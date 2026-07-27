import type { Prisma, PrismaClient } from "@prisma/client";
import type { JobQueue } from "../orchestration/job-queue.js";
import type { OutboundWebhookEventType } from "./outbound-events.js";

export interface EnqueueWebhookDeliveryParams {
  organizationId: string;
  eventType: OutboundWebhookEventType;
  payload: Record<string, unknown>;
  /** Deterministic per underlying occurrence (e.g. `${runId}:completed`) — never wall-clock-based. */
  idempotencyKey: string;
}

/**
 * Fans an event out to every active WebhookEndpoint subscribed to it,
 * creating one WebhookDelivery row (the durable delivery log) and
 * enqueueing one deliver_webhook job per endpoint. A repeat call with the
 * same idempotencyKey for the same endpoint reuses the existing delivery
 * row instead of sending twice.
 */
export async function enqueueWebhookDelivery(
  prisma: PrismaClient,
  jobQueue: JobQueue,
  params: EnqueueWebhookDeliveryParams,
): Promise<string[]> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { organizationId: params.organizationId, active: true, eventTypes: { has: params.eventType } },
  });

  const deliveryIds: string[] = [];
  for (const endpoint of endpoints) {
    const delivery = await prisma.webhookDelivery.upsert({
      where: {
        webhookEndpointId_idempotencyKey: { webhookEndpointId: endpoint.id, idempotencyKey: params.idempotencyKey },
      },
      create: {
        webhookEndpointId: endpoint.id,
        eventType: params.eventType,
        idempotencyKey: params.idempotencyKey,
        payload: params.payload as Prisma.InputJsonValue,
        status: "pending",
      },
      update: {},
    });

    await jobQueue.enqueue({
      jobType: "deliver_webhook",
      organizationId: params.organizationId,
      idempotencyKey: `deliver:${delivery.id}`,
      payload: { webhookDeliveryId: delivery.id },
    });
    deliveryIds.push(delivery.id);
  }

  return deliveryIds;
}
