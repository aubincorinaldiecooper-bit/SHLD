import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { persistStrixRun } from "../../src/adapters/strix/persist.js";
import type { StrixRunResult } from "../../src/adapters/strix/strix-adapter.js";
import type { StrixVerdict } from "../../src/adapters/strix/types.js";

function makeRunResult(status: StrixVerdict, overrides: Partial<StrixRunResult["validation"]> = {}): StrixRunResult {
  return {
    exitCode: 0,
    rawStdout: JSON.stringify({ verdict: status }),
    rawStderr: "",
    durationMs: 800,
    validation: {
      status,
      endpoint: "/api/projects/42",
      method: "GET",
      evidenceSummary: "evidence",
      reproductionSteps: ["step 1"],
      proofOfConcept: status === "confirmed" ? "curl ..." : undefined,
      ...overrides,
    },
    model: "strix-agent-v1",
    inputTokens: 500,
    outputTokens: 200,
    estimatedCostUsd: 0.05,
    engineVersion: "0.9.0",
  };
}

describe("persistStrixRun", () => {
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

  async function setup() {
    const fx = await createFixtures();
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "finding_validation",
        status: "validation_running",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        fingerprint: "fp-strix-1",
        title: "Cross-tenant project access",
        description: "desc",
        category: "authorization",
        severity: "high",
        confidence: "high",
        status: "validation_queued",
        firstSeenCommit: "a".repeat(40),
        lastSeenCommit: "a".repeat(40),
      },
    });
    const target = await testPrisma.targetEnvironment.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        name: "preview-184",
        baseUrl: "https://preview-184.example.com",
        environmentType: "preview",
        authorizationStatus: "authorized",
        allowedPaths: ["GET /api/projects/*"],
        excludedPaths: [],
        maximumRequests: 200,
        maximumConcurrency: 2,
      },
    });
    return { fx, run, finding, target };
  }

  it("confirmed verdict creates a Validation row and transitions the finding to confirmed", async () => {
    const { fx, run, finding, target } = await setup();

    const outcome = await persistStrixRun(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      targetBuildId: "build-184-a",
      result: makeRunResult("confirmed"),
    });

    expect(outcome.findingStatus).toBe("confirmed");

    const validation = await testPrisma.validation.findUniqueOrThrow({ where: { id: outcome.validationId } });
    expect(validation).toMatchObject({
      status: "confirmed",
      endpoint: "/api/projects/42",
      targetBuildId: "build-184-a",
    });
    expect(validation.proofArtifactId).not.toBeNull();

    const engineExecution = await testPrisma.engineExecution.findUniqueOrThrow({
      where: { id: outcome.engineExecutionId },
    });
    expect(engineExecution.engine).toBe("strix");

    const pocArtifact = await testPrisma.artifact.findUniqueOrThrow({ where: { id: validation.proofArtifactId! } });
    expect(pocArtifact.type).toBe("proof_of_concept");
    const pocContent = await artifactStore.read(pocArtifact.storageLocation);
    expect(pocContent.toString("utf8")).toBe("curl ...");

    const events = await testPrisma.auditEvent.findMany({
      where: { findingId: finding.id, eventType: "finding.confirmed" },
    });
    expect(events).toHaveLength(1);
  });

  it("not_reproduced verdict transitions the finding to not_reproduced", async () => {
    const { fx, run, finding, target } = await setup();
    const outcome = await persistStrixRun(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      result: makeRunResult("not_reproduced"),
    });
    expect(outcome.findingStatus).toBe("not_reproduced");
  });

  it("inconclusive verdict transitions the finding to inconclusive", async () => {
    const { fx, run, finding, target } = await setup();
    const outcome = await persistStrixRun(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      result: makeRunResult("inconclusive"),
    });
    expect(outcome.findingStatus).toBe("inconclusive");
  });

  it("failed verdict leaves the finding at validation_queued for retry", async () => {
    const { fx, run, finding, target } = await setup();
    const outcome = await persistStrixRun(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      result: makeRunResult("failed"),
    });
    expect(outcome.findingStatus).toBe("validation_queued");

    const validation = await testPrisma.validation.findUniqueOrThrow({ where: { id: outcome.validationId } });
    expect(validation.status).toBe("failed");
  });

  it("does not create a proof-of-concept artifact when none is returned", async () => {
    const { fx, run, finding, target } = await setup();
    const outcome = await persistStrixRun(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      result: makeRunResult("not_reproduced", { proofOfConcept: undefined }),
    });
    const validation = await testPrisma.validation.findUniqueOrThrow({ where: { id: outcome.validationId } });
    expect(validation.proofArtifactId).toBeNull();
  });
});
