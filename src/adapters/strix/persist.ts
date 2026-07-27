import type { FindingStatus, PrismaClient } from "@prisma/client";
import { ArtifactStore } from "../../artifacts/artifact-store.js";
import { transitionFindingStatus } from "../../domain/finding-transitions.js";
import type { StrixRunResult } from "./strix-adapter.js";

export interface PersistStrixRunParams {
  organizationId: string;
  repositoryId: string;
  runId: string;
  findingId: string;
  targetEnvironmentId: string;
  targetBuildId?: string;
  result: StrixRunResult;
  /**
   * Overrides the default verdict->status mapping. Pass explicit `null` to
   * force "no transition" (e.g. a correlation-layer override for a build
   * mismatch or an incomplete test). Omit to use the direct mapping.
   */
  overrideFindingStatus?: FindingStatus | null;
  /** Recorded into the validation's evidence when the target build didn't match the intended commit. */
  buildMismatch?: boolean;
}

export interface PersistStrixRunOutcome {
  engineExecutionId: string;
  validationId: string;
  findingStatus: FindingStatus;
}

// Only a genuine security verdict advances the finding — an execution
// failure is an operational problem to retry, not evidence either way.
const VERDICT_TO_FINDING_STATUS: Record<string, FindingStatus | undefined> = {
  confirmed: "confirmed",
  not_reproduced: "not_reproduced",
  inconclusive: "inconclusive",
};

/**
 * Writes the raw Strix output (and, when present, the proof-of-concept) as
 * restricted artifacts, records the EngineExecution, creates the Validation
 * row linking the engine execution back to the finding and target, and
 * advances the finding's state to match the verdict — `failed` leaves the
 * finding at `validation_queued` so the job can be retried instead of
 * silently recording a false verdict.
 */
export async function persistStrixRun(
  prisma: PrismaClient,
  artifactStore: ArtifactStore,
  params: PersistStrixRunParams,
): Promise<PersistStrixRunOutcome> {
  const storedOutput = await artifactStore.store(params.result.rawStdout, "strix");
  const storedPoc = params.result.validation.proofOfConcept
    ? await artifactStore.store(params.result.validation.proofOfConcept, "strix-poc")
    : undefined;

  return prisma.$transaction(async (tx) => {
    const outputArtifact = await tx.artifact.create({
      data: {
        organizationId: params.organizationId,
        runId: params.runId,
        type: "strix_raw_output",
        storageLocation: storedOutput.storageLocation,
        contentHash: storedOutput.contentHash,
        metadata: { model: params.result.model },
      },
    });

    const pocArtifact = storedPoc
      ? await tx.artifact.create({
          data: {
            organizationId: params.organizationId,
            runId: params.runId,
            type: "proof_of_concept",
            storageLocation: storedPoc.storageLocation,
            contentHash: storedPoc.contentHash,
          },
        })
      : undefined;

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

    const evidenceSummary = params.buildMismatch
      ? `[BUILD MISMATCH — target build did not match the intended commit] ${params.result.validation.evidenceSummary ?? ""}`.trim()
      : params.result.validation.evidenceSummary;

    const validation = await tx.validation.create({
      data: {
        findingId: params.findingId,
        engineExecutionId: engineExecution.id,
        status: params.result.validation.status,
        targetEnvironmentId: params.targetEnvironmentId,
        targetBuildId: params.targetBuildId,
        endpoint: params.result.validation.endpoint,
        method: params.result.validation.method,
        evidenceSummary,
        proofArtifactId: pocArtifact?.id,
        validatedAt: new Date(),
      },
    });

    const nextFindingStatus =
      params.overrideFindingStatus !== undefined
        ? params.overrideFindingStatus
        : VERDICT_TO_FINDING_STATUS[params.result.validation.status];
    if (nextFindingStatus) {
      await transitionFindingStatus(tx, {
        findingId: params.findingId,
        to: nextFindingStatus,
        actor: { type: "system" },
        eventType: `finding.${nextFindingStatus}`,
        runId: params.runId,
        metadata: {
          engine: "strix",
          evidenceSummary: params.result.validation.evidenceSummary,
          endpoint: params.result.validation.endpoint,
          rawVerdict: params.result.validation.status,
          buildMismatch: params.buildMismatch ?? false,
        },
      });
    }

    const finding = await tx.finding.findUniqueOrThrow({ where: { id: params.findingId } });

    return { engineExecutionId: engineExecution.id, validationId: validation.id, findingStatus: finding.status };
  });
}
