import type { JobQueue } from "../job-queue.js";
import type { HandlerDeps } from "./deps.js";
import { createClassifyChangeHandler, createPrepareRepositoryHandler } from "./prepare-and-classify.js";
import { createRunDeepSecHandler, createRunDeepSecRevalidationHandler } from "./run-deepsec.js";
import { createRunStrixRetestHandler, createRunStrixValidationHandler } from "./run-strix.js";
import { createApplyRoutingPolicyHandler, createGenerateReceiptHandler } from "./routing-and-receipt.js";

/**
 * Wires every job handler this platform actually enqueues onto a JobQueue.
 * normalize_deepsec_output, normalize_strix_output, and correlate_findings
 * are deliberately not separate registered handlers: normalization is a
 * synchronous, deterministic parse performed inline by the adapters
 * (DeepSecAdapter.run / StrixAdapter.run already return normalized data),
 * and correlation is performed inline by correlateStrixValidation — none
 * of the three is ever independently slow, retryable, or cancellable in a
 * way that would justify its own queue hop. wait_for_target and
 * deliver_webhook are registered by the deployment-webhook and outbound-
 * webhook integrations respectively, not here.
 */
export function registerJobHandlers(jobQueue: JobQueue, deps: HandlerDeps): void {
  jobQueue.registerHandler("prepare_repository", createPrepareRepositoryHandler(deps));
  jobQueue.registerHandler("classify_change", createClassifyChangeHandler(deps));
  jobQueue.registerHandler("run_deepsec_diff", createRunDeepSecHandler(deps));
  jobQueue.registerHandler("run_deepsec_full", createRunDeepSecHandler(deps));
  jobQueue.registerHandler("run_deepsec_revalidation", createRunDeepSecRevalidationHandler(deps));
  jobQueue.registerHandler("apply_routing_policy", createApplyRoutingPolicyHandler(deps));
  jobQueue.registerHandler("run_strix_validation", createRunStrixValidationHandler(deps));
  jobQueue.registerHandler("run_strix_retest", createRunStrixRetestHandler(deps));
  jobQueue.registerHandler("generate_receipt", createGenerateReceiptHandler(deps));
}
