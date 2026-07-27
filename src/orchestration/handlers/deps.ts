import type { PrismaClient, Repository } from "@prisma/client";
import type { ArtifactStore } from "../../artifacts/artifact-store.js";
import type { DeepSecAdapter } from "../../adapters/deepsec/deepsec-adapter.js";
import type { StrixAdapter } from "../../adapters/strix/strix-adapter.js";
import type { JobQueue } from "../job-queue.js";
import { isRunTerminal } from "../../domain/run-state-machine.js";
import { transitionRunStatus } from "../../domain/run-transitions.js";

export interface HandlerDeps {
  prisma: PrismaClient;
  jobQueue: JobQueue;
  artifactStore: ArtifactStore;
  deepsecAdapter: DeepSecAdapter;
  strixAdapter: StrixAdapter;
  workspaceRoot: string;
  resolveCloneUrl: (repository: Pick<Repository, "owner" | "name" | "provider">) => string;
  policyVersion: string;
}

/**
 * Decides a change_review/repository_scan/finding_validation run's final
 * disposition from the findings it touched, transitions the run, and
 * enqueues receipt generation. Idempotent — a run already at a terminal
 * status is left alone, so this is safe to call from more than one
 * completing branch (e.g. the last of several parallel Strix validations).
 */
export async function finalizeRun(deps: HandlerDeps, runId: string): Promise<void> {
  const run = await deps.prisma.securityRun.findUniqueOrThrow({ where: { id: runId } });
  if (isRunTerminal(run.status)) return;

  const auditEvents = await deps.prisma.auditEvent.findMany({ where: { runId }, select: { findingId: true } });
  const findingIds = [...new Set(auditEvents.map((e) => e.findingId).filter((id): id is string => Boolean(id)))];
  const findings = findingIds.length
    ? await deps.prisma.finding.findMany({ where: { id: { in: findingIds } } })
    : [];

  const hasBlocking = findings.some((f) => f.status === "confirmed" || f.status === "still_exploitable");
  const hasAwaitingFix = findings.some((f) => f.status === "source_confirmed" || f.status === "fix_pending");
  const nextStatus = hasBlocking ? "blocked" : hasAwaitingFix ? "awaiting_fix" : "completed";

  await deps.prisma.$transaction((tx) =>
    transitionRunStatus(tx, {
      runId,
      to: nextStatus,
      actor: { type: "system" },
      eventType: `run.${nextStatus}`,
    }),
  );

  await deps.jobQueue.enqueue({
    jobType: "generate_receipt",
    organizationId: run.organizationId,
    idempotencyKey: `${run.idempotencyKey}:receipt`,
    payload: { runId },
  });
}
