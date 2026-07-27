import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { InMemoryJobQueue } from "../../src/orchestration/in-memory-job-queue.js";
import { enqueueWebhookDelivery } from "../../src/webhooks/enqueue-delivery.js";
import { createDeliverWebhookHandler } from "../../src/webhooks/deliver-webhook-handler.js";
import { replayWebhookDelivery, rotateWebhookSecret } from "../../src/webhooks/manage-deliveries.js";
import { verifyWebhookSignature } from "../../src/webhooks/sign-payload.js";

describe("outbound webhook delivery", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  async function createEndpoint(organizationId: string, eventTypes: string[] = ["security.run.completed"]) {
    return testPrisma.webhookEndpoint.create({
      data: { organizationId, url: "https://example.com/hooks/shld", secret: "endpoint-secret", eventTypes },
    });
  }

  it("creates a delivery row and enqueues a job for each subscribed endpoint", async () => {
    const fx = await createFixtures();
    await createEndpoint(fx.organizationId);
    await createEndpoint(fx.organizationId, ["security.finding.confirmed"]); // not subscribed to this event

    const queue = new InMemoryJobQueue();
    let jobCalls = 0;
    queue.registerHandler("deliver_webhook", async () => {
      jobCalls += 1;
    });

    const deliveryIds = await enqueueWebhookDelivery(testPrisma, queue, {
      organizationId: fx.organizationId,
      eventType: "security.run.completed",
      payload: { run_id: "run_1", status: "completed" },
      idempotencyKey: "run_1:completed",
    });
    expect(deliveryIds).toHaveLength(1);

    await queue.start();
    expect(jobCalls).toBe(1);
  });

  it("does not enqueue anything when no endpoint is subscribed to the event", async () => {
    const fx = await createFixtures();
    await createEndpoint(fx.organizationId, ["security.finding.confirmed"]);

    const deliveryIds = await enqueueWebhookDelivery(testPrisma, new InMemoryJobQueue(), {
      organizationId: fx.organizationId,
      eventType: "security.run.completed",
      payload: { run_id: "run_1" },
      idempotencyKey: "run_1:completed",
    });
    expect(deliveryIds).toHaveLength(0);
  });

  it("is idempotent: re-enqueueing the same occurrence reuses the delivery row", async () => {
    const fx = await createFixtures();
    await createEndpoint(fx.organizationId);
    const queue = new InMemoryJobQueue();
    queue.registerHandler("deliver_webhook", async () => {});

    const first = await enqueueWebhookDelivery(testPrisma, queue, {
      organizationId: fx.organizationId,
      eventType: "security.run.completed",
      payload: { run_id: "run_1" },
      idempotencyKey: "run_1:completed",
    });
    const second = await enqueueWebhookDelivery(testPrisma, queue, {
      organizationId: fx.organizationId,
      eventType: "security.run.completed",
      payload: { run_id: "run_1" },
      idempotencyKey: "run_1:completed",
    });
    expect(first).toEqual(second);

    const deliveries = await testPrisma.webhookDelivery.findMany({});
    expect(deliveries).toHaveLength(1);
  });

  it("signs the outbound payload and marks the delivery delivered on success", async () => {
    const fx = await createFixtures();
    const endpoint = await createEndpoint(fx.organizationId);
    const delivery = await testPrisma.webhookDelivery.create({
      data: {
        webhookEndpointId: endpoint.id,
        eventType: "security.run.completed",
        idempotencyKey: "run_1:completed",
        payload: { run_id: "run_1", status: "completed" },
        status: "pending",
      },
    });

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const signature = (init.headers as Record<string, string>)["x-shld-signature-256"] ?? "";
      expect(verifyWebhookSignature(init.body as string, signature, "endpoint-secret")).toBe(true);
      expect(url).toBe(endpoint.url);
      return new Response("ok", { status: 200 });
    });

    const handler = createDeliverWebhookHandler({ prisma: testPrisma, fetchImpl: fetchImpl as unknown as typeof fetch });
    await handler({ webhookDeliveryId: delivery.id }, { jobId: "job_1", attempt: 1, signal: new AbortController().signal });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const updated = await testPrisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("delivered");
    expect(updated.responseCode).toBe(200);
    expect(updated.attempts).toBe(1);
  });

  it("throws on a non-2xx response so the queue retries, and marks exhausted on the final attempt", async () => {
    const fx = await createFixtures();
    const endpoint = await createEndpoint(fx.organizationId);
    const delivery = await testPrisma.webhookDelivery.create({
      data: {
        webhookEndpointId: endpoint.id,
        eventType: "security.run.completed",
        idempotencyKey: "run_1:completed",
        payload: { run_id: "run_1" },
        status: "pending",
      },
    });

    const fetchImpl = vi.fn(async () => new Response("server error", { status: 500 }));
    const handler = createDeliverWebhookHandler({ prisma: testPrisma, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      handler({ webhookDeliveryId: delivery.id }, { jobId: "job_1", attempt: 3, signal: new AbortController().signal }),
    ).rejects.toThrow();

    const updated = await testPrisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("exhausted");
    expect(updated.responseCode).toBe(500);
  });

  it("skips re-delivering a delivery that already succeeded", async () => {
    const fx = await createFixtures();
    const endpoint = await createEndpoint(fx.organizationId);
    const delivery = await testPrisma.webhookDelivery.create({
      data: {
        webhookEndpointId: endpoint.id,
        eventType: "security.run.completed",
        idempotencyKey: "run_1:completed",
        payload: { run_id: "run_1" },
        status: "delivered",
        attempts: 1,
      },
    });

    const fetchImpl = vi.fn();
    const handler = createDeliverWebhookHandler({ prisma: testPrisma, fetchImpl: fetchImpl as unknown as typeof fetch });
    await handler({ webhookDeliveryId: delivery.id }, { jobId: "job_1", attempt: 1, signal: new AbortController().signal });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("replayWebhookDelivery resets an exhausted delivery and re-enqueues it", async () => {
    const fx = await createFixtures();
    const endpoint = await createEndpoint(fx.organizationId);
    const delivery = await testPrisma.webhookDelivery.create({
      data: {
        webhookEndpointId: endpoint.id,
        eventType: "security.run.completed",
        idempotencyKey: "run_1:completed",
        payload: { run_id: "run_1" },
        status: "exhausted",
        attempts: 3,
      },
    });

    const queue = new InMemoryJobQueue();
    let replayed = false;
    queue.registerHandler("deliver_webhook", async () => {
      replayed = true;
    });

    await replayWebhookDelivery(testPrisma, queue, delivery.id);
    await queue.start();

    expect(replayed).toBe(true);
    const updated = await testPrisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("pending");
  });

  it("rotateWebhookSecret changes the endpoint's signing secret", async () => {
    const fx = await createFixtures();
    const endpoint = await createEndpoint(fx.organizationId);
    await rotateWebhookSecret(testPrisma, endpoint.id, "new-secret");
    const updated = await testPrisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(updated.secret).toBe("new-secret");
  });
});
