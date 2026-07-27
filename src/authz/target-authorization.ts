import type { PrismaClient, TargetEnvironment } from "@prisma/client";
import { AuthorizationError, NotFoundError, TargetAuthorizationError } from "../domain/errors.js";
import { assertTargetEnvironmentAllowed, type AgentPermissions } from "../auth/permissions.js";
import { assertSameOrganization } from "../auth/tenant-isolation.js";

export interface AuthorizeTargetEnvironmentParams {
  organizationId: string;
  repositoryId: string;
  targetEnvironmentId: string;
  permissions: AgentPermissions;
}

/**
 * Confirms a target environment exists, belongs to the caller's org and the
 * run's repository, is currently authorized and unexpired, and that the
 * agent's permissions cover it. This is the only path by which a
 * TargetEnvironment record is resolved for dynamic testing — callers never
 * accept a raw URL from an agent and treat it as a target.
 */
export async function authorizeTargetEnvironment(
  prisma: PrismaClient,
  params: AuthorizeTargetEnvironmentParams,
): Promise<TargetEnvironment> {
  const target = await prisma.targetEnvironment.findUnique({ where: { id: params.targetEnvironmentId } });
  if (!target) {
    throw new NotFoundError(`Target environment ${params.targetEnvironmentId} not found`);
  }
  assertSameOrganization(params.organizationId, target.organizationId, "target environment");
  if (target.repositoryId !== params.repositoryId) {
    throw new AuthorizationError(
      `Target environment ${target.id} does not belong to repository ${params.repositoryId}`,
    );
  }
  assertTargetEnvironmentAllowed(params.permissions, target.id);

  if (target.authorizationStatus !== "authorized") {
    throw new TargetAuthorizationError(
      `Target environment "${target.name}" is not authorized (status: ${target.authorizationStatus})`,
    );
  }
  if (target.authorizationExpiresAt && target.authorizationExpiresAt.getTime() < Date.now()) {
    throw new TargetAuthorizationError(
      `Authorization for target environment "${target.name}" expired at ${target.authorizationExpiresAt.toISOString()}`,
    );
  }

  return target;
}

export function assertDestructiveTestingAllowed(
  target: TargetEnvironment,
  missionRequiresDestructive: boolean,
): void {
  if (missionRequiresDestructive && !target.destructiveTestingAllowed) {
    throw new TargetAuthorizationError(`Destructive testing is not permitted on target environment "${target.name}"`);
  }
}
