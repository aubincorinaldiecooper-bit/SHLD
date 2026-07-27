import type { FindingStatus, PrismaClient } from "@prisma/client";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { recordAuditEvent } from "../audit/audit-log.js";
import { transitionFindingStatus } from "../domain/finding-transitions.js";
import { persistStrixRun, type PersistStrixRunOutcome } from "../adapters/strix/persist.js";
import type { StrixRunResult } from "../adapters/strix/strix-adapter.js";
import { commitMatchesBuild } from "./build-match.js";
import { computeFindingFingerprint } from "./fingerprint.js";
import { resolveFindingStatusFromValidation } from "./resolve-finding-status.js";

export interface CorrelateStrixValidationParams {
  organizationId: string;
  repositoryId: string;
  runId: string;
  /** Absent for an exploratory mission not tied to one pre-existing finding. */
  findingId?: string;
  targetEnvironmentId: string;
  /** The commit the mission intended to test. */
  expectedCommitSha: string;
  /** The commit the target was actually running when Strix tested it, if known. */
  actualTargetBuildId?: string;
  /** False if the run was cut short (timeout, cancellation) before exhausting the hypothesis. */
  testComplete: boolean;
  result: StrixRunResult;
}

export interface CorrelateStrixValidationOutcome {
  engineExecutionId: string;
  validationId: string;
  findingId: string;
  findingStatus: FindingStatus;
  isNewFinding: boolean;
  buildMismatch: boolean;
}

/**
 * The correlation engine: merges Strix runtime evidence with a finding's
 * source evidence and applies the conflict rules —
 *  - build mismatch or incomplete test -> inconclusive, never conclusive
 *  - Strix confirms something no existing finding covers -> a new finding,
 *    not an assumed match
 *  - a genuine execution failure never touches finding state
 */
export async function correlateStrixValidation(
  prisma: PrismaClient,
  artifactStore: ArtifactStore,
  params: CorrelateStrixValidationParams,
): Promise<CorrelateStrixValidationOutcome> {
  const buildMismatch = !commitMatchesBuild(params.expectedCommitSha, params.actualTargetBuildId);

  if (params.findingId) {
    const resolvedStatus = resolveFindingStatusFromValidation({
      verdict: params.result.validation.status,
      buildMatches: !buildMismatch,
      testComplete: params.testComplete,
    });

    const outcome: PersistStrixRunOutcome = await persistStrixRun(prisma, artifactStore, {
      organizationId: params.organizationId,
      repositoryId: params.repositoryId,
      runId: params.runId,
      findingId: params.findingId,
      targetEnvironmentId: params.targetEnvironmentId,
      targetBuildId: params.actualTargetBuildId,
      result: params.result,
      overrideFindingStatus: resolvedStatus,
      buildMismatch,
    });

    return {
      engineExecutionId: outcome.engineExecutionId,
      validationId: outcome.validationId,
      findingId: params.findingId,
      findingStatus: outcome.findingStatus,
      isNewFinding: false,
      buildMismatch,
    };
  }

  // No existing finding was targeted. Strix confirming something here is a
  // genuinely new dynamic discovery — never silently attached to an
  // unrelated finding.
  if (params.result.validation.status !== "confirmed" || !params.result.validation.newDiscovery) {
    throw new Error(
      "correlateStrixValidation: a mission without a findingId must report a confirmed new_discovery, or it has nothing to correlate",
    );
  }

  const created = await createDynamicFinding(prisma, artifactStore, params);
  return { ...created, buildMismatch };
}

