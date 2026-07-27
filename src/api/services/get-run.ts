import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedAgent } from "../../auth/authenticate-agent.js";
import { assertSameOrganization } from "../../auth/tenant-isolation.js";
import { NotFoundError } from "../../domain/errors.js";

const NEXT_ACTION_BY_STATUS: Record<string, string> = {
  queued: "Wait for classification to begin.",
  classifying: "Wait for the change classifier.",
  source_review_running: "Wait for DeepSec source review.",
  source_review_completed: "Wait for routing policy evaluation.",
  validation_waiting_for_target: "Provide or wait for an authorized target environment.",
  validation_running: "Wait for Strix validation to complete.",
  awaiting_fix: "Submit a fix commit for the confirmed finding(s).",
  fix_verification_running: "Wait for fix verification to complete.",
  completed: "None — review passed.",
  blocked: "Submit a fix commit for the confirmed finding(s).",
  failed: "Inspect failureReason and retry if appropriate.",
  cancelled: "None — review was cancelled.",
};

export interface GetRunResult {
  runId: string;
  status: string;
  requestingAgent: { id: string; name: string; type: string };
  repository: { id: string; owner: string; name: string };
  baseSha: string;
  headSha: string;
  pullRequestNumber: number | null;
  classification: unknown;
  routingDecisions: unknown[];
  engineExecutions: unknown[];
  findings: Array<{ id: string; title: string; severity: string; status: string; category: string }>;
  totalCostUsd: number;
  errors: string | null;
  nextAction: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** Get Run (GET /v1/security/runs/{run_id}). */
export async function getRun(prisma: PrismaClient, agent: AuthenticatedAgent, runId: string): Promise<GetRunResult> {
  const run = await prisma.securityRun.findUnique({
    where: { id: runId },
    include: {
      requestedByAgent: true,
      repository: true,
      classification: true,
      routingDecisions: true,
      engineExecutions: true,
    },
  });
  if (!run) throw new NotFoundError(`Security run ${runId} not found`);
  assertSameOrganization(agent.organizationId, run.organizationId, "security run");

  const auditEvents = await prisma.auditEvent.findMany({ where: { runId }, select: { findingId: true } });
  const findingIds = [...new Set(auditEvents.map((e) => e.findingId).filter((id): id is string => Boolean(id)))];
  const findings = findingIds.length
    ? await prisma.finding.findMany({
        where: { id: { in: findingIds } },
        select: { id: true, title: true, severity: true, status: true, category: true },
      })
    : [];
  const totalCostUsd = run.engineExecutions.reduce((sum, e) => sum + Number(e.estimatedCostUsd ?? 0), 0);

  return {
    runId: run.id,
    status: run.status,
    requestingAgent: { id: run.requestedByAgent.id, name: run.requestedByAgent.name, type: run.requestedByAgent.type },
    repository: { id: run.repository.id, owner: run.repository.owner, name: run.repository.name },
    baseSha: run.baseSha,
    headSha: run.headSha,
    pullRequestNumber: run.pullRequestNumber,
    classification: run.classification,
    routingDecisions: run.routingDecisions,
    engineExecutions: run.engineExecutions,
    findings,
    totalCostUsd,
    errors: run.failureReason,
    nextAction: NEXT_ACTION_BY_STATUS[run.status] ?? "Unknown",
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}
