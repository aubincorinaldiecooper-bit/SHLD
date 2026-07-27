import type { JobHandler } from "../job-queue.js";
import { transitionRunStatus } from "../../domain/run-transitions.js";
import { prepareRepositorySnapshot } from "../../repo-prep/repository-preparation.js";
import { classifyChange } from "../../policy/change-classifier.js";
import type { HandlerDeps } from "./deps.js";

export interface RunJobPayload {
  runId: string;
}

/**
 * Materializes the immutable source snapshot for the run's base/head SHA
 * pair. Used by change_review, repository_scan, and fix_verification runs
 * (finding_validation runs need no source snapshot — they validate an
 * already-known finding against a live target).
 */
export function createPrepareRepositoryHandler(deps: HandlerDeps): JobHandler<RunJobPayload> {
  return async (payload) => {
    const run = await deps.prisma.securityRun.findUniqueOrThrow({
      where: { id: payload.runId },
      include: { repository: true },
    });

    await deps.prisma.$transaction((tx) =>
      transitionRunStatus(tx, {
        runId: run.id,
        to: "classifying",
        actor: { type: "system" },
        eventType: "run.classifying",
      }),
    );

    const cloneUrl = deps.resolveCloneUrl(run.repository);
    const snapshot = await prepareRepositorySnapshot({
      repositoryId: run.repositoryId,
      cloneUrl,
      baseSha: run.baseSha,
      headSha: run.headSha,
      workspaceRoot: deps.workspaceRoot,
    });

    const stored = await deps.artifactStore.store(
      JSON.stringify({
        snapshotPath: snapshot.snapshotPath,
        changedFiles: snapshot.changedFiles,
        treeHash: snapshot.treeHash,
      }),
      "snapshots",
    );
    await deps.prisma.artifact.create({
      data: {
        organizationId: run.organizationId,
        runId: run.id,
        type: "source_snapshot",
        storageLocation: stored.storageLocation,
        contentHash: stored.contentHash,
        metadata: {
          snapshotPath: snapshot.snapshotPath,
          changedFiles: snapshot.changedFiles.map((f) => f.path),
          languages: snapshot.detectedLanguages,
          frameworks: snapshot.detectedFrameworks,
          sensitivePaths: snapshot.sensitivePaths,
        },
      },
    });

    if (run.runType === "fix_verification") {
      // A fix_verification run always targets exactly one finding, recorded
      // by startFixVerification's `finding.retesting` audit event — recover
      // it here rather than growing the run-level job payload.
      const retestingEvent = await deps.prisma.auditEvent.findFirstOrThrow({
        where: { runId: run.id, eventType: "finding.retesting" },
      });
      await deps.jobQueue.enqueue({
        jobType: "run_deepsec_revalidation",
        organizationId: run.organizationId,
        idempotencyKey: `${run.idempotencyKey}:run_deepsec_revalidation`,
        payload: { runId: run.id, findingId: retestingEvent.findingId! },
      });
      return;
    }

    await deps.jobQueue.enqueue({
      jobType: "classify_change",
      organizationId: run.organizationId,
      idempotencyKey: `${run.idempotencyKey}:classify_change`,
      payload: { runId: run.id },
    });
  };
}

/** Runs the deterministic classifier and persists the result, then queues DeepSec. */
export function createClassifyChangeHandler(deps: HandlerDeps): JobHandler<RunJobPayload> {
  return async (payload) => {
    const run = await deps.prisma.securityRun.findUniqueOrThrow({ where: { id: payload.runId } });
    const snapshotArtifact = await deps.prisma.artifact.findFirst({
      where: { runId: run.id, type: "source_snapshot" },
      orderBy: { createdAt: "desc" },
    });
    if (!snapshotArtifact) {
      throw new Error(`No source snapshot artifact found for run ${run.id}`);
    }
    const metadata = snapshotArtifact.metadata as { changedFiles: string[] };

    const policyConfig = await deps.prisma.repositoryPolicyConfig.findUnique({
      where: { repositoryId: run.repositoryId },
    });

    const priorFindings = await deps.prisma.finding.findMany({
      where: { repositoryId: run.repositoryId, status: { notIn: ["dismissed"] } },
      select: { category: true },
    });

    const classification = classifyChange({
      changedFiles: metadata.changedFiles.map((path) => ({ path, changeType: "modified" })),
      sensitivePathPatterns: policyConfig?.sensitivePathPatterns,
      previousFindingCategories: priorFindings.map((f) => f.category),
    });

    await deps.prisma.runClassification.create({
      data: {
        runId: run.id,
        riskLevel: classification.riskLevel,
        securitySensitive: classification.securitySensitive,
        categories: classification.categories,
        recommendedReview: classification.recommendedReview,
        requiresPreviewTarget: classification.requiresPreviewTarget,
        reasons: classification.reasons,
        changedFiles: metadata.changedFiles,
      },
    });

    await deps.prisma.$transaction((tx) =>
      transitionRunStatus(tx, {
        runId: run.id,
        to: "source_review_running",
        actor: { type: "system" },
        eventType: "run.source_review_running",
        metadata: { riskLevel: classification.riskLevel },
      }),
    );

    const nextJobType = run.runType === "repository_scan" ? "run_deepsec_full" : "run_deepsec_diff";
    await deps.jobQueue.enqueue({
      jobType: nextJobType,
      organizationId: run.organizationId,
      idempotencyKey: `${run.idempotencyKey}:${nextJobType}`,
      payload: { runId: run.id },
    });
  };
}
