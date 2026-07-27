import { describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "../../src/orchestration/in-memory-job-queue.js";

describe("InMemoryJobQueue", () => {
  it("deduplicates enqueue calls sharing an idempotency key", async () => {
    const queue = new InMemoryJobQueue();
    queue.registerHandler("classify_change", async () => {});
    const first = await queue.enqueue({
      jobType: "classify_change",
      organizationId: "org_1",
      idempotencyKey: "key-1",
      payload: {},
    });
    const second = await queue.enqueue({
      jobType: "classify_change",
      organizationId: "org_1",
      idempotencyKey: "key-1",
      payload: {},
    });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(first.jobId).toBe(second.jobId);
  });

  it("runs the registered handler for a job type", async () => {
    const queue = new InMemoryJobQueue();
    const seen: unknown[] = [];
    queue.registerHandler<{ n: number }>("classify_change", async (payload) => {
      seen.push(payload);
    });
    await queue.enqueue({
      jobType: "classify_change",
      organizationId: "org_1",
      idempotencyKey: "k",
      payload: { n: 42 },
    });
    await queue.start();
    expect(seen).toEqual([{ n: 42 }]);
  });

  it("retries a failing handler up to maxAttempts, then completes on success", async () => {
    const queue = new InMemoryJobQueue();
    let attempts = 0;
    queue.registerHandler("prepare_repository", async (_payload, ctx) => {
      attempts = ctx.attempt;
      if (ctx.attempt < 3) throw new Error("transient");
    });
    await queue.enqueue({
      jobType: "prepare_repository",
      organizationId: "org_1",
      idempotencyKey: "k",
      payload: {},
      maxAttempts: 5,
    });
    await queue.start();
    expect(attempts).toBe(3);
  });

  it("moves an always-failing job to the dead letter after maxAttempts", async () => {
    const queue = new InMemoryJobQueue();
    queue.registerHandler("run_deepsec_diff", async () => {
      throw new Error("boom");
    });
    await queue.enqueue({
      jobType: "run_deepsec_diff",
      organizationId: "org_1",
      idempotencyKey: "k",
      payload: {},
      maxAttempts: 2,
    });
    await queue.start();
    const dead = await queue.getDeadLetterJobs("run_deepsec_diff");
    expect(dead).toHaveLength(1);
    expect(dead[0]?.attemptsMade).toBe(2);
    expect(dead[0]?.failedReason).toBe("boom");
  });

  it("replayDeadLetterJob re-runs a failed job", async () => {
    const queue = new InMemoryJobQueue();
    let shouldFail = true;
    queue.registerHandler("run_deepsec_diff", async () => {
      if (shouldFail) throw new Error("boom");
    });
    await queue.enqueue({
      jobType: "run_deepsec_diff",
      organizationId: "org_1",
      idempotencyKey: "k",
      payload: {},
      maxAttempts: 1,
    });
    await queue.start();
    expect(await queue.getDeadLetterJobs()).toHaveLength(1);

    shouldFail = false;
    const [dead] = await queue.getDeadLetterJobs();
    await queue.replayDeadLetterJob(dead!.jobId);
    expect(await queue.getDeadLetterJobs()).toHaveLength(0);
  });

  it("cancel removes a waiting job before it runs", async () => {
    const queue = new InMemoryJobQueue();
    const seen: unknown[] = [];
    queue.registerHandler("deliver_webhook", async (payload) => {
      seen.push(payload);
    });
    const { jobId } = await queue.enqueue({
      jobType: "deliver_webhook",
      organizationId: "org_1",
      idempotencyKey: "k",
      payload: { should: "not-run" },
    });
    const cancelled = await queue.cancel(jobId);
    await queue.start();
    expect(cancelled).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("start() waits for a handler-chained enqueue to fully finish, even across real async gaps", async () => {
    const queue = new InMemoryJobQueue();
    const order: string[] = [];

    queue.registerHandler("prepare_repository", async () => {
      order.push("prepare_repository:start");
      await new Promise((resolve) => setTimeout(resolve, 20)); // force a real async yield
      order.push("prepare_repository:end");
      await queue.enqueue({
        jobType: "classify_change",
        organizationId: "org_1",
        idempotencyKey: "chain",
        payload: {},
      });
    });
    queue.registerHandler("classify_change", async () => {
      order.push("classify_change:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("classify_change:end");
    });

    await queue.enqueue({
      jobType: "prepare_repository",
      organizationId: "org_1",
      idempotencyKey: "chain",
      payload: {},
    });
    await queue.start();

    // If start() resolved before the chained job finished, "classify_change:end"
    // would be missing here even though the test's own await already returned.
    expect(order).toEqual([
      "prepare_repository:start",
      "prepare_repository:end",
      "classify_change:start",
      "classify_change:end",
    ]);
  });

  it("processes lower-priority-number jobs first", async () => {
    const queue = new InMemoryJobQueue();
    const order: string[] = [];
    queue.registerHandler<{ label: string }>("generate_receipt", async (payload) => {
      order.push(payload.label);
    });
    await queue.enqueue({
      jobType: "generate_receipt",
      organizationId: "org_1",
      idempotencyKey: "low",
      payload: { label: "low-priority" },
      priority: 10,
    });
    await queue.enqueue({
      jobType: "generate_receipt",
      organizationId: "org_1",
      idempotencyKey: "high",
      payload: { label: "high-priority" },
      priority: 1,
    });
    await queue.start();
    expect(order).toEqual(["high-priority", "low-priority"]);
  });
});