async function createDynamicFinding(
  prisma: PrismaClient,
  artifactStore: ArtifactStore,
  params: CorrelateStrixValidationParams,
): Promise<Omit<CorrelateStrixValidationOutcome, "buildMismatch">> {
  const discovery = params.result.validation.newDiscovery!;
  const primaryLocation = params.result.validation.codeLocations[0];
  const fingerprint = computeFindingFingerprint({
    repositoryId: params.repositoryId,
    category: discovery.category,
    filePath: primaryLocation?.file_path ?? params.result.validation.endpoint ?? "unknown",
    symbol: primaryLocation?.symbol,
    title: discovery.title,
  });

  const storedOutput = await artifactStore.store(params.result.rawStdout, "strix");

  return prisma.$transaction(async (tx) => {
    const outputArtifact = await tx.artifact.create({
      data: {
        organizationId: params.organizationId,
        runId: params.runId,
        type: "strix_raw_output",
        storageLocation: storedOutput.storageLocation,
        contentHash: storedOutput.contentHash,
        metadata: { model: params.result.model, discoveredBy: "strix" },
      },
    });

    const engineExecution = await tx.engineExecution.create({
      data: {
        runId: params.runId,
        engine: "strix",
        operation: "run_strix_validation",
        status: "completed",
        outputArtifactId: outputArtifact.id,
        engineVersion: params.result.engineVersion,
        startedAt: new Date(Date.now() - params.result.durationMs),
        completedAt: new Date(),
        exitCode: params.result.exitCode,
        estimatedCostUsd: params.result.estimatedCostUsd,
        inputTokens: params.result.inputTokens,
        outputTokens: params.result.outputTokens,
      },
    });

    const existing = await tx.finding.findUnique({
      where: { repositoryId_fingerprint: { repositoryId: params.repositoryId, fingerprint } },
    });
    if (existing) {
      // Same issue already known (e.g. from a prior dynamic run) — extend it
      // rather than creating a duplicate finding.
      await tx.finding.update({ where: { id: existing.id }, data: { lastSeenCommit: params.expectedCommitSha } });
      const validation = await tx.validation.create({
        data: {
          findingId: existing.id,
          engineExecutionId: engineExecution.id,
          status: "confirmed",
          targetEnvironmentId: params.targetEnvironmentId,
          targetBuildId: params.actualTargetBuildId,
          endpoint: params.result.validation.endpoint,
          method: params.result.validation.method,
          evidenceSummary: params.result.validation.evidenceSummary,
          validatedAt: new Date(),
        },
      });
      return {
        engineExecutionId: engineExecution.id,
        validationId: validation.id,
        findingId: existing.id,
        findingStatus: existing.status,
        isNewFinding: false,
      };
    }

    const created = await tx.finding.create({
      data: {
        organizationId: params.organizationId,
        repositoryId: params.repositoryId,
        fingerprint,
        title: discovery.title,
        description: params.result.validation.evidenceSummary ?? discovery.title,
        category: discovery.category,
        severity: normalizeSeverityLoose(discovery.severity),
        confidence: normalizeConfidenceLoose(discovery.confidence),
        discoveryEngine: "strix",
        findingClass: "dynamic",
        firstSeenCommit: params.expectedCommitSha,
        lastSeenCommit: params.expectedCommitSha,
        sourceLocations: primaryLocation
          ? {
              create: [
                {
                  filePath: primaryLocation.file_path,
                  startLine: primaryLocation.start_line,
                  endLine: primaryLocation.end_line,
                  commitSha: params.expectedCommitSha,
                  symbol: primaryLocation.symbol,
                },
              ],
            }
          : undefined,
      },
    });

    await recordAuditEvent(tx, {
      organizationId: params.organizationId,
      runId: params.runId,
      findingId: created.id,
      actor: { type: "system" },
      eventType: "finding.created",
      previousState: null,
      newState: "suspected",
      metadata: { discoveredBy: "strix", findingClass: "dynamic" },
    });

    // A dynamic-only finding's evidence chain runs entirely through Strix.
    // Walk the same legal state-machine path a source-confirmed-then-
    // validated finding would, so state integrity holds without pretending
    // DeepSec ever reviewed it.
    for (const to of ["source_confirmed", "validation_queued", "confirmed"] as const) {
      await transitionFindingStatus(tx, {
        findingId: created.id,
        to,
        actor: { type: "system" },
        eventType: `finding.${to}`,
        runId: params.runId,
        metadata: { reason: "Runtime-confirmed dynamic discovery; no separate source review step applies." },
      });
    }

    const validation = await tx.validation.create({
      data: {
        findingId: created.id,
        engineExecutionId: engineExecution.id,
        status: "confirmed",
        targetEnvironmentId: params.targetEnvironmentId,
        targetBuildId: params.actualTargetBuildId,
        endpoint: params.result.validation.endpoint,
        method: params.result.validation.method,
        evidenceSummary: params.result.validation.evidenceSummary,
        validatedAt: new Date(),
      },
    });

    return {
      engineExecutionId: engineExecution.id,
      validationId: validation.id,
      findingId: created.id,
      findingStatus: "confirmed" as FindingStatus,
      isNewFinding: true,
    };
  });
}

function normalizeSeverityLoose(raw: string): "critical" | "high" | "medium" | "low" | "info" {
  const key = raw.trim().toLowerCase();
  if (key === "critical" || key === "high" || key === "medium" || key === "low" || key === "info") return key;
  return "medium";
}

function normalizeConfidenceLoose(raw: string): "high" | "medium" | "low" {
  const key = raw.trim().toLowerCase();
  if (key === "high" || key === "medium" || key === "low") return key;
  return "medium";
}
