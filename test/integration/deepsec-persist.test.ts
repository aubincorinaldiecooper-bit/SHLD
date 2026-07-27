import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { persistDeepSecRun } from "../../src/adapters/deepsec/persist.js";
import type { DeepSecRunResult } from "../../src/adapters/deepsec/deepsec-adapter.js";
import type { NormalizedFinding } from "../../src/adapters/deepsec/normalize.js";
import { computeFindingFingerprint } from "../../src/adapters/deepsec/normalize.js";

function makeFinding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  const base: NormalizedFinding = {
    title: "Cross-tenant project access",
    description: "A standard user may retrieve another tenant's project.",
    category: "authorization",
    severity: "high",
    confidence: "high",
    filePath: "src/api/projects/[id].ts",
    symbol: "getProject",
    fingerprint: "",
    ...overrides,
  };
  base.fingerprint = computeFindingFingerprint({
    repositoryId: "repo_1",
    category: base.category,
    filePath: base.filePath,
    symbol: base.symbol,
    title: base.title,
  });
  return base;
}

function makeRunResult(findings: NormalizedFinding[]): DeepSecRunResult {
  return {
    exitCode: 0,
    rawStdout: JSON.stringify({ findings }),
    rawStderr: "",
    durationMs: 500,
    findings,
    model: "deepsec-analyzer-v1",
    inputTokens: 1200,
    outputTokens: 400,
    estimatedCostUsd: 0.08,
    engineVersion: "1.2.3",
  };
}

describe("persistDeepSecRun", () => {
  let artifactDir: string;
  let artifactStore: ArtifactStore;

  beforeEach(async () => {
    await resetDatabase();
    artifactDir = await mkdtemp(path.join(tmpdir(), "shld-artifacts-"));
    artifactStore = new ArtifactStore(artifactDir);
  });

  afterEach(async () => {
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  async function createRun(fx: Awaited<ReturnType<typeof createFixtures>>) {
    return testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "change_review",
        status: "source_review_running",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });
  }

  it("creates an artifact, engine execution, and a new finding that auto-confirms on high confidence", async () => {
    const fx = await createFixtures();
    const run = await createRun(fx);
    const finding = makeFinding({ confidence: "high" });

    const outcome = await persistDeepSecRun(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      operation: "change_review",
      headSha: run.headSha,
      result: makeRunResult([finding]),
    });

    expect(outcome.findingIds).toHaveLength(1);

    const artifact = await testPrisma.artifact.findFirst({ where: { runId: run.id, type: "deepsec_raw_output" } });
    expect(artifact).not.toBeNull();
    const storedContent = await artifactStore.read(artifact!.storageLocation);
    expect(JSON.parse(storedContent.toString("utf8")).findings).toHaveLength(1);

    const engineExecution = await testPrisma.engineExecution.findFirst({ where: { runId: run.id } });
    expect(engineExecution).toMatchObject({
      engine: "deepsec",
      status: "completed",
      inputTokens: 1200,
      outputTokens: 400,
    });
    expect(engineExecution?.estimatedCostUsd?.toString()).toBe("0.08");

    const dbFinding = await testPrisma.finding.findUniqueOrThrow({ where: { id: outcome.findingIds[0]! } });
    expect(dbFinding.status).toBe("source_confirmed");
    expect(dbFinding.discoveryEngine).toBe("deepsec");

    const events = await testPrisma.auditEvent.findMany({
      where: { findingId: dbFinding.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.eventType)).toEqual(["finding.created", "finding.source_confirmed"]);
  });

  it("leaves a medium-confidence finding at suspected", async () => {
    const fx = await createFixtures();
    const run = await createRun(fx);
    const finding = makeFinding({ confidence: "medium", title: "Possible IDOR" });

    const outcome = await persistDeepSecRun(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      operation: "change_review",
      headSha: run.headSha,
      result: makeRunResult([finding]),
    });

    const dbFinding = await testPrisma.finding.findUniqueOrThrow({ where: { id: outcome.findingIds[0]! } });
    expect(dbFinding.status).toBe("suspected");
  });

  it("re-run with the same fingerprint updates lastSeenCommit without duplicating the finding", async () => {
    const fx = await createFixtures();
    const run1 = await createRun(fx);
    const finding = makeFinding({ confidence: "high" });

    const first = await persistDeepSecRun(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run1.id,
      operation: "change_review",
      headSha: run1.headSha,
      result: makeRunResult([finding]),
    });

    const run2 = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "change_review",
        status: "source_review_running",
        baseSha: "b".repeat(40),
        headSha: "c".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });

    const second = await persistDeepSecRun(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run2.id,
      operation: "change_review",
      headSha: run2.headSha,
      result: makeRunResult([finding]),
    });

    expect(second.findingIds[0]).toBe(first.findingIds[0]);

    const allFindings = await testPrisma.finding.findMany({ where: { repositoryId: fx.repositoryId } });
    expect(allFindings).toHaveLength(1);
    expect(allFindings[0]?.lastSeenCommit).toBe(run2.headSha);
    expect(allFindings[0]?.firstSeenCommit).toBe(run1.headSha);

    const locations = await testPrisma.findingSourceLocation.findMany({ where: { findingId: first.findingIds[0]! } });
    expect(locations).toHaveLength(2);

    // Only one finding.created event across both runs — the second run must
    // not re-fire creation-time audit events for an existing finding.
    const createdEvents = await testPrisma.auditEvent.findMany({
      where: { findingId: first.findingIds[0]!, eventType: "finding.created" },
    });
    expect(createdEvents).toHaveLength(1);
  });

  it("records two distinct findings from the same run", async () => {
    const fx = await createFixtures();
    const run = await createRun(fx);
    const findingA = makeFinding({ title: "Cross-tenant project access", confidence: "high" });
    const findingB = makeFinding({
      title: "SQL injection in search",
      category: "injection",
      filePath: "src/api/search.ts",
      symbol: "searchProjects",
      confidence: "high",
    });

    const outcome = await persistDeepSecRun(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      operation: "change_review",
      headSha: run.headSha,
      result: makeRunResult([findingA, findingB]),
    });

    expect(outcome.findingIds).toHaveLength(2);
    expect(new Set(outcome.findingIds).size).toBe(2);
  });
});
