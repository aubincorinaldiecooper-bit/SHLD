import type { JobHandler } from "../job-queue.js";
import { transitionRunStatus } from "../../domain/run-transitions.js";
import { persistDeepSecRun } from "../../adapters/deepsec/persist.js";
import { completeFixVerification } from "../../remediation/complete-fix-verification.js";
import { commitMatchesBuild } from "../../correlation/build-match.js";
import type { HandlerDeps } from "./deps.js";
import { finalizeRun } from "./deps.js";
import type { RunJobPayload } from "./prepare-and-classify.js";

/** Runs DeepSec change-diff or full-repository review and queues routing. */
export function createRunDeepSecHandler(deps: HandlerDeps): JobHandler<RunJobPayload> {
  return async (payload, ctx) => {
    const run = await deps.prisma.securityRun.findUniqueOrThrow({ where: { id: payload.runId } });
    const snapshotArtifact = await deps.prisma.artifact.findFirst({
      where: { runId: run.id, type: "source_snapshot" },
      orderBy: { createdAt: "desc" },
    });
    if (!snapshotArtifact) {
      throw new Error(`No source snapshot artifact found for run ${run.id}`);
    }
    const metadata = snapshotArtifact.metadata as { snapshotPath: string };

    const result = await deps.deepsecAdapter.run(
      {
        operation: run.runType === "repository_scan" ? "full_audit" : "change_review",
        snapshotPath: metadata.snapshotPath,
        baseSha: run.baseSha,
        headSha: run.headSha,
        workDir: deps.workspaceRoot,
        signal: ctx.signal,
      },
      run.repositoryId,
    );

    await persistDeepSecRun(deps.prisma, deps.artifactStore, {
      organizationId: run.organizationId,
      repositoryId: run.repositoryId,
      runId: run.id,
      operation: run.runType === "repository_scan" ? "full_audit" : "change_review",
      headSha: run.headSha,
      result,
    });

    await deps.prisma.$transaction((tx) =>
      transitionRunStatus(tx, {
        runId: run.id,
        to: "source_review_completed",
        actor: { type: "system" },
        eventType: "run.source_review_completed",
        metadata: { findingCount: result.findings.length },
      }),
    );

    await deps.jobQueue.enqueue({
      jobType: "apply_routing_policy",
      organizationId: run.organizationId,
      idempotencyKey: `${run.idempotencyKey}:routing`,
      payload: { runId: run.id },
    });
  };
}

export interface FixVerificationJobPayload {
  runId: string;
  findingId: string;
}

/** Runs DeepSec's source revalidation against the fix commit for a fix_verification run. */
export function createRunDeepSecRevalidationHandler(deps: HandlerDeps): JobHandler<FixVerificationJobPayload> {
  return async (payload, ctx) => {
    const run = await deps.prisma.securityRun.findUniqueOrThrow({ where: { id: payload.runId } });
    const finding = await deps.prisma.finding.findUniqueOrThrow({
      where: { id: payload.findingId },
      include: { sourceLocations: true, remediation: true },
    });
    const snapshotArtifact = await deps.prisma.artifact.findFirst({
      where: { runId: run.id, type: "source_snapshot" },
      orderBy: { createdAt: "desc" },
    });
    if (!snapshotArtifact) {
      throw new Error(`No source snapshot artifact found for run ${run.id}`);
    }
    const metadata = snapshotArtifact.metadata as { snapshotPath: string };
    const primaryLocation = finding.sourceLocations[0];

    await deps.prisma.$transaction((tx) =>
      transitionRunStatus(tx, {
        runId: run.id,
        to: "source_review_running",
        actor: { type: "system" },
        eventType: "run.source_review_running",
      }),
    );

    const result = await deps.deepsecAdapter.run(
      {
        operation: "fix_revalidation",
        snapshotPath: metadata.snapshotPath,
        baseSha: run.baseSha,
        headSha: run.headSha,
        workDir: deps.workspaceRoot,
        originalFinding: {
          title: finding.title,
          filePath: primaryLocation?.filePath ?? "unknown",
          category: finding.category,
        },
        signal: ctx.signal,
      },
      run.repositoryId,
    );

    await persistDeepSecRun(deps.prisma, deps.artifactStore, {
      organizationId: run.organizationId,
      repositoryId: run.repositoryId,
      runId: run.id,
      operation: "fix_revalidation",
      headSha: run.headSha,
      result,
    });

    await deps.prisma.$transaction((tx) =>
      transitionRunStatus(tx, {
        runId: run.id,
        to: "source_review_completed",
        actor: { type: "system" },
        eventType: "run.source_review_completed",
      }),
    );

    const verdict = result.findings[0]?.revalidationVerdict ?? "unknown";
    const sourceRevalidationPassed = verdict === "unknown" ? null : verdict === "false_positive";

    const remediation = finding.remediation;
    if (!remediation) {
      throw new Error(`No remediation record for finding ${finding.id}`);
    }

    if (remediation.runtimeRetestStatus === "not_applicable") {
      // Source-only finding: this revalidation is the whole verification.
      await completeFixVerification(deps.prisma, {
        findingId: finding.id,
        runId: run.id,
        actor: { type: "system" },
        sourceRevalidationPassed,
        runtimeRetestRequired: false,
        runtimeRetestPassed: null,
        targetBuildMatchesFixCommit: false,
      });
      await finalizeRun(deps, run.id);
      return;
    }

    // Runtime-confirmed finding: stash the source-revalidation result and
    // queue the Strix replay, which will complete verification.
    await deps.prisma.remediation.update({
      where: { findingId: finding.id },
      data: { sourceRevalidationStatus: sourceRevalidationPassed === null ? "inconclusive" : sourceRevalidationPassed ? "passed" : "failed" },
    });

    await deps.prisma.$transaction((tx) =>
      transitionRunStatus(tx, {
        runId: run.id,
        to: "validation_running",
        actor: { type: "system" },
        eventType: "run.validation_running",
      }),
    );

    await deps.jobQueue.enqueue({
      jobType: "run_strix_retest",
      organizationId: run.organizationId,
      idempotencyKey: `${run.idempotencyKey}:strix_retest:${finding.id}`,
      payload: { runId: run.id, findingId: finding.id },
    });
  };
}

// commitMatchesBuild is re-exported for the retest handler's convenience.
export { commitMatchesBuild };
