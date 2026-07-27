import type { AgentType, PrismaClient } from "@prisma/client";
import { hashApiKey, isWellFormedApiKey } from "./api-keys.js";
import { parseAgentPermissions, type AgentPermissions } from "./permissions.js";
import { AuthorizationError } from "../domain/errors.js";

export interface AuthenticatedAgent {
  agentIdentityId: string;
  organizationId: string;
  type: AgentType;
  permissions: AgentPermissions;
}

/**
 * Resolves an Authorization: Bearer <key> header to the agent identity it
 * belongs to. Used by both the HTTP API and the MCP server so the two
 * surfaces share one authentication path.
 */
export async function authenticateAgentByApiKey(
  prisma: PrismaClient,
  rawKey: string,
): Promise<AuthenticatedAgent> {
  if (!isWellFormedApiKey(rawKey)) {
    throw new AuthorizationError("Malformed API key");
  }

  const credential = await prisma.apiKeyCredential.findUnique({
    where: { keyHash: hashApiKey(rawKey) },
    include: { agentIdentity: true },
  });

  if (!credential || credential.revokedAt) {
    throw new AuthorizationError("Invalid or revoked API key");
  }

  await prisma.agentIdentity.update({
    where: { id: credential.agentIdentity.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    agentIdentityId: credential.agentIdentity.id,
    organizationId: credential.agentIdentity.organizationId,
    type: credential.agentIdentity.type,
    permissions: parseAgentPermissions(credential.agentIdentity.permissions),
  };
}

/**
 * Resolves the single `github` AgentIdentity for an organization, used to
 * attribute webhook-triggered runs. Created lazily the first time a
 * repository is connected — never agent-writable.
 */
export async function getOrCreateGithubAgentIdentity(
  prisma: PrismaClient,
  organizationId: string,
): Promise<AuthenticatedAgent> {
  let identity = await prisma.agentIdentity.findFirst({
    where: { organizationId, type: "github" },
  });

  if (!identity) {
    identity = await prisma.agentIdentity.create({
      data: {
        organizationId,
        name: "GitHub App",
        type: "github",
        permissions: {
          repositoryIds: "all",
          operations: ["change_review", "fix_verification"],
          targetEnvironmentIds: "all",
          maxRunBudgetUsd: 100,
          maxConcurrentRuns: 10,
        },
      },
    });
  }

  return {
    agentIdentityId: identity.id,
    organizationId: identity.organizationId,
    type: identity.type,
    permissions: parseAgentPermissions(identity.permissions),
  };
}
