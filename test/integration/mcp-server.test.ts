import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase } from "../helpers/db.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { InMemoryJobQueue } from "../../src/orchestration/in-memory-job-queue.js";
import { createShldMcpServer } from "../../src/mcp/create-mcp-server.js";
import { generateApiKey } from "../../src/auth/api-keys.js";
import { authenticateAgentByApiKey } from "../../src/auth/authenticate-agent.js";

describe("SHLD MCP server", () => {
  let artifactDir: string;
  let client: Client;

  beforeEach(async () => {
    await resetDatabase();
    artifactDir = await mkdtemp(path.join(tmpdir(), "shld-artifacts-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  async function createTenantAndConnect() {
    const org = await testPrisma.organization.create({ data: { name: "Acme" } });
    const repo = await testPrisma.repository.create({
      data: { organizationId: org.id, owner: "acme", name: "widgets", defaultBranch: "main", status: "active" },
    });
    const agentIdentity = await testPrisma.agentIdentity.create({
      data: {
        organizationId: org.id,
        name: "claude-code",
        type: "mcp",
        permissions: {
          repositoryIds: "all",
          operations: ["change_review", "validate_finding", "submit_fix", "verify_fix"],
          targetEnvironmentIds: "all",
          maxRunBudgetUsd: 50,
          maxConcurrentRuns: 5,
        },
      },
    });
    const key = generateApiKey();
    await testPrisma.apiKeyCredential.create({
      data: { agentIdentityId: agentIdentity.id, keyPrefix: key.prefix, keyHash: key.hash },
    });
    const agent = await authenticateAgentByApiKey(testPrisma, key.raw);

    const queue = new InMemoryJobQueue();
    queue.registerHandler("prepare_repository", async () => {});
    const server = createShldMcpServer({
      prisma: testPrisma,
      jobQueue: queue,
      artifactStore: new ArtifactStore(artifactDir),
      agent,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    return { org, repo, agentIdentity };
  }

  it("lists exactly the seven required tools", async () => {
    await createTenantAndConnect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "security_get_finding",
        "security_get_receipt",
        "security_get_run",
        "security_review_change",
        "security_submit_fix",
        "security_validate_finding",
        "security_verify_fix",
      ].sort(),
    );
  });

  it("security_review_change creates a run through the same service the API uses", async () => {
    const { repo } = await createTenantAndConnect();
    const result = await client.callTool({
      name: "security_review_change",
      arguments: { repository_id: repo.id, base_sha: "a".repeat(40), head_sha: "b".repeat(40) },
    });
    expect(result.isError).toBeFalsy();
    const content = (result.content as Array<{ type: string; text: string }>)[0]!;
    const parsed = JSON.parse(content.text);
    expect(parsed.status).toBe("queued");

    const run = await testPrisma.securityRun.findUniqueOrThrow({ where: { id: parsed.run_id } });
    expect(run.repositoryId).toBe(repo.id);
  });

  it("security_submit_fix attaches a fix commit", async () => {
    const { org, repo } = await createTenantAndConnect();
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: org.id,
        repositoryId: repo.id,
        fingerprint: "fp-mcp-1",
        title: "Cross-tenant project access",
        description: "desc",
        category: "authorization",
        severity: "high",
        confidence: "high",
        status: "source_confirmed",
        firstSeenCommit: "a".repeat(40),
        lastSeenCommit: "a".repeat(40),
      },
    });

    const result = await client.callTool({
      name: "security_submit_fix",
      arguments: { finding_id: finding.id, fix_commit_sha: "c".repeat(40) },
    });
    const content = (result.content as Array<{ type: string; text: string }>)[0]!;
    expect(JSON.parse(content.text).status).toBe("fix_submitted");
  });

  it("returns a tool-level error (not a protocol failure) for a cross-tenant finding lookup", async () => {
    await createTenantAndConnect();
    const otherOrg = await testPrisma.organization.create({ data: { name: "Globex" } });
    const otherRepo = await testPrisma.repository.create({
      data: { organizationId: otherOrg.id, owner: "globex", name: "app", defaultBranch: "main", status: "active" },
    });
    const otherFinding = await testPrisma.finding.create({
      data: {
        organizationId: otherOrg.id,
        repositoryId: otherRepo.id,
        fingerprint: "fp-mcp-2",
        title: "t",
        description: "d",
        category: "authorization",
        severity: "high",
        confidence: "high",
        firstSeenCommit: "a".repeat(40),
        lastSeenCommit: "a".repeat(40),
      },
    });

    const result = await client.callTool({ name: "security_get_finding", arguments: { finding_id: otherFinding.id } });
    expect(result.isError).toBe(true);
    const content = (result.content as Array<{ type: string; text: string }>)[0]!;
    expect(content.text).toContain("Cross-tenant access denied");
  });

  it("security_get_run returns findings, routing decisions, and next action", async () => {
    const { org, repo, agentIdentity } = await createTenantAndConnect();
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: org.id,
        repositoryId: repo.id,
        requestedByAgentId: agentIdentity.id,
        runType: "change_review",
        status: "blocked",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });
    const result = await client.callTool({ name: "security_get_run", arguments: { run_id: run.id } });
    const content = (result.content as Array<{ type: string; text: string }>)[0]!;
    const parsed = JSON.parse(content.text);
    expect(parsed.status).toBe("blocked");
    expect(parsed.nextAction).toContain("fix");
  });
});
