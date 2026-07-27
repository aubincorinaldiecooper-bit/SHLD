import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type {
  DeadLetterJob,
  EnqueueParams,
  EnqueueResult,
  JobHandler,
  JobQueue,
  JobType,
  StartOptions,
} from "./job-queue.js";
import { TenantConcurrencyLimiter } from "./tenant-concurrency.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TENANT_CONCURRENCY = 10;
const CANCEL_KEY_TTL_SECONDS = 3600;
const CANCEL_POLL_INTERVAL_MS = 2000;
const TENANT_RETRY_DELAY_MS = 1500;

export interface BullMqJobQueueOptions {
  redisUrl: string;
  queueName?: string;
  tenantConcurrencyLimit?: number;
}

interface JobData {
  payload: unknown;
  organizationId: string;
}

/**
 * A single shared BullMQ queue carries every job type; one Worker process
 * dispatches by `job.name` to the registered handler. This matches the
 * architecture's single Job Orchestrator, and keeps worker concurrency,
 * Redis connections and observability in one place instead of 14 queues.
 */
export class BullMqJobQueue implements JobQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<JobData>;
  private readonly queueName: string;
  private readonly limiter: TenantConcurrencyLimiter;
  private readonly handlers = new Map<JobType, JobHandler<unknown>>();
  private worker: Worker<JobData> | undefined;

  constructor(options: BullMqJobQueueOptions) {
    this.connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
    this.queueName = options.queueName ?? "shld-jobs";
    this.queue = new Queue<JobData>(this.queueName, { connection: this.connection });
    this.limiter = new TenantConcurrencyLimiter(
      this.connection,
      options.tenantConcurrencyLimit ?? DEFAULT_TENANT_CONCURRENCY,
    );
  }

  async enqueue<P>(params: EnqueueParams<P>): Promise<EnqueueResult> {
    const jobId = `${params.organizationId}:${params.jobType}:${params.idempotencyKey}`;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      return { jobId, deduplicated: true };
    }

    await this.queue.add(
      params.jobType,
      { payload: params.payload, organizationId: params.organizationId },
      {
        jobId,
        attempts: params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        backoff: { type: "exponential", delay: 2000 },
        priority: params.priority,
        delay: params.delayMs,
        removeOnComplete: { count: 1000 },
        removeOnFail: false, // failed jobs are the dead-letter record
      },
    );
    return { jobId, deduplicated: false };
  }

  registerHandler<P>(jobType: JobType, handler: JobHandler<P>): void {
    this.handlers.set(jobType, handler as JobHandler<unknown>);
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
      return true;
    }
    await this.connection.set(this.cancelKey(jobId), "1", "EX", CANCEL_KEY_TTL_SECONDS);
    return true;
  }

  async start(options?: StartOptions): Promise<void> {
    this.worker = new Worker<JobData>(
      this.queueName,
      async (job: Job<JobData>) => {
        const jobType = job.name as JobType;
        const handler = this.handlers.get(jobType);
        if (!handler) {
          throw new Error(`No handler registered for job type "${jobType}"`);
        }

        const acquired = await this.limiter.tryAcquire(job.data.organizationId, job.id!);
        if (!acquired) {
          throw new TenantConcurrencyBackpressureError(job.data.organizationId);
        }

        try {
          await this.runWithTimeoutAndCancellation(job, handler);
        } finally {
          await this.limiter.release(job.data.organizationId, job.id!);
        }
      },
      { connection: this.connection, concurrency: options?.concurrency ?? 5 },
    );

    // Backpressure from the tenant limiter should retry shortly without
    // burning the job's real attempt budget or landing in the dead letter.
    this.worker.on("failed", (job, error) => {
      if (job && error instanceof TenantConcurrencyBackpressureError) {
        void this.queue.add(job.name, job.data, {
          jobId: `${job.id}:retry:${Date.now()}`,
          delay: TENANT_RETRY_DELAY_MS,
          attempts: 1,
        });
      }
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }

  async getDeadLetterJobs(jobType?: JobType): Promise<DeadLetterJob[]> {
    const failed = await this.queue.getFailed();
    return failed
      .filter((job) => !jobType || job.name === jobType)
      .map((job) => ({
        jobId: job.id!,
        jobType: job.name as JobType,
        payload: job.data.payload,
        failedReason: job.failedReason ?? "unknown",
        attemptsMade: job.attemptsMade,
      }));
  }

  async replayDeadLetterJob(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (!job) return;
    await job.retry("failed");
  }

  private cancelKey(jobId: string): string {
    return `shld:cancel:${jobId}`;
  }

  private async runWithTimeoutAndCancellation(job: Job<JobData>, handler: JobHandler<unknown>): Promise<void> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(new Error("timeout")), DEFAULT_TIMEOUT_MS);
    const pollHandle = setInterval(() => {
      void this.connection.get(this.cancelKey(job.id!)).then((flag: string | null) => {
        if (flag) controller.abort(new Error("cancelled"));
      });
    }, CANCEL_POLL_INTERVAL_MS);

    try {
      await handler(job.data.payload, { jobId: job.id!, attempt: job.attemptsMade + 1, signal: controller.signal });
    } finally {
      clearTimeout(timeoutHandle);
      clearInterval(pollHandle);
      await this.connection.del(this.cancelKey(job.id!));
    }
  }
}

class TenantConcurrencyBackpressureError extends Error {
  constructor(organizationId: string) {
    super(`Tenant concurrency limit reached for organization ${organizationId}`);
  }
}
