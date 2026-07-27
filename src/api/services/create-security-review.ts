import type { PrismaClient, SecurityRunStatus } from "@prisma/client";
import type { AuthenticatedAgent } from "../../auth/authenticate-agent.js";
import { assertOperationAllowed } from "../../auth/permissions.js";
import { authorizeRepositoryForRun } from "../../authz/repository-authorization.js";
import { authorizeTargetEnvironment } from "../../authz/target-authorization.js";
import { BudgetExceededError } from "../../domain/errors.js";
import type { JobQueue } from "../../orchestration/job-queue.js";
import { computeRunIdempotencyKey } from "../../orchestration/run-idempotency-key.js";

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const TERMINAL_RUN_STATUSES: readonly SecurityRunStatus[] = ["completed", "blocked", "failed", "cancelled"];

export interface CreateSecurityReviewParams {
  agent: AuthenticatedAgent;
  repositoryId: string;
  baseSha: string;
  headSha: string;
  pullRequestNumber?: number;
  targetEnvironmentId?: string;
  runType?: "change_review" | "repository_scan";
}

export interface CreateSecurityReviewResult {
  runId: string;
  status: SecurityRunStatus;
  deduplicated: boolean;
}

/**
 * Create Security Review (POST /v1/security/reviews). Full repository
 * scans must be requested explicitly via runType — change_review is the
 * default per the spec's change-scoped-by-default rule.
 */
export async function createSecurityReview(
  prisma: PrismaClient,
  jobQueue: JobQueue,
  params: CreateSecurityReviewParams,
): Promise<CreateSecurityReviewResult> {
  if (!SHA_PATTERN.test(params.baseSha) || !SHA_PATTERN.test(params.headSha)) {
    throw new Error("baseSha and headSha must be resolved commit SHAs, not branch names");
  }

  const runType = params.runType ?? "change_review";
  assertOperationAllowed(params.agent.permissions, runType);

  const repository = await authorizeRepositoryForRun(prisma, {
    organizationId: params.agent.organizationId,
    repositoryId: params.repositoryId,
    permissions: params.agent.permissions,
  });

  if (params.targetEnvironmentId) {
    await authorizeTargetEnvironment(prisma, {
      organizationId: params.agent.organizationId,
      repositoryId: params.repositoryId,
      targetEnvironmentId: params.targetEnvironmentId,
      permissions: params.agent.permissions,
    });
  }

  const activeRunCount = await prisma.securityRun.count({
    where: { requestedByAgentId: params.agent.agentIdentityId, status: { notIn: [...TERMINAL_RUN_STATUSES] } },
  });
  if (activeRunCount >= params.agent.permissions.maxConcurrentRuns) {
    throw new BudgetExceededError(
      `Agent has reached its maximum concurrent run limit (${params.agent.permissions.maxConcurrentRuns})`,
    );
  }

  const policyConfig = await prisma.repositoryPolicyConfig.findUnique({ where: { repositoryId: repository.id } });
  const policyVersion = policyConfig?.policyVersion ?? "2026-01-01";

  const idempotencyKey = computeRunIdempotencyKey({
    organizationId: params.agent.organizationId,
    repositoryId: repository.id,
    baseSha: params.baseSha,
    headSha: params.headSha,
    runType,
    policyVersion,
  });

  const existing = await prisma.securityRun.findUnique({ where: { idempotencyKey } });
  if (existing) {
    return { runId: existing.id, status: existing.status, deduplicated: true };
  }

  const run = await prisma.securityRun.create({
    data: {
      organizationId: params.agent.organizationId,
      repositoryId: repository.id,
      requestedByAgentId: params.agent.agentIdentityId,
      runType,
      baseSha: params.baseSha,
      headSha: params.headSha,
      pullRequestNumber: params.pullRequestNumber,
      targetEnvironmentId: params.targetEnvironmentId,
      policyVersion,
      idempotencyKey,
    },
  });

  await jobQueue.enqueue({
    jobType: "prepare_repository",
    organizationId: run.organizationId,
    idempotencyKey: `${run.idempotencyKey}:prepare`,
    payload: { runId: run.id },
  });

  return { runId: run.id, status: run.status, deduplicated: false };
}
