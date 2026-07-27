import { z } from "zod";
import { AuthorizationError } from "../domain/errors.js";

export const agentPermissionsSchema = z.object({
  repositoryIds: z.union([z.literal("all"), z.array(z.string())]),
  operations: z.array(z.string()),
  targetEnvironmentIds: z.union([z.literal("all"), z.array(z.string())]),
  maxRunBudgetUsd: z.number().positive(),
  maxConcurrentRuns: z.number().int().positive(),
});

export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;

export function parseAgentPermissions(raw: unknown): AgentPermissions {
  return agentPermissionsSchema.parse(raw);
}

export function assertRepositoryAllowed(permissions: AgentPermissions, repositoryId: string): void {
  if (permissions.repositoryIds === "all") return;
  if (!permissions.repositoryIds.includes(repositoryId)) {
    throw new AuthorizationError(`Agent is not authorized for repository ${repositoryId}`);
  }
}

export function assertOperationAllowed(permissions: AgentPermissions, operation: string): void {
  if (!permissions.operations.includes(operation)) {
    throw new AuthorizationError(`Agent is not authorized to perform operation "${operation}"`);
  }
}

export function assertTargetEnvironmentAllowed(permissions: AgentPermissions, targetEnvironmentId: string): void {
  if (permissions.targetEnvironmentIds === "all") return;
  if (!permissions.targetEnvironmentIds.includes(targetEnvironmentId)) {
    throw new AuthorizationError(`Agent is not authorized for target environment ${targetEnvironmentId}`);
  }
}
