export type JobType =
  | "classify_change"
  | "prepare_repository"
  | "run_deepsec_diff"
  | "run_deepsec_full"
  | "normalize_deepsec_output"
  | "apply_routing_policy"
  | "wait_for_target"
  | "run_strix_validation"
  | "normalize_strix_output"
  | "correlate_findings"
  | "run_deepsec_revalidation"
  | "run_strix_retest"
  | "generate_receipt"
  | "deliver_webhook";

export interface JobContext {
  jobId: string;
  attempt: number;
  /** Aborted on hard timeout or explicit cancellation. Handlers doing
   *  subprocess work (engine adapters) must listen for this and kill the
   *  child process — the queue layer cannot forcibly stop a running
   *  handler on its own. */
  signal: AbortSignal;
}

export type JobHandler<P = unknown> = (payload: P, ctx: JobContext) => Promise<void>;

export interface EnqueueParams<P = unknown> {
  jobType: JobType;
  organizationId: string;
  /** Deterministic per the spec's idempotency-key rules for the caller's operation. */
  idempotencyKey: string;
  payload: P;
  /** Lower number = processed first (BullMQ convention). Omit for default priority. */
  priority?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  delayMs?: number;
}

export interface EnqueueResult {
  jobId: string;
  /** True if a job with this idempotency key already existed and was reused. */
  deduplicated: boolean;
}

export interface DeadLetterJob {
  jobId: string;
  jobType: JobType;
  payload: unknown;
  failedReason: string;
  attemptsMade: number;
}

export interface StartOptions {
  /** Total concurrent job executions for this worker process, across all job types. */
  concurrency?: number;
}

export interface JobQueue {
  enqueue<P>(params: EnqueueParams<P>): Promise<EnqueueResult>;
  registerHandler<P>(jobType: JobType, handler: JobHandler<P>): void;
  /** Removes a waiting/delayed job outright, or requests cooperative cancellation of an active one. */
  cancel(jobId: string): Promise<boolean>;
  start(options?: StartOptions): Promise<void>;
  stop(): Promise<void>;
  getDeadLetterJobs(jobType?: JobType): Promise<DeadLetterJob[]>;
  replayDeadLetterJob(jobId: string): Promise<void>;
}
