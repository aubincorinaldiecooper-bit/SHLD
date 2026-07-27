import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BullMqJobQueue } from "../../src/orchestration/bullmq-job-queue.js";
import { waitFor } from "../helpers/wait-for.js";

const redisUrl = process.env.REDIS_URL!;

describe("BullMqJobQueue", () => {
  let queue: BullMqJobQueue | undefined;

  afterEach(async () => {
    await queue?.stop();
    queue = undefined;
  });

  it("runs a job through its registered handler", async () => {
    const queueName = `test-${randomUUID()}`;
    queue = new BullMqJobQueue({ redisUrl, queueName });
    const seen: unknown[] = [];
    queue.registerHandler<{ n: number }>("classify_change", async (payload) => {
      seen.push(payload);
    });
    await queue.start();

    await queue.enqueue({
      jobType: "classify_change",
      organizationId: "org_1",
      idempotencyKey: "k1",
      payload: { n: 7 },
    });

    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([{ n: 7 }]);
  });

  it("deduplicates enqueue calls with the same idempotency key", async () => {
    const queueName = `test-${randomUUID()}`;
    queue = new BullMqJobQueue({ redisUrl, queueName });
    let callCount = 0;
    queue.registerHandler("classify_change", async () => {
      callCount += 1;
    });
    await queue.start();

    const first = await queue.enqueue({
      jobType: "classify_change",
      organizationId: "org_1",
      idempotencyKey: "same-key",
      payload: {},
    });
    const second = await queue.enqueue({
      jobType: "classify_change",
      organizationId: "org_1",
      idempotencyKey: "same-key",
      payload: {},
    });

    expect(first.jobId).toBe(second.jobId);
    expect(second.deduplicated).toBe(true);

    await waitFor(() => callCount === 1);
    // Give BullMQ a moment to confirm no second execution ever arrives.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(callCount).toBe(1);
  });

  it("retries a failing handler and eventually succeeds", async () => {
    const queueName = `test-${randomUUID()}`;
    queue = new BullMqJobQueue({ redisUrl, queueName });
    let attempts = 0;
    queue.registerHandler("prepare_repository", async (_payload, ctx) => {
      attempts = ctx.attempt;
      if (ctx.attempt < 2) throw new Error("transient failure");
    });
    await queue.start();

    await queue.enqueue({
      jobType: "prepare_repository",
      organizationId: "org_1",
      idempotencyKey: "k2",
      payload: {},
      maxAttempts: 5,
    });

    await waitFor(() => attempts >= 2, 15000);
    expect(attempts).toBe(2);
  });

  it("moves an always-failing job to the dead letter queue and supports replay", async () => {
    const queueName = `test-${randomUUID()}`;
    queue = new BullMqJobQueue({ redisUrl, queueName });
    let shouldFail = true;
    let calls = 0;
    queue.registerHandler("run_deepsec_diff", async () => {
      calls += 1;
      if (shouldFail) throw new Error("permanent failure");
    });
    await queue.start();

    await queue.enqueue({
      jobType: "run_deepsec_diff",
      organizationId: "org_1",
      idempotencyKey: "k3",
      payload: {},
      maxAttempts: 1,
    });

    await waitFor(async () => (await queue!.getDeadLetterJobs("run_deepsec_diff")).length === 1, 15000);
    const dead = await queue.getDeadLetterJobs("run_deepsec_diff");
    expect(dead[0]?.failedReason).toContain("permanent failure");

    shouldFail = false;
    await queue.replayDeadLetterJob(dead[0]!.jobId);
    await waitFor(() => calls === 2, 15000);
    await waitFor(async () => (await queue!.getDeadLetterJobs("run_deepsec_diff")).length === 0, 15000);
  });

  it("cancel removes a job that has not started yet", async () => {
    const queueName = `test-${randomUUID()}`;
    queue = new BullMqJobQueue({ redisUrl, queueName });
    const seen: unknown[] = [];
    queue.registerHandler("deliver_webhook", async (payload) => {
      seen.push(payload);
    });

    const { jobId } = await queue.enqueue({
      jobType: "deliver_webhook",
      organizationId: "org_1",
      idempotencyKey: "k4",
      payload: { should: "not-run" },
      delayMs: 5000,
    });

    const cancelled = await queue.cancel(jobId);
    expect(cancelled).toBe(true);

    await queue.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(seen).toHaveLength(0);
  });
});
