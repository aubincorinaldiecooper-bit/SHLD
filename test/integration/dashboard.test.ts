import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase } from "../helpers/db.js";
import { buildApp } from "../../src/api/app.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { InMemoryJobQueue } from "../../src/orchestration/in-memory-job-queue.js";
import { createSession } from "../../src/auth/sessions.js";

describe("dashboard", () => {
  let app: FastifyInstance;
  let artifactDir: string;

  beforeEach(async () => {
    await resetDatabase();
    artifactDir = await mkdtemp(path.join(tmpdir(), "shld-artifacts-"));
    app = await buildApp({
      prisma: testPrisma,
      jobQueue: new InMemoryJobQueue(),
      artifactStore: new ArtifactStore(artifactDir),
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  async function createLoggedInUser(orgName: string) {
    const org = await testPrisma.organization.create({ data: { name: orgName } });
    const user = await testPrisma.user.create({
      data: { organizationId: org.id, email: `founder@${orgName.toLowerCase()}.test`, role: "owner" },
    });
    const session = await createSession(testPrisma, user.id);
    return { org, user, cookie: `shld_session=${session.token}` };
  }

  it("rejects dashboard access with no session cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/dashboard/runs" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an invalid session cookie", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/dashboard/runs",
      headers: { cookie: "shld_session=not-a-real-token" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("renders the runs list for the logged-in user's organization", async () => {
    const { org, cookie } = await createLoggedInUser("Acme");
    const repo = await testPrisma.repository.create({
      data: { organizationId: org.id, owner: "acme", name: "widgets", defaultBranch: "main", status: "active" },
    });
    const agent = await testPrisma.agentIdentity.create({
      data: {
        organizationId: org.id,
        name: "claude-code",
        type: "api",
        permissions: { repositoryIds: "all", operations: [], targetEnvironmentIds: "all", maxRunBudgetUsd: 10, maxConcurrentRuns: 1 },
      },
    });
    await testPrisma.securityRun.create({
      data: {
        organizationId: org.id,
        repositoryId: repo.id,
        requestedByAgentId: agent.id,
        runType: "change_review",
        status: "blocked",
        pullRequestNumber: 184,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });

    const response = await app.inject({ method: "GET", url: "/dashboard/runs", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("acme/widgets");
    expect(response.body).toContain("#184");
    expect(response.body).toContain("blocked");
  });

  it("renders run detail with findings", async () => {
    const { org, cookie } = await createLoggedInUser("Acme");
    const repo = await testPrisma.repository.create({
      data: { organizationId: org.id, owner: "acme", name: "widgets", defaultBranch: "main", status: "active" },
    });
    const agent = await testPrisma.agentIdentity.create({
      data: {
        organizationId: org.id,
        name: "claude-code",
        type: "api",
        permissions: { repositoryIds: "all", operations: [], targetEnvironmentIds: "all", maxRunBudgetUsd: 10, maxConcurrentRuns: 1 },
      },
    });
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: org.id,
        repositoryId: repo.id,
        requestedByAgentId: agent.id,
        runType: "change_review",
        status: "completed",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });

    const response = await app.inject({ method: "GET", url: `/dashboard/runs/${run.id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(run.id);
  });

  it("renders finding detail", async () => {
    const { org, cookie } = await createLoggedInUser("Acme");
    const repo = await testPrisma.repository.create({
      data: { organizationId: org.id, owner: "acme", name: "widgets", defaultBranch: "main", status: "active" },
    });
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: org.id,
        repositoryId: repo.id,
        fingerprint: "fp-dash-1",
        title: "Cross-tenant project access",
        description: "A standard user may retrieve another tenant's project.",
        category: "authorization",
        severity: "high",
        confidence: "high",
        status: "confirmed",
        firstSeenCommit: "a".repeat(40),
        lastSeenCommit: "a".repeat(40),
      },
    });

    const response = await app.inject({ method: "GET", url: `/dashboard/findings/${finding.id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Cross-tenant project access");
    expect(response.body).toContain("confirmed");
  });

  it("renders settings with repositories, targets, agents, and webhooks", async () => {
    const { org, cookie } = await createLoggedInUser("Acme");
    await testPrisma.repository.create({
      data: { organizationId: org.id, owner: "acme", name: "widgets", defaultBranch: "main", status: "active" },
    });
    await testPrisma.webhookEndpoint.create({
      data: { organizationId: org.id, url: "https://example.com/hook", secret: "s", eventTypes: ["security.run.completed"] },
    });

    const response = await app.inject({ method: "GET", url: "/dashboard/settings", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("acme/widgets");
    expect(response.body).toContain("https://example.com/hook");
  });

  it("prevents cross-tenant access to a run detail page", async () => {
    const tenantA = await createLoggedInUser("Acme");
    const tenantB = await createLoggedInUser("Globex");
    const repoB = await testPrisma.repository.create({
      data: { organizationId: tenantB.org.id, owner: "globex", name: "app", defaultBranch: "main", status: "active" },
    });
    const agentB = await testPrisma.agentIdentity.create({
      data: {
        organizationId: tenantB.org.id,
        name: "claude-code",
        type: "api",
        permissions: { repositoryIds: "all", operations: [], targetEnvironmentIds: "all", maxRunBudgetUsd: 10, maxConcurrentRuns: 1 },
      },
    });
    const runB = await testPrisma.securityRun.create({
      data: {
        organizationId: tenantB.org.id,
        repositoryId: repoB.id,
        requestedByAgentId: agentB.id,
        runType: "change_review",
        status: "completed",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/dashboard/runs/${runB.id}`,
      headers: { cookie: tenantA.cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});
