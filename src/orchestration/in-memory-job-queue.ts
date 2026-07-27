import type {
  DeadLetterJob,
  EnqueueParams,
  EnqueueResult,
  JobHandler,
  JobQueue,
  JobType,
  StartOptions,
} from "./job-queue.js";

interface InternalJob {
  jobId: string;
  jobType: JobType;
  organizationId: string;
  payload: unknown;
  priority: number;
  maxAttempts: number;
  timeoutMs: number;
  attemptsMade: number;
  state: "waiting" | "delayed" | "active" | "completed" | "failed" | "cancelled";
  failedReason?: string;
  controller?: AbortController;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * A synchronous-ish, dependency-free JobQueue used in unit tests so business
 * logic that enqueues follow-up jobs can be exercised without Redis/BullMQ.
 * Implements the same idempotency, retry, priority, timeout and dead-letter
 * contract as the BullMQ-backed implementation.
 */
export class InMemoryJobQueue implements JobQueue {
  private jobs = new Map<string, InternalJob>();
  private handlers = new Map<JobType, JobHandler<unknown>>();
  private started = false;
  // Tracks the single in-flight drain loop, if any, so a handler that
  // enqueues a follow-up job (the self-chaining pattern every orchestration
  // handler uses) extends the SAME awaited loop instead of spawning an
  // orphaned, unawaited one — otherwise start() can resolve before chained
  // jobs actually finish.
  private drainPromise: Promise<void> | null = null;

  async enqueue<P>(params: EnqueueParams<P>): Promise<EnqueueResult> {
    const jobId = `${params.organizationId}:${params.jobType}:${params.idempotencyKey}`;
    const existing = this.jobs.get(jobId);
    if (existing && existing.state !== "cancelled") {
      return { jobId, deduplicated: true };
    }

    this.jobs.set(jobId, {
      jobId,
      jobType: params.jobType,
      organizationId: params.organizationId,
      payload: params.payload,
      priority: params.priority ?? 0,
      maxAttempts: params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      attemptsMade: 0,
      state: params.delayMs ? "delayed" : "waiting",
    });

    if (this.started) {
      void this.ensureDraining();
    }

    return { jobId, deduplicated: false };
  }

  /** Starts the drain loop if none is running, and returns the (possibly shared) in-flight promise. */
  private ensureDraining(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null;
      });
    }
    return this.drainPromise;
  }

  registerHandler<P>(jobType: JobType, handler: JobHandler<P>): void {
    this.handlers.set(jobType, handler as JobHandler<unknown>);
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.state === "waiting" || job.state === "delayed") {
      job.state = "cancelled";
      return true;
    }
    if (job.state === "active") {
      job.controller?.abort(new Error("cancelled"));
      return true;
    }
    return false;
  }

  async start(_options?: StartOptions): Promise<void> {
    this.started = true;
    await this.ensureDraining();
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async getDeadLetterJobs(jobType?: JobType): Promise<DeadLetterJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.state === "failed" && (!jobType || j.jobType === jobType))
      .map((j) => ({
        jobId: j.jobId,
        jobType: j.jobType,
        payload: j.payload,
        failedReason: j.failedReason ?? "unknown",
        attemptsMade: j.attemptsMade,
      }));
  }

  async replayDeadLetterJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "failed") return;
    job.state = "waiting";
    job.attemptsMade = 0;
    if (this.started) {
      await this.ensureDraining();
    }
  }

  /** Processes every waiting job to completion/failure. Sequential — fine for tests. */
  private async drain(): Promise<void> {
    const pending = () =>
      [...this.jobs.values()]
        .filter((j) => j.state === "waiting")
        .sort((a, b) => a.priority - b.priority);

    let next = pending()[0];
    while (next) {
      await this.runJob(next);
      next = pending()[0];
    }
  }

  private async runJob(job: InternalJob): Promise<void> {
    const handler = this.handlers.get(job.jobType);
    if (!handler) {
      throw new Error(`No handler registered for job type "${job.jobType}"`);
    }

    job.state = "active";
    job.attemptsMade += 1;
    const controller = new AbortController();
    job.controller = controller;
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), job.timeoutMs);

    try {
      await handler(job.payload, { jobId: job.jobId, attempt: job.attemptsMade, signal: controller.signal });
      job.state = "completed";
    } catch (error) {
      if (controller.signal.aborted && (controller.signal.reason as Error)?.message === "cancelled") {
        job.state = "cancelled";
      } else if (job.attemptsMade >= job.maxAttempts) {
        job.state = "failed";
        job.failedReason = error instanceof Error ? error.message : String(error);
      } else {
        job.state = "waiting";
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
