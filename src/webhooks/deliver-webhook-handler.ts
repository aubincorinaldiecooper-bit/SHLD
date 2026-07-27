import type { PrismaClient } from "@prisma/client";
import type { JobHandler } from "../orchestration/job-queue.js";
import { signWebhookPayload } from "./sign-payload.js";

export interface DeliverWebhookPayload {
  webhookDeliveryId: string;
}

export interface DeliverWebhookHandlerDeps {
  prisma: PrismaClient;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Sends one webhook delivery: signs the payload, POSTs it, and records the
 * outcome on the durable WebhookDelivery row regardless of success or
 * failure. Retries are the job queue's job (maxAttempts/backoff); this
 * handler just needs to throw on failure so the queue knows to retry, and
 * to mark the delivery `exhausted` once it's on its last attempt.
 */
export function createDeliverWebhookHandler(deps: DeliverWebhookHandlerDeps): JobHandler<DeliverWebhookPayload> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return async (payload, ctx) => {
    const delivery = await deps.prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: payload.webhookDeliveryId },
      include: { webhookEndpoint: true },
    });

    if (delivery.status === "delivered") return; // already succeeded on a prior attempt/replay

    const body = JSON.stringify(delivery.payload);
    const signature = signWebhookPayload(body, delivery.webhookEndpoint.secret);

    let responseCode: number | undefined;
    let succeeded = false;
    try {
      const response = await fetchImpl(delivery.webhookEndpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shld-signature-256": signature,
          "x-shld-event": delivery.eventType,
          "x-shld-delivery": delivery.id,
        },
        body,
      });
      responseCode = response.status;
      succeeded = response.ok;
    } catch {
      responseCode = undefined;
    }

    await deps.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
        responseCode,
        status: succeeded ? "delivered" : ctx.attempt >= 3 ? "exhausted" : "pending",
      },
    });

    if (!succeeded) {
      throw new Error(`Webhook delivery ${delivery.id} failed${responseCode ? ` with status ${responseCode}` : ""}`);
    }
  };
}
