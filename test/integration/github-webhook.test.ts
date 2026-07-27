import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase } from "../helpers/db.js";
import { buildApp } from "../../src/api/app.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { InMemoryJobQueue } from "../../src/orchestration/in-memory-job-queue.js";

const WEBHOOK_SECRET = "test-webhook-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

describe("GitHub webhook route", () => {
  let app: FastifyInstance;
  let artifactDir: string;

  beforeEach(async () => {
    await resetDatabase();
    artifactDir = await mkdtemp(path.join(tmpdir(), "shld-artifacts-"));
    const queue = new InMemoryJobQueue();
    queue.registerHandler("prepare_repository", async () => {});
    app = await buildApp({
      prisma: testPrisma,
      jobQueue: queue,
      artifactStore: new ArtifactStore(artifactDir),
      githubWebhookSecret: WEBHOOK_SECRET,
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  function pullRequestPayload(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      action: "opened",
      pull_request: { number: 184, head: { sha: "b".repeat(40) }, base: { sha: "a".repeat(40) } },
      repository: { name: "widgets", owner: { login: "acme" } },
      ...overrides,
    });
  }

  it("rejects a request with an invalid signature", async () => {
    const body = pullRequestPayload();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
  });

  it("creates a security review for a correctly signed pull_request.opened event", async () => {
    const org = await testPrisma.organization.create({ data: { name: "Acme" } });
    await testPrisma.repository.create({
      data: { organizationId: org.id, owner: "acme", name: "widgets", defaultBranch: "main", status: "active" },
    });

    const body = pullRequestPayload();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
        "x-github-delivery": "delivery-2",
        "x-github-event": "pull_request",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().outcome).toBe("created");

    const runs = await testPrisma.securityRun.findMany({ where: { organizationId: org.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.pullRequestNumber).toBe(184);

    const githubAgent = await testPrisma.agentIdentity.findFirst({ where: { organizationId: org.id, type: "github" } });
    expect(runs[0]?.requestedByAgentId).toBe(githubAgent?.id);
  });

  it("deduplicates a repeated delivery id", async () => {
    const org = await testPrisma.organization.create({ data: { name: "Acme" } });
    await testPrisma.repository.create({
      data: { organizationId: org.id, owner: "acme", name: "widgets", defaultBranch: "main", status: "active" },
    });

    const body = pullRequestPayload();
    const headers = {
      "content-type": "application/json",
      "x-hub-signature-256": sign(body),
      "x-github-delivery": "delivery-3",
      "x-github-event": "pull_request",
    };
    await app.inject({ method: "POST", url: "/webhooks/github", headers, payload: body });
    const second = await app.inject({ method: "POST", url: "/webhooks/github", headers, payload: body });

    expect(second.json()).toEqual({ outcome: "skipped", reason: "duplicate delivery" });
    const runs = await testPrisma.securityRun.findMany({ where: { organizationId: org.id } });
    expect(runs).toHaveLength(1);
  });

  it("skips an untracked pull_request action without creating a run", async () => {
    const org = await testPrisma.organization.create({ data: { name: "Acme" } });
    await testPrisma.repository.create({
      data: { organizationId: org.id, owner: "acme", name: "widgets", defaultBranch: "main", status: "active" },
    });
    const body = pullRequestPayload({ action: "closed" });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
        "x-github-delivery": "delivery-4",
        "x-github-event": "pull_request",
      },
      payload: body,
    });
    expect(response.json()).toEqual({ outcome: "skipped", reason: 'action "closed" is not tracked' });
  });

  it("skips an event for a repository SHLD does not know about", async () => {
    const body = pullRequestPayload();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
        "x-github-delivery": "delivery-5",
        "x-github-event": "pull_request",
      },
      payload: body,
    });
    expect(response.json()).toEqual({ outcome: "skipped", reason: "repository is not connected to SHLD" });
  });

  it("ignores non-pull_request events without erroring", async () => {
    const body = JSON.stringify({ zen: "hello" });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
        "x-github-delivery": "delivery-6",
        "x-github-event": "ping",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().outcome).toBe("skipped");
  });
});
