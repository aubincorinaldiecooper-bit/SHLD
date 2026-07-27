import { PrismaClient } from "@prisma/client";

export const testPrisma = new PrismaClient();

/** Truncates every tenant-scoped table. Fast, FK-safe, used between tests. */
export async function resetDatabase(): Promise<void> {
  const tables = [
    "audit_events",
    "webhook_deliveries",
    "webhook_endpoints",
    "idempotency_records",
    "receipts",
    "routing_decisions",
    "remediations",
    "validations",
    "finding_source_locations",
    "findings",
    "run_classifications",
    "engine_executions",
    "security_runs",
    "target_environments",
    "repository_policy_configs",
    "repositories",
    "api_key_credentials",
    "agent_identities",
    "sessions",
    "users",
    "artifacts",
    "inbound_github_events",
    "organizations",
  ];
  await testPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`);
}

export interface Fixtures {
  organizationId: string;
  repositoryId: string;
  agentIdentityId: string;
}

/** Creates a minimal org + repo + agent identity for tests that need real FKs. */
export async function createFixtures(): Promise<Fixtures> {
  const org = await testPrisma.organization.create({ data: { name: "Acme Inc" } });
  const repo = await testPrisma.repository.create({
    data: {
      organizationId: org.id,
      owner: "acme",
      name: "widgets",
      defaultBranch: "main",
      status: "active",
    },
  });
  const agent = await testPrisma.agentIdentity.create({
    data: {
      organizationId: org.id,
      name: "claude-code",
      type: "api",
      permissions: {
        repositoryIds: "all",
        operations: ["change_review", "validate_finding", "submit_fix", "verify_fix"],
        targetEnvironmentIds: "all",
        allowProductionTargets: false,
        maxRunBudgetUsd: 50,
        maxConcurrentRuns: 5,
      },
    },
  });
  return { organizationId: org.id, repositoryId: repo.id, agentIdentityId: agent.id };
}
