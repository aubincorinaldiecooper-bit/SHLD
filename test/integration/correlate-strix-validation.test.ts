import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { correlateStrixValidation } from "../../src/correlation/correlate-strix-validation.js";
import type { StrixRunResult } from "../../src/adapters/strix/strix-adapter.js";
import type { StrixVerdict } from "../../src/adapters/strix/types.js";

const HEAD_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);

function makeRunResult(
  status: StrixVerdict,
  overrides: Partial<StrixRunResult["validation"]> = {},
): StrixRunResult {
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
      reproductionSteps: [],
      codeLocations: [],
      ...overrides,
    },
    model: "strix-agent-v1",
    inputTokens: 500,
    outputTokens: 200,
    estimatedCostUsd: 0.05,
    engineVersion: "0.9.0",
  };
}

describe("correlateStrixValidation", () => {
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
        headSha: HEAD_SHA,
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        fingerprint: "fp-correlate-1",
        title: "Cross-tenant project access",
        description: "desc",
        category: "authorization",
        severity: "high",
        confidence: "high",
        status: "validation_queued",
        firstSeenCommit: HEAD_SHA,
        lastSeenCommit: HEAD_SHA,
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
        allowedPaths: [],
        excludedPaths: [],
        maximumRequests: 200,
        maximumConcurrency: 2,
      },
    });
    return { fx, run, finding, target };
  }

  it("confirmed verdict with matching build and complete test confirms the finding", async () => {
    const { fx, run, finding, target } = await setup();
    const outcome = await correlateStrixValidation(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      expectedCommitSha: HEAD_SHA,
      actualTargetBuildId: HEAD_SHA,
      testComplete: true,
      result: makeRunResult("confirmed"),
    });
    expect(outcome.findingStatus).toBe("confirmed");
    expect(outcome.buildMismatch).toBe(false);
    expect(outcome.isNewFinding).toBe(false);
  });

  it("build mismatch collapses a not_reproduced verdict to inconclusive and records the mismatch", async () => {
    const { fx, run, finding, target } = await setup();
    const outcome = await correlateStrixValidation(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      expectedCommitSha: HEAD_SHA,
      actualTargetBuildId: OTHER_SHA,
      testComplete: true,
      result: makeRunResult("not_reproduced"),
    });
    expect(outcome.findingStatus).toBe("inconclusive");
    expect(outcome.buildMismatch).toBe(true);

    const validation = await testPrisma.validation.findUniqueOrThrow({ where: { id: outcome.validationId } });
    expect(validation.evidenceSummary).toContain("BUILD MISMATCH");
  });

  it("an incomplete test collapses confirmed to inconclusive", async () => {
    const { fx, run, finding, target } = await setup();
    const outcome = await correlateStrixValidation(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      expectedCommitSha: HEAD_SHA,
      actualTargetBuildId: HEAD_SHA,
      testComplete: false,
      result: makeRunResult("confirmed"),
    });
    expect(outcome.findingStatus).toBe("inconclusive");
  });

  it("a failed execution leaves the finding at validation_queued", async () => {
    const { fx, run, finding, target } = await setup();
    const outcome = await correlateStrixValidation(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      findingId: finding.id,
      targetEnvironmentId: target.id,
      expectedCommitSha: HEAD_SHA,
      actualTargetBuildId: HEAD_SHA,
      testComplete: true,
      result: makeRunResult("failed"),
    });
    expect(outcome.findingStatus).toBe("validation_queued");
  });

  it("a confirmed new_discovery with no findingId creates a new dynamic finding, confirmed", async () => {
    const { fx, run, target } = await setup();
    const outcome = await correlateStrixValidation(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      targetEnvironmentId: target.id,
      expectedCommitSha: HEAD_SHA,
      actualTargetBuildId: HEAD_SHA,
      testComplete: true,
      result: makeRunResult("confirmed", {
        codeLocations: [{ file_path: "src/api/billing.ts", symbol: "applyDiscount" }],
        newDiscovery: {
          title: "Payment amount manipulation via client-supplied discount",
          category: "payment-manipulation",
          severity: "critical",
          confidence: "high",
        },
      }),
    });

    expect(outcome.isNewFinding).toBe(true);
    expect(outcome.findingStatus).toBe("confirmed");

    const finding = await testPrisma.finding.findUniqueOrThrow({ where: { id: outcome.findingId } });
    expect(finding.discoveryEngine).toBe("strix");
    expect(finding.findingClass).toBe("dynamic");
    expect(finding.severity).toBe("critical");

    const events = await testPrisma.auditEvent.findMany({
      where: { findingId: finding.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      "finding.created",
      "finding.source_confirmed",
      "finding.validation_queued",
      "finding.confirmed",
    ]);

    const locations = await testPrisma.findingSourceLocation.findMany({ where: { findingId: finding.id } });
    expect(locations).toHaveLength(1);
    expect(locations[0]?.filePath).toBe("src/api/billing.ts");
  });

  it("a repeat dynamic discovery of the same issue extends the existing finding instead of duplicating", async () => {
    const { fx, run, target } = await setup();
    const discoveryResult = makeRunResult("confirmed", {
      codeLocations: [{ file_path: "src/api/billing.ts", symbol: "applyDiscount" }],
      newDiscovery: {
        title: "Payment amount manipulation via client-supplied discount",
        category: "payment-manipulation",
        severity: "critical",
        confidence: "high",
      },
    });

    const first = await correlateStrixValidation(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run.id,
      targetEnvironmentId: target.id,
      expectedCommitSha: HEAD_SHA,
      actualTargetBuildId: HEAD_SHA,
      testComplete: true,
      result: discoveryResult,
    });

    const run2 = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "finding_validation",
        status: "validation_running",
        baseSha: HEAD_SHA,
        headSha: OTHER_SHA,
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });

    const second = await correlateStrixValidation(testPrisma, artifactStore, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      runId: run2.id,
      targetEnvironmentId: target.id,
      expectedCommitSha: OTHER_SHA,
      actualTargetBuildId: OTHER_SHA,
      testComplete: true,
      result: discoveryResult,
    });

    expect(second.findingId).toBe(first.findingId);
    expect(second.isNewFinding).toBe(false);

    // setup() also creates one unrelated source-originated finding — only
    // one *dynamic* finding should exist across both correlation calls.
    const dynamicFindings = await testPrisma.finding.findMany({
      where: { repositoryId: fx.repositoryId, findingClass: "dynamic" },
    });
    expect(dynamicFindings).toHaveLength(1);
  });

  it("throws when called without a findingId and without a confirmed new_discovery", async () => {
    const { fx, run, target } = await setup();
    await expect(
      correlateStrixValidation(testPrisma, artifactStore, {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        runId: run.id,
        targetEnvironmentId: target.id,
        expectedCommitSha: HEAD_SHA,
        actualTargetBuildId: HEAD_SHA,
        testComplete: true,
        result: makeRunResult("not_reproduced"),
      }),
    ).rejects.toThrow();
  });
});
