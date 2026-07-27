import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase } from "../helpers/db.js";
import { buildApp } from "../../src/api/app.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { InMemoryJobQueue } from "../../src/orchestration/in-memory-job-queue.js";
import { generateApiKey } from "../../src/auth/api-keys.js";

describe("security API routes", () => {
  let app: FastifyInstance;
  let artifactDir: string;

  beforeEach(async () => {
    await resetDatabase();
    artifactDir = await mkdtemp(path.join(tmpdir(), "shld-artifacts-"));
    const queue = new InMemoryJobQueue();
    queue.registerHandler("prepare_repository", async () => {});
    queue.registerHandler("run_strix_validation", async () => {});
    app = await buildApp({
      prisma: testPrisma,
      jobQueue: queue,
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

  async function createTenant(name: string) {
    const org = await testPrisma.organization.create({ data: { name } });
    const repo = await testPrisma.repository.create({
      data: { organizationId: org.id, owner: "acme", name: "widgets", defaultBranch: "main", status: "active" },
    });
    const agentIdentity = await testPrisma.agentIdentity.create({
      data: {
        organizationId: org.id,
        name: "claude-code",
        type: "api",
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
    return { org, repo, agentIdentity, apiKey: key.raw };
  }

  it("rejects requests with no Authorization header", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/security/reviews", payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it("rejects requests with an invalid API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/security/reviews",
      headers: { authorization: "Bearer shld_not_a_real_key_00000000000000000000" },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it("creates a security review and returns 201 with a queued run", async () => {
    const tenant = await createTenant("Acme");
    const response = await app.inject({
      method: "POST",
      url: "/v1/security/reviews",
      headers: { authorization: `Bearer ${tenant.apiKey}` },
      payload: {
        repository_id: tenant.repo.id,
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        pull_request_number: 184,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("queued");
    expect(body.run_id).toBeTruthy();

    const dbRun = await testPrisma.securityRun.findUniqueOrThrow({ where: { id: body.run_id } });
    expect(dbRun.pullRequestNumber).toBe(184);
  });

  it("rejects creating a review with a branch name instead of a resolved SHA", async () => {
    const tenant = await createTenant("Acme");
    const response = await app.inject({
      method: "POST",
      url: "/v1/security/reviews",
      headers: { authorization: `Bearer ${tenant.apiKey}` },
      payload: { repository_id: tenant.repo.id, base_sha: "main", head_sha: "b".repeat(40) },
    });
    expect(response.statusCode).toBe(500);
  });

  it("deduplicates a repeated request sharing the same domain idempotency inputs", async () => {
    const tenant = await createTenant("Acme");
    const payload = { repository_id: tenant.repo.id, base_sha: "a".repeat(40), head_sha: "b".repeat(40) };
    const first = await app.inject({
      method: "POST",
      url: "/v1/security/reviews",
      headers: { authorization: `Bearer ${tenant.apiKey}` },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/security/reviews",
      headers: { authorization: `Bearer ${tenant.apiKey}` },
      payload,
    });
    expect(first.json().run_id).toBe(second.json().run_id);

    const runs = await testPrisma.securityRun.findMany({ where: { repositoryId: tenant.repo.id } });
    expect(runs).toHaveLength(1);
  });

  it("honors the HTTP Idempotency-Key header for exact request replays", async () => {
    const tenant = await createTenant("Acme");
    const headers = { authorization: `Bearer ${tenant.apiKey}`, "idempotency-key": "client-key-1" };
    const payload = { repository_id: tenant.repo.id, base_sha: "a".repeat(40), head_sha: "b".repeat(40) };

    const first = await app.inject({ method: "POST", url: "/v1/security/reviews", headers, payload });
    const second = await app.inject({ method: "POST", url: "/v1/security/reviews", headers, payload });
    expect(first.json()).toEqual(second.json());

    const idempotencyRecords = await testPrisma.idempotencyRecord.findMany({
      where: { organizationId: tenant.org.id },
    });
    expect(idempotencyRecords).toHaveLength(1);
  });

  it("rejects a repository that belongs to a different organization", async () => {
    const tenantA = await createTenant("Acme");
    const tenantB = await createTenant("Globex");
    const response = await app.inject({
      method: "POST",
      url: "/v1/security/reviews",
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
      payload: { repository_id: tenantB.repo.id, base_sha: "a".repeat(40), head_sha: "b".repeat(40) },
    });
    expect(response.statusCode).toBe(403);
  });

  it("prevents cross-tenant access to a run via GET", async () => {
    const tenantA = await createTenant("Acme");
    const tenantB = await createTenant("Globex");

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/security/reviews",
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
      payload: { repository_id: tenantA.repo.id, base_sha: "a".repeat(40), head_sha: "b".repeat(40) },
    });
    const runId = createResponse.json().run_id;

    const crossTenantResponse = await app.inject({
      method: "GET",
      url: `/v1/security/runs/${runId}`,
      headers: { authorization: `Bearer ${tenantB.apiKey}` },
    });
    expect(crossTenantResponse.statusCode).toBe(403);

    const ownTenantResponse = await app.inject({
      method: "GET",
      url: `/v1/security/runs/${runId}`,
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
    });
    expect(ownTenantResponse.statusCode).toBe(200);
    expect(ownTenantResponse.json().runId).toBe(runId);
  });

  it("returns 404 for a nonexistent run", async () => {
    const tenant = await createTenant("Acme");
    const response = await app.inject({
      method: "GET",
      url: "/v1/security/runs/run_does_not_exist",
      headers: { authorization: `Bearer ${tenant.apiKey}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("generates a receipt on demand and returns markdown when requested", async () => {
    const tenant = await createTenant("Acme");
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: tenant.org.id,
        repositoryId: tenant.repo.id,
        requestedByAgentId: tenant.agentIdentity.id,
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
      url: `/v1/security/runs/${run.id}/receipt?format=markdown`,
      headers: { authorization: `Bearer ${tenant.apiKey}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    expect(response.body).toContain("Security Verification Receipt");
  });

  it("submits a fix for a finding", async () => {
    const tenant = await createTenant("Acme");
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: tenant.org.id,
        repositoryId: tenant.repo.id,
        fingerprint: "fp-api-1",
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

    const response = await app.inject({
      method: "POST",
      url: `/v1/security/findings/${finding.id}/fix`,
      headers: { authorization: `Bearer ${tenant.apiKey}` },
      payload: { fix_commit_sha: "c".repeat(40) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("fix_submitted");
  });

  it("rejects fetching a finding belonging to another organization", async () => {
    const tenantA = await createTenant("Acme");
    const tenantB = await createTenant("Globex");
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: tenantB.org.id,
        repositoryId: tenantB.repo.id,
        fingerprint: "fp-api-2",
        title: "t",
        description: "d",
        category: "authorization",
        severity: "high",
        confidence: "high",
        firstSeenCommit: "a".repeat(40),
        lastSeenCommit: "a".repeat(40),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/security/findings/${finding.id}`,
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("healthz responds without authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
  });
});
