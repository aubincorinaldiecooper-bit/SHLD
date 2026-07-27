import type { Prisma, PrismaClient } from "@prisma/client";
import { ArtifactStore } from "../../artifacts/artifact-store.js";
import { recordAuditEvent } from "../../audit/audit-log.js";
import { transitionFindingStatus } from "../../domain/finding-transitions.js";
import type { DeepSecRunResult } from "./deepsec-adapter.js";
import type { NormalizedFinding } from "./normalize.js";

export interface PersistDeepSecRunParams {
  organizationId: string;
  repositoryId: string;
  runId: string;
  operation: string;
  headSha: string;
  result: DeepSecRunResult;
}

export interface PersistDeepSecRunOutcome {
  engineExecutionId: string;
  findingIds: string[];
}

/**
 * Writes the raw DeepSec output as a restricted artifact, records the
 * EngineExecution (cost/tokens/version/exit code), and upserts each
 * normalized finding by fingerprint — creating new findings as `suspected`
 * (auto-advancing to `source_confirmed` when DeepSec itself reports high
 * confidence) or extending an existing finding's `lastSeenCommit` when the
 * same fingerprint reappears. Every creation/transition writes its own
 * audit event.
 */
export async function persistDeepSecRun(
  prisma: PrismaClient,
  artifactStore: ArtifactStore,
  params: PersistDeepSecRunParams,
): Promise<PersistDeepSecRunOutcome> {
  const stored = await artifactStore.store(params.result.rawStdout, "deepsec");

  return prisma.$transaction(async (tx) => {
    const artifact = await tx.artifact.create({
      data: {
        organizationId: params.organizationId,
        runId: params.runId,
        type: "deepsec_raw_output",
        storageLocation: stored.storageLocation,
        contentHash: stored.contentHash,
        metadata: { operation: params.operation, model: params.result.model },
      },
    });

    const engineExecution = await tx.engineExecution.create({
      data: {
        runId: params.runId,
        engine: "deepsec",
        operation: params.operation,
        status: "completed",
        outputArtifactId: artifact.id,
        engineVersion: params.result.engineVersion,
        startedAt: new Date(Date.now() - params.result.durationMs),
        completedAt: new Date(),
        exitCode: params.result.exitCode,
        estimatedCostUsd: params.result.estimatedCostUsd,
        inputTokens: params.result.inputTokens,
        outputTokens: params.result.outputTokens,
      },
    });

    const findingIds: string[] = [];
    for (const finding of params.result.findings) {
      const findingId = await upsertFinding(tx, {
        organizationId: params.organizationId,
        repositoryId: params.repositoryId,
        runId: params.runId,
        headSha: params.headSha,
        finding,
      });
      findingIds.push(findingId);
    }

    return { engineExecutionId: engineExecution.id, findingIds };
  });
}

interface UpsertFindingParams {
  organizationId: string;
  repositoryId: string;
  runId: string;
  headSha: string;
  finding: NormalizedFinding;
}

async function upsertFinding(tx: Prisma.TransactionClient, params: UpsertFindingParams): Promise<string> {
  const existing = await tx.finding.findUnique({
    where: {
      repositoryId_fingerprint: { repositoryId: params.repositoryId, fingerprint: params.finding.fingerprint },
    },
  });

  if (!existing) {
    const created = await tx.finding.create({
      data: {
        organizationId: params.organizationId,
        repositoryId: params.repositoryId,
        fingerprint: params.finding.fingerprint,
        title: params.finding.title,
        description: params.finding.description,
        category: params.finding.category,
        cwe: params.finding.cwe,
        severity: params.finding.severity,
        confidence: params.finding.confidence,
        discoveryEngine: "deepsec",
        findingClass: "source",
        firstSeenCommit: params.headSha,
        lastSeenCommit: params.headSha,
        sourceLocations: {
          create: [
            {
              filePath: params.finding.filePath,
              startLine: params.finding.startLine,
              endLine: params.finding.endLine,
              commitSha: params.headSha,
              symbol: params.finding.symbol,
            },
          ],
        },
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
      metadata: { discoveredBy: "deepsec" },
    });

    // DeepSec reporting high confidence on first discovery stands in for
    // its own internal revalidation pass; medium/low confidence findings
    // stay `suspected` pending an explicit revalidation step.
    if (params.finding.confidence === "high") {
      await transitionFindingStatus(tx, {
        findingId: created.id,
        to: "source_confirmed",
        actor: { type: "system" },
        eventType: "finding.source_confirmed",
        runId: params.runId,
        metadata: { reason: "DeepSec reported high confidence on initial discovery" },
      });
    }

    return created.id;
  }

  await tx.finding.update({
    where: { id: existing.id },
    data: { lastSeenCommit: params.headSha },
  });
  await tx.findingSourceLocation.create({
    data: {
      findingId: existing.id,
      filePath: params.finding.filePath,
      startLine: params.finding.startLine,
      endLine: params.finding.endLine,
      commitSha: params.headSha,
      symbol: params.finding.symbol,
    },
  });
  return existing.id;
}
