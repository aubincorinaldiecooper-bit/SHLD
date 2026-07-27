import type { JobHandler } from "../job-queue.js";
import { transitionRunStatus } from "../../domain/run-transitions.js";
import { applyRoutingPolicy } from "../../policy/apply-routing-policy.js";
import { parseAgentPermissions } from "../../auth/permissions.js";
import { authorizeTargetEnvironment } from "../../authz/target-authorization.js";
import { generateReceipt } from "../../receipts/generate-receipt.js";
import type { HandlerDeps } from "./deps.js";
import { finalizeRun } from "./deps.js";
import type { RunJobPayload } from "./prepare-and-classify.js";

const ESTIMATED_STRIX_VALIDATION_COST_USD = 0.5;

/** Decides, per source-confirmed finding this run touched, whether Strix validation is required. */
export function createApplyRoutingPolicyHandler(deps: HandlerDeps): JobHandler<RunJobPayload> {
  return async (payload) => {
    const run = await deps.prisma.securityRun.findUniqueOrThrow({
      where: { id: payload.runId },
      include: { requestedByAgent: true },
    });
    const permissions = parseAgentPermissions(run.requestedByAgent.permissions);

    const auditEvents = await deps.prisma.auditEvent.findMany({ where: { runId: run.id }, select: { findingId: true } });
    const findingIds = [...new Set(auditEvents.map((e) => e.findingId).filter((id): id is string => Boolean(id)))];
    const candidates = await deps.prisma.finding.findMany({
      where: { id: { in: findingIds }, status: "source_confirmed" },
    });

    const spentSoFar = await deps.prisma.engineExecution.aggregate({
      where: { runId: run.id },
      _sum: { estimatedCostUsd: true },
    });
    const remainingBudgetUsd = permissions.maxRunBudgetUsd - Number(spentSoFar._sum.estimatedCostUsd ?? 0);

    let targetAuthorized = false;
    if (run.targetEnvironmentId) {
      try {
        await authorizeTargetEnvironment(deps.prisma, {
          organizationId: run.organizationId,
          repositoryId: run.repositoryId,
          targetEnvironmentId: run.targetEnvironmentId,
          permissions,
        });
        targetAuthorized = true;
      } catch {
        targetAuthorized = false;
      }
    }

    for (const finding of candidates) {
      const alreadyTested = run.targetEnvironmentId
        ? await deps.prisma.validation.findFirst({
            where: { findingId: finding.id, targetBuildId: run.headSha },
          })
        : null;

      const decision = await deps.prisma.$transaction((tx) =>
        applyRoutingPolicy(tx, {
          runId: run.id,
          findingId: finding.id,
          input: {
            severity: finding.severity,
            confidence: finding.confidence,
            category: finding.category,
            runtimeBehaviorRequired: false,
            targetAuthorized,
            targetIsProduction: false,
            canBeExercisedDynamically: targetAuthorized,
            alreadyTestedAgainstBuild: Boolean(alreadyTested),
            remainingBudgetUsd,
            estimatedValidationCostUsd: ESTIMATED_STRIX_VALIDATION_COST_USD,
            policyVersion: run.policyVersion,
          },
        }),
      );

      if (decision.decision === "escalate") {
        await deps.jobQueue.enqueue({
          jobType: "run_strix_validation",
          organizationId: run.organizationId,
          idempotencyKey: `${run.idempotencyKey}:strix:${finding.id}`,
          payload: { runId: run.id, findingId: finding.id },
        });
      }
    }

    const stillQueued = await deps.prisma.finding.count({
      where: { id: { in: findingIds }, status: "validation_queued" },
    });

    if (stillQueued > 0) {
      await deps.prisma.$transaction((tx) =>
        transitionRunStatus(tx, {
          runId: run.id,
          to: "validation_running",
          actor: { type: "system" },
          eventType: "run.validation_running",
        }),
      );
    } else {
      await finalizeRun(deps, run.id);
    }
  };
}

/** Generates (or regenerates) the run's receipt — always the last step of any pipeline. */
export function createGenerateReceiptHandler(deps: HandlerDeps): JobHandler<RunJobPayload> {
  return async (payload) => {
    await generateReceipt(deps.prisma, deps.artifactStore, payload.runId);
  };
}
