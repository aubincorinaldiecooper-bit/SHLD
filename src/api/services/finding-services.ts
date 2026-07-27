import type { Finding, PrismaClient } from "@prisma/client";
import type { AuthenticatedAgent } from "../../auth/authenticate-agent.js";
import { assertOperationAllowed } from "../../auth/permissions.js";
import { assertSameOrganization, type TenantPrincipal } from "../../auth/tenant-isolation.js";
import { authorizeTargetEnvironment } from "../../authz/target-authorization.js";
import { NotFoundError } from "../../domain/errors.js";
import type { JobQueue } from "../../orchestration/job-queue.js";
import { transitionFindingStatus } from "../../domain/finding-transitions.js";
import { submitFix } from "../../remediation/submit-fix.js";
import { startFixVerification } from "../../remediation/start-fix-verification.js";
import { computeRunIdempotencyKey } from "../../orchestration/run-idempotency-key.js";

async function loadOwnedFinding(prisma: PrismaClient, agent: AuthenticatedAgent, findingId: string): Promise<Finding> {
  const finding = await prisma.finding.findUnique({ where: { id: findingId } });
  if (!finding) throw new NotFoundError(`Finding ${findingId} not found`);
  assertSameOrganization(agent.organizationId, finding.organizationId, "finding");
  return finding;
}

/** List Run Findings (GET /v1/security/runs/{run_id}/findings). */
export async function listRunFindings(prisma: PrismaClient, principal: TenantPrincipal, runId: string) {
  const run = await prisma.securityRun.findUnique({ where: { id: runId } });
  if (!run) throw new NotFoundError(`Security run ${runId} not found`);
  assertSameOrganization(principal.organizationId, run.organizationId, "security run");

  const auditEvents = await prisma.auditEvent.findMany({ where: { runId }, select: { findingId: true } });
  const findingIds = [...new Set(auditEvents.map((e) => e.findingId).filter((id): id is string => Boolean(id)))];
  if (findingIds.length === 0) return [];
  return prisma.finding.findMany({
    where: { id: { in: findingIds } },
    include: { sourceLocations: true, validations: true, remediation: true },
  });
}

/** Get Finding (GET /v1/security/findings/{finding_id}). */
export async function getFinding(prisma: PrismaClient, principal: TenantPrincipal, findingId: string) {
  const finding = await prisma.finding.findUnique({
    where: { id: findingId },
    include: { sourceLocations: true, validations: true, remediation: true },
  });
  if (!finding) throw new NotFoundError(`Finding ${findingId} not found`);
  assertSameOrganization(principal.organizationId, finding.organizationId, "finding");
  return finding;
}

export interface ValidateFindingResult {
  runId: string;
  status: string;
}

/**
 * Validate Finding (POST /v1/security/findings/{finding_id}/validate).
 * Creates a `finding_validation` run and enqueues a focused Strix mission
 * directly — policy and authorization are still fully enforced; the MCP
 * request path does not bypass either.
 */
export async function validateFinding(
  prisma: PrismaClient,
  jobQueue: JobQueue,
  agent: AuthenticatedAgent,
  findingId: string,
  targetEnvironmentId: string,
): Promise<ValidateFindingResult> {
  assertOperationAllowed(agent.permissions, "validate_finding");
  const finding = await loadOwnedFinding(prisma, agent, findingId);

  const target = await authorizeTargetEnvironment(prisma, {
    organizationId: agent.organizationId,
    repositoryId: finding.repositoryId,
    targetEnvironmentId,
    permissions: agent.permissions,
  });

  if (finding.status === "source_confirmed") {
    await prisma.$transaction((tx) =>
      transitionFindingStatus(tx, {
        findingId: finding.id,
        to: "validation_queued",
        actor: { type: agent.type === "internal" ? "system" : "agent", id: agent.agentIdentityId },
        eventType: "finding.validation_queued",
        metadata: { reason: "Explicit validate-finding request" },
      }),
    );
  }

  const idempotencyKey = computeRunIdempotencyKey({
    organizationId: agent.organizationId,
    repositoryId: finding.repositoryId,
    baseSha: finding.lastSeenCommit,
    headSha: finding.lastSeenCommit,
    runType: "finding_validation",
    policyVersion: "2026-01-01",
  });

  const run = await prisma.securityRun.create({
    data: {
      organizationId: agent.organizationId,
      repositoryId: finding.repositoryId,
      requestedByAgentId: agent.agentIdentityId,
      runType: "finding_validation",
      baseSha: finding.lastSeenCommit,
      headSha: finding.lastSeenCommit,
      targetEnvironmentId: target.id,
      policyVersion: "2026-01-01",
      idempotencyKey,
    },
  });

  await jobQueue.enqueue({
    jobType: "run_strix_validation",
    organizationId: agent.organizationId,
    idempotencyKey: `${idempotencyKey}:strix:${finding.id}`,
    payload: { runId: run.id, findingId: finding.id },
  });

  return { runId: run.id, status: run.status };
}

export interface SubmitFixResult {
  findingId: string;
  status: string;
}

/** Submit Fix (POST /v1/security/findings/{finding_id}/fix). */
export async function submitFixForFinding(
  prisma: PrismaClient,
  agent: AuthenticatedAgent,
  findingId: string,
  fixCommitSha: string,
): Promise<SubmitFixResult> {
  assertOperationAllowed(agent.permissions, "submit_fix");
  await loadOwnedFinding(prisma, agent, findingId);

  const outcome = await submitFix(prisma, {
    findingId,
    fixCommitSha,
    actor: { type: agent.type === "internal" ? "system" : "agent", id: agent.agentIdentityId },
  });
  return { findingId, status: outcome.findingStatus };
}

export interface VerifyFixResult {
  runId: string;
  status: string;
}

/** Verify Fix (POST /v1/security/findings/{finding_id}/verify-fix). */
export async function verifyFixForFinding(
  prisma: PrismaClient,
  jobQueue: JobQueue,
  agent: AuthenticatedAgent,
  findingId: string,
  targetEnvironmentId: string | undefined,
): Promise<VerifyFixResult> {
  assertOperationAllowed(agent.permissions, "verify_fix");
  const finding = await loadOwnedFinding(prisma, agent, findingId);

  if (targetEnvironmentId) {
    await authorizeTargetEnvironment(prisma, {
      organizationId: agent.organizationId,
      repositoryId: finding.repositoryId,
      targetEnvironmentId,
      permissions: agent.permissions,
    });
  }

  const remediation = await prisma.remediation.findUnique({ where: { findingId } });
  const idempotencyKey = computeRunIdempotencyKey({
    organizationId: agent.organizationId,
    repositoryId: finding.repositoryId,
    baseSha: finding.lastSeenCommit,
    headSha: remediation?.fixCommitSha ?? finding.lastSeenCommit,
    runType: "fix_verification",
    policyVersion: "2026-01-01",
  });

  const outcome = await startFixVerification(prisma, {
    findingId,
    organizationId: agent.organizationId,
    repositoryId: finding.repositoryId,
    requestedByAgentId: agent.agentIdentityId,
    targetEnvironmentId,
    policyVersion: "2026-01-01",
    idempotencyKey,
    actor: { type: agent.type === "internal" ? "system" : "agent", id: agent.agentIdentityId },
  });

  await jobQueue.enqueue({
    jobType: "prepare_repository",
    organizationId: agent.organizationId,
    idempotencyKey: `${idempotencyKey}:prepare`,
    payload: { runId: outcome.runId },
  });

  return { runId: outcome.runId, status: "queued" };
}
