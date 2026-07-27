import type { PrismaClient, SecurityRunStatus } from "@prisma/client";
import type { AuthenticatedAgent } from "../../auth/authenticate-agent.js";
import { assertSameOrganization } from "../../auth/tenant-isolation.js";
import { NotFoundError } from "../../domain/errors.js";
import { transitionRunStatus } from "../../domain/run-transitions.js";

export interface CancelRunResult {
  runId: string;
  status: SecurityRunStatus;
}

/** Cancel Run (POST /v1/security/runs/{run_id}/cancel). */
export async function cancelRun(prisma: PrismaClient, agent: AuthenticatedAgent, runId: string): Promise<CancelRunResult> {
  const run = await prisma.securityRun.findUnique({ where: { id: runId } });
  if (!run) throw new NotFoundError(`Security run ${runId} not found`);
  assertSameOrganization(agent.organizationId, run.organizationId, "security run");

  await prisma.$transaction((tx) =>
    transitionRunStatus(tx, {
      runId,
      to: "cancelled",
      actor: { type: agent.type === "internal" ? "system" : "agent", id: agent.agentIdentityId },
      eventType: "run.cancelled",
    }),
  );

  return { runId, status: "cancelled" };
}
