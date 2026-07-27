import type { PrismaClient } from "@prisma/client";
import type { JobQueue } from "../orchestration/job-queue.js";
import { NotFoundError } from "../domain/errors.js";

/** Manual replay: resets a delivery to pending and re-enqueues it, regardless of its current status. */
export async function replayWebhookDelivery(
  prisma: PrismaClient,
  jobQueue: JobQueue,
  webhookDeliveryId: string,
): Promise<void> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: webhookDeliveryId },
    include: { webhookEndpoint: true },
  });
  if (!delivery) {
    throw new NotFoundError(`Webhook delivery ${webhookDeliveryId} not found`);
  }

  await prisma.webhookDelivery.update({ where: { id: webhookDeliveryId }, data: { status: "pending" } });

  await jobQueue.enqueue({
    jobType: "deliver_webhook",
    organizationId: delivery.webhookEndpoint.organizationId,
    idempotencyKey: `deliver:${delivery.id}:replay:${Date.now()}`,
    payload: { webhookDeliveryId: delivery.id },
  });
}

/** Secret rotation: future deliveries sign with the new secret immediately; nothing needs backfilling. */
export async function rotateWebhookSecret(
  prisma: PrismaClient,
  webhookEndpointId: string,
  newSecret: string,
): Promise<void> {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: webhookEndpointId } });
  if (!endpoint) {
    throw new NotFoundError(`Webhook endpoint ${webhookEndpointId} not found`);
  }
  await prisma.webhookEndpoint.update({ where: { id: webhookEndpointId }, data: { secret: newSecret } });
}
