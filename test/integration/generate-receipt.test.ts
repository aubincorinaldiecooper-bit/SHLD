import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { generateReceipt } from "../../src/receipts/generate-receipt.js";
import { recordAuditEvent } from "../../src/audit/audit-log.js";
import { transitionRunStatus } from "../../src/domain/run-transitions.js";

describe("generateReceipt", () => {
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

  it("generates a passed_with_findings receipt for a verified-fixed runtime-confirmed finding", async () => {
    const fx = await createFixtures();
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "fix_verification",
        status: "source_review_completed",
        pullRequestNumber: 184,
        baseSha: "abc123".padEnd(40, "0"),
        headSha: "def456".padEnd(40, "0"),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });

    await testPrisma.runClassification.create({
      data: {
        runId: run.id,
        riskLevel: "high",
        securitySensitive: true,
        categories: ["authorization"],
        recommendedReview: "deepsec_diff",
        requiresPreviewTarget: true,
        reasons: ["touches src/api/projects"],
        changedFiles: ["src/api/projects/[id].ts"],
      },
    });

    const deepsecExecution = await testPrisma.engineExecution.create({
      data: {
        runId: run.id,
        engine: "deepsec",
        operation: "change_review",
        status: "completed",
        engineVersion: "1.2.3",
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 0.12,
      },
    });
    await testPrisma.engineExecution.create({
      data: {
        runId: run.id,
        engine: "strix",
        operation: "run_strix_validation",
        status: "completed",
        engineVersion: "0.9.0",
        inputTokens: 2000,
        outputTokens: 800,
        estimatedCostUsd: 0.25,
      },
    });

    const finding = await testPrisma.finding.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        fingerprint: "fp-receipt-1",
        title: "Cross-tenant project access",
        description: "desc",
        category: "authorization",
        severity: "high",
        confidence: "high",
        status: "verified_fixed",
        firstSeenCommit: run.baseSha,
        lastSeenCommit: run.headSha,
      },
    });
    await testPrisma.validation.create({
      data: {
        findingId: finding.id,
        engineExecutionId: deepsecExecution.id,
        status: "confirmed",
        endpoint: "/api/projects/42",
        method: "GET",
        evidenceSummary: "Tenant B's project returned to Tenant A.",
        targetBuildId: "preview-184-a",
      },
    });
    await testPrisma.remediation.create({
      data: {
        findingId: finding.id,
        fixCommitSha: "ghi789".padEnd(40, "0"),
        sourceRevalidationStatus: "passed",
        runtimeRetestStatus: "passed",
        regressionTestStatus: "not_applicable",
        finalStatus: "verified_fixed",
      },
    });

    await testPrisma.$transaction(async (tx) => {
      await recordAuditEvent(tx, {
        organizationId: fx.organizationId,
        runId: run.id,
        findingId: finding.id,
        actor: { type: "system" },
        eventType: "finding.verified_fixed",
        previousState: "retesting",
        newState: "verified_fixed",
      });
      await transitionRunStatus(tx, {
        runId: run.id,
        to: "validation_running",
        actor: { type: "system" },
        eventType: "run.validation_running",
      });
      await transitionRunStatus(tx, {
        runId: run.id,
        to: "completed",
        actor: { type: "system" },
        eventType: "run.completed",
      });
    });

    const outcome = await generateReceipt(testPrisma, artifactStore, run.id);

    expect(outcome.status).toBe("passed_with_findings");
    expect(outcome.json.repository).toBe("acme/widgets");
    expect(outcome.json.pull_request).toBe(184);
    expect(outcome.json.head_commit).toBe(run.headSha);
    expect(outcome.json.findings).toHaveLength(1);
    expect(outcome.json.findings[0]?.final_status).toBe("verified_fixed");
    expect(outcome.json.usage.total_cost_usd).toBeCloseTo(0.37);
    expect(outcome.json.usage.total_input_tokens).toBe(3000);
    expect(outcome.json.engines_used).toHaveLength(2);

    expect(outcome.markdown).toContain("Security Verification Receipt");
    expect(outcome.markdown).toContain("Status: Passed (with findings)");
    expect(outcome.markdown).toContain("Cross-tenant project access");
    expect(outcome.markdown).toContain("Final decision:\nVerified fixed");

    const receiptRow = await testPrisma.receipt.findUniqueOrThrow({ where: { runId: run.id } });
    expect(receiptRow.status).toBe("passed_with_findings");

    const jsonArtifact = await testPrisma.artifact.findUniqueOrThrow({ where: { id: outcome.jsonArtifactId } });
    expect(jsonArtifact.type).toBe("receipt_json");
    const storedJson = JSON.parse((await artifactStore.read(jsonArtifact.storageLocation)).toString("utf8"));
    expect(storedJson.status).toBe("passed_with_findings");

    const markdownArtifact = await testPrisma.artifact.findUniqueOrThrow({
      where: { id: outcome.markdownArtifactId },
    });
    expect(markdownArtifact.type).toBe("receipt_markdown");
  });

  it("regenerating a receipt updates the existing row rather than creating a duplicate", async () => {
    const fx = await createFixtures();
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "change_review",
        status: "completed",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });

    const first = await generateReceipt(testPrisma, artifactStore, run.id);
    const second = await generateReceipt(testPrisma, artifactStore, run.id);

    expect(second.receiptId).toBe(first.receiptId);
    const receipts = await testPrisma.receipt.findMany({ where: { runId: run.id } });
    expect(receipts).toHaveLength(1);
  });

  it("produces a passed status with no findings for a clean run", async () => {
    const fx = await createFixtures();
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "change_review",
        status: "completed",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });
    const outcome = await generateReceipt(testPrisma, artifactStore, run.id);
    expect(outcome.status).toBe("passed");
    expect(outcome.json.findings).toHaveLength(0);
  });

  it("produces a blocked status for a blocked run", async () => {
    const fx = await createFixtures();
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "change_review",
        status: "source_review_completed",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });
    await testPrisma.$transaction(async (tx) => {
      await transitionRunStatus(tx, { runId: run.id, to: "blocked", actor: { type: "system" }, eventType: "run.blocked" });
    });
    const outcome = await generateReceipt(testPrisma, artifactStore, run.id);
    expect(outcome.status).toBe("blocked");
  });
});
