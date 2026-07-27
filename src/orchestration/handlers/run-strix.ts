import type { JobHandler } from "../job-queue.js";
import { buildStrixInstruction } from "../../adapters/strix/build-instruction.js";
import type { StrixMission, StrixTestAccount } from "../../adapters/strix/types.js";
import { persistStrixRun } from "../../adapters/strix/persist.js";
import { correlateStrixValidation } from "../../correlation/correlate-strix-validation.js";
import { commitMatchesBuild } from "../../correlation/build-match.js";
import { buildRetestMission } from "../../remediation/build-retest-mission.js";
import { completeFixVerification } from "../../remediation/complete-fix-verification.js";
import type { HandlerDeps } from "./deps.js";
import { finalizeRun } from "./deps.js";
import type { FixVerificationJobPayload } from "./run-deepsec.js";

// Preview/staging deployments are assumed rebuilt fresh for the commit
// under test — this beta has no real deployment-webhook integration to
// resolve an independently-observed build id, so the run's own head SHA
// stands in for "what the target is currently running". See README /
// final report for the limitation this implies for build-match checks.
function assumedTargetBuildId(headSha: string): string {
  return headSha;
}

function parseTestAccounts(raw: unknown): StrixTestAccount[] {
  if (!Array.isArray(raw)) return [];
  return raw as StrixTestAccount[];
}

/** Runs a focused Strix validation mission for one finding against the run's target. */
export function createRunStrixValidationHandler(deps: HandlerDeps): JobHandler<FixVerificationJobPayload> {
  return async (payload, ctx) => {
    const run = await deps.prisma.securityRun.findUniqueOrThrow({ where: { id: payload.runId } });
    if (!run.targetEnvironmentId) {
      throw new Error(`Run ${run.id} has no target environment; cannot run Strix validation`);
    }
    const [finding, target] = await Promise.all([
      deps.prisma.finding.findUniqueOrThrow({ where: { id: payload.findingId }, include: { sourceLocations: true } }),
      deps.prisma.targetEnvironment.findUniqueOrThrow({ where: { id: run.targetEnvironmentId } }),
    ]);
    const primaryLocation = finding.sourceLocations[0];

    const mission: StrixMission = {
      findingId: finding.id,
      hypothesis: finding.description,
      sourceFile: primaryLocation?.filePath ?? "unknown",
      sourceLines:
        primaryLocation?.startLine && primaryLocation?.endLine
          ? `${primaryLocation.startLine}-${primaryLocation.endLine}`
          : undefined,
      targetBaseUrl: target.baseUrl,
      allowedScope: target.allowedPaths,
      excludedPaths: target.excludedPaths,
      testAccounts: parseTestAccounts(target.testAccounts),
      destructiveTestingAllowed: target.destructiveTestingAllowed,
    };

    const result = await deps.strixAdapter.run({
      mission,
      instruction: buildStrixInstruction(mission),
      targetBuildId: assumedTargetBuildId(run.headSha),
      workDir: deps.workspaceRoot,
      signal: ctx.signal,
    });

    await correlateStrixValidation(deps.prisma, deps.artifactStore, {
      organizationId: run.organizationId,
      repositoryId: run.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      expectedCommitSha: run.headSha,
      actualTargetBuildId: assumedTargetBuildId(run.headSha),
      testComplete: true,
      result,
    });

    const remainingQueued = await deps.prisma.finding.count({
      where: {
        id: { in: await findingIdsForRun(deps, run.id) },
        status: "validation_queued",
      },
    });
    if (remainingQueued === 0) {
      await finalizeRun(deps, run.id);
    }
  };
}

async function findingIdsForRun(deps: HandlerDeps, runId: string): Promise<string[]> {
  const events = await deps.prisma.auditEvent.findMany({ where: { runId }, select: { findingId: true } });
  return [...new Set(events.map((e) => e.findingId).filter((id): id is string => Boolean(id)))];
}

/** Replays the original confirmed exploit against the patched target for fix verification. */
export function createRunStrixRetestHandler(deps: HandlerDeps): JobHandler<FixVerificationJobPayload> {
  return async (payload, ctx) => {
    const run = await deps.prisma.securityRun.findUniqueOrThrow({ where: { id: payload.runId } });
    if (!run.targetEnvironmentId) {
      throw new Error(`Run ${run.id} has no target environment; cannot run Strix retest`);
    }
    const [finding, target, remediation, originalValidation] = await Promise.all([
      deps.prisma.finding.findUniqueOrThrow({ where: { id: payload.findingId }, include: { sourceLocations: true } }),
      deps.prisma.targetEnvironment.findUniqueOrThrow({ where: { id: run.targetEnvironmentId } }),
      deps.prisma.remediation.findUniqueOrThrow({ where: { findingId: payload.findingId } }),
      deps.prisma.validation.findFirst({ where: { findingId: payload.findingId, status: "confirmed" }, orderBy: { validatedAt: "asc" } }),
    ]);
    const primaryLocation = finding.sourceLocations[0];

    const mission = buildRetestMission({
      findingId: finding.id,
      findingTitle: finding.title,
      sourceFile: primaryLocation?.filePath ?? "unknown",
      sourceLines:
        primaryLocation?.startLine && primaryLocation?.endLine
          ? `${primaryLocation.startLine}-${primaryLocation.endLine}`
          : undefined,
      targetBaseUrl: target.baseUrl,
      allowedScope: target.allowedPaths,
      excludedPaths: target.excludedPaths,
      testAccounts: parseTestAccounts(target.testAccounts),
      destructiveTestingAllowed: target.destructiveTestingAllowed,
      originalEvidence: {
        endpoint: originalValidation?.endpoint,
        method: originalValidation?.method,
        evidenceSummary: originalValidation?.evidenceSummary,
      },
    });

    const result = await deps.strixAdapter.run({
      mission,
      instruction: buildStrixInstruction(mission),
      targetBuildId: assumedTargetBuildId(run.headSha),
      workDir: deps.workspaceRoot,
      signal: ctx.signal,
    });

    await persistStrixRun(deps.prisma, deps.artifactStore, {
      organizationId: run.organizationId,
      repositoryId: run.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      targetBuildId: assumedTargetBuildId(run.headSha),
      result,
      // The finding sits at `retesting`, whose only legal exits are
      // decided by completeFixVerification below — never let the raw
      // verdict->status map attempt an illegal direct transition.
      overrideFindingStatus: null,
    });

    const runtimeRetestPassed =
      result.validation.status === "not_reproduced" ? true : result.validation.status === "confirmed" ? false : null;
    const sourceRevalidationPassed =
      remediation.sourceRevalidationStatus === "passed"
        ? true
        : remediation.sourceRevalidationStatus === "failed"
          ? false
          : null;

    await completeFixVerification(deps.prisma, {
      findingId: finding.id,
      runId: run.id,
      actor: { type: "system" },
      sourceRevalidationPassed,
      runtimeRetestRequired: true,
      runtimeRetestPassed,
      targetBuildMatchesFixCommit: commitMatchesBuild(remediation.fixCommitSha, assumedTargetBuildId(run.headSha)),
      operationalFailure: result.validation.status === "failed",
    });

    await finalizeRun(deps, run.id);
  };
}
