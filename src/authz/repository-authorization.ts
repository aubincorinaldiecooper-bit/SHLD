import type { PrismaClient, Repository } from "@prisma/client";
import { AuthorizationError, NotFoundError } from "../domain/errors.js";
import { assertRepositoryAllowed, type AgentPermissions } from "../auth/permissions.js";
import { assertSameOrganization } from "../auth/tenant-isolation.js";

export interface AuthorizeRepositoryParams {
  organizationId: string;
  repositoryId: string;
  permissions: AgentPermissions;
}

/** Confirms a repository exists, belongs to the caller's org, is active, and the agent is scoped to it. */
export async function authorizeRepositoryForRun(
  prisma: PrismaClient,
  params: AuthorizeRepositoryParams,
): Promise<Repository> {
  const repository = await prisma.repository.findUnique({ where: { id: params.repositoryId } });
  if (!repository) {
    throw new NotFoundError(`Repository ${params.repositoryId} not found`);
  }
  assertSameOrganization(params.organizationId, repository.organizationId, "repository");
  if (repository.status !== "active") {
    throw new AuthorizationError(
      `Repository ${repository.owner}/${repository.name} is not active (status: ${repository.status})`,
    );
  }
  assertRepositoryAllowed(params.permissions, repository.id);
  return repository;
}
