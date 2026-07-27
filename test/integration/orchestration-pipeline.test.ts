import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { createVulnerableFixture, type VulnerableFixture } from "../helpers/vulnerable-fixture.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { InMemoryJobQueue } from "../../src/orchestration/in-memory-job-queue.js";
import { registerJobHandlers } from "../../src/orchestration/handlers/register.js";
import type { HandlerDeps } from "../../src/orchestration/handlers/deps.js";
import { DeepSecAdapter } from "../../src/adapters/deepsec/deepsec-adapter.js";
import { MockDeepSecExecutionStrategy } from "../../src/adapters/deepsec/execution-strategy.js";
import type { DeepSecExecutionRequest, DeepSecRunOutput } from "../../src/adapters/deepsec/types.js";
import { StrixAdapter } from "../../src/adapters/strix/strix-adapter.js";
import { MockStrixExecutionStrategy } from "../../src/adapters/strix/execution-strategy.js";
import type { StrixExecutionRequest, StrixRawResult } from "../../src/adapters/strix/types.js";
import { computeRunIdempotencyKey } from "../../src/orchestration/run-idempotency-key.js";
import { submitFix } from "../../src/remediation/submit-fix.js";
import { startFixVerification } from "../../src/remediation/start-fix-verification.js";

/**
 * The critical end-to-end lifecycle, run through the real job queue and
 * real orchestration handlers (only the DeepSec/Strix CLI calls are
 * mocked, matching how the whole platform is designed to be tested without
 * live engine credentials):
 *
 *   Vulnerable commit submitted
 *   -> DeepSec creates a finding
 *   -> Policy routes it to Strix
 *   -> Strix confirms the exploit
 *   -> Review becomes blocked
 *   -> Fix commit submitted
 *   -> DeepSec revalidation passes
 *   -> Strix replays the original exploit
 *   -> Exploit no longer succeeds
 *   -> Finding becomes verified_fixed
 *   -> Receipt is generated
 */
describe("critical end-to-end verification lifecycle", () => {
  let artifactDir: string;
  let workspaceRoot: string;
  let artifactStore: ArtifactStore;
  let fixture: VulnerableFixture;

  beforeEach(async () => {
    await resetDatabase();
    artifactDir = await mkdtemp(path.join(tmpdir(), "shld-artifacts-"));
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "shld-workspace-"));
    artifactStore = new ArtifactStore(artifactDir);
    fixture = await createVulnerableFixture();
  });

  afterEach(async () => {
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(fixture.repoPath, { recursive: true, force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  function deepsecResponder(request: DeepSecExecutionRequest): DeepSecRunOutput {
    if (request.operation === "fix_revalidation") {
      return {
        findings: [
          {
            title: "Cross-tenant project access",
            description: "The project detail endpoint does not check tenant ownership.",
            category: "authorization",
            severity: "high",
            confidence: "high",
            file_path: "src/api/projects/[id].ts",
            symbol: "getProject",
            revalidation_verdict: "false_positive", // the vulnerability is gone in the fix commit
          },
        ],
        model: "deepsec-analyzer-v1",
        input_tokens: 400,
        output_tokens: 150,
        estimated_cost_usd: 0.03,
        engine_version: "1.0.0",
      };
    }
    // change_review against the vulnerable commit
    return {
      findings: [
        {
          title: "Cross-tenant project access",
          description: "The project detail endpoint does not check tenant ownership.",
          category: "authorization",
          severity: "high",
          confidence: "high",
          file_path: "src/api/projects/[id].ts",
          symbol: "getProject",
          recommendation: "Verify project.tenantId matches the requesting user's tenant before returning it.",
        },
      ],
      model: "deepsec-analyzer-v1",
      input_tokens: 1200,
      output_tokens: 500,
      estimated_cost_usd: 0.1,
      engine_version: "1.0.0",
    };
  }

  function strixResponder(request: StrixExecutionRequest): StrixRawResult {
    const isRetest = request.mission.hypothesis.includes("Replay the original exploit");
    return {
      verdict: isRetest ? "not_reproduced" : "confirmed",
      endpoint: "/api/projects/42",
      method: "GET",
      evidence_summary: isRetest
        ? "Cross-tenant request now correctly returns 403."
        : "Tenant B's project was returned to Tenant A's session.",
      reproduction_steps: ["Log in as Tenant A", "GET /api/projects/42 (owned by Tenant B)"],
      poc: isRetest ? undefined : "curl -H 'Authorization: Bearer <tenant-a>' https://preview.example.com/api/projects/42",
      model: "strix-agent-v1",
      input_tokens: 800,
      output_tokens: 300,
      estimated_cost_usd: 0.06,
      engine_version: "0.9.0",
    };
  }

  async function buildDeps(): Promise<{ deps: HandlerDeps; queue: InMemoryJobQueue }> {
    const queue = new InMemoryJobQueue();
    const deps: HandlerDeps = {
      prisma: testPrisma,
      jobQueue: queue,
      artifactStore,
      deepsecAdapter: new DeepSecAdapter(new MockDeepSecExecutionStrategy(deepsecResponder)),
      strixAdapter: new StrixAdapter(new MockStrixExecutionStrategy(strixResponder)),
      workspaceRoot,
      resolveCloneUrl: () => fixture.repoPath,
      policyVersion: "2026-01-01",
    };
    registerJobHandlers(queue, deps);
    return { deps, queue };
  }

  it("drives a vulnerable commit through discovery, confirmation, blocking, fix, and verified_fixed", async () => {
    const fx = await createFixtures();
    const { queue } = await buildDeps();

    const target = await testPrisma.targetEnvironment.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        name: "preview-184",
        baseUrl: "https://preview.example.com",
        environmentType: "preview",
        authorizationStatus: "authorized",
        allowedPaths: ["GET /api/projects/*"],
        excludedPaths: [],
        maximumRequests: 200,
        maximumConcurrency: 2,
        testAccounts: [
          { label: "Tenant A", username: "a@test.dev", credentialRef: "cred_a" },
          { label: "Tenant B", username: "b@test.dev", credentialRef: "cred_b" },
        ],
      },
    });

    // --- Vulnerable commit submitted ---
    const idempotencyKey = computeRunIdempotencyKey({
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      baseSha: fixture.baseSha,
      headSha: fixture.vulnerableSha,
      runType: "change_review",
      policyVersion: "2026-01-01",
    });
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "change_review",
        baseSha: fixture.baseSha,
        headSha: fixture.vulnerableSha,
        pullRequestNumber: 184,
        targetEnvironmentId: target.id,
        policyVersion: "2026-01-01",
        idempotencyKey,
      },
    });

    await queue.enqueue({
      jobType: "prepare_repository",
      organizationId: fx.organizationId,
      idempotencyKey: `${idempotencyKey}:prepare`,
      payload: { runId: run.id },
    });
    await queue.start();

    // --- DeepSec creates a finding; policy routes it to Strix; Strix confirms; review blocked ---
    const runAfterDiscovery = await testPrisma.securityRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runAfterDiscovery.status).toBe("blocked");

    const findings = await testPrisma.finding.findMany({ where: { repositoryId: fx.repositoryId } });
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.status).toBe("confirmed");
    expect(finding.category).toBe("authorization");

    const routingDecision = await testPrisma.routingDecision.findFirstOrThrow({ where: { findingId: finding.id } });
    expect(routingDecision.escalate).toBe(true);

    const validation = await testPrisma.validation.findFirstOrThrow({ where: { findingId: finding.id } });
    expect(validation.status).toBe("confirmed");
    expect(validation.proofArtifactId).not.toBeNull();

    const blockedReceipt = await testPrisma.receipt.findUniqueOrThrow({ where: { runId: run.id } });
    expect(blockedReceipt.status).toBe("blocked");

    // --- Fix commit submitted ---
    await submitFix(testPrisma, {
      findingId: finding.id,
      fixCommitSha: fixture.fixedSha,
      actor: { type: "agent", id: fx.agentIdentityId },
    });
    const findingAfterFixSubmit = await testPrisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(findingAfterFixSubmit.status).toBe("fix_submitted");

    const fixIdempotencyKey = computeRunIdempotencyKey({
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      baseSha: finding.lastSeenCommit,
      headSha: fixture.fixedSha,
      runType: "fix_verification",
      policyVersion: "2026-01-01",
    });
    const { runId: fixRunId } = await startFixVerification(testPrisma, {
      findingId: finding.id,
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      requestedByAgentId: fx.agentIdentityId,
      targetEnvironmentId: target.id,
      policyVersion: "2026-01-01",
      idempotencyKey: fixIdempotencyKey,
      actor: { type: "agent", id: fx.agentIdentityId },
    });

    // --- DeepSec revalidation passes; Strix replays the original exploit; exploit no longer succeeds ---
    await queue.enqueue({
      jobType: "prepare_repository",
      organizationId: fx.organizationId,
      idempotencyKey: `${fixIdempotencyKey}:prepare`,
      payload: { runId: fixRunId },
    });
    await queue.start();

    const fixRun = await testPrisma.securityRun.findUniqueOrThrow({ where: { id: fixRunId } });
    expect(fixRun.status).toBe("completed");

    // --- Finding becomes verified_fixed ---
    const findingAfterVerification = await testPrisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(findingAfterVerification.status).toBe("verified_fixed");

    const remediation = await testPrisma.remediation.findUniqueOrThrow({ where: { findingId: finding.id } });
    expect(remediation.finalStatus).toBe("verified_fixed");
    expect(remediation.sourceRevalidationStatus).toBe("passed");
    expect(remediation.runtimeRetestStatus).toBe("passed");

    // --- Receipt is generated ---
    const finalReceipt = await testPrisma.receipt.findUniqueOrThrow({ where: { runId: fixRunId } });
    expect(finalReceipt.status).toBe("passed_with_findings");

    const jsonArtifact = await testPrisma.artifact.findUniqueOrThrow({ where: { id: finalReceipt.jsonArtifactId! } });
    const receiptJson = JSON.parse((await artifactStore.read(jsonArtifact.storageLocation)).toString("utf8"));
    expect(receiptJson.findings[0].final_status).toBe("verified_fixed");
    expect(receiptJson.status).toBe("passed_with_findings");

    // Every state transition is auditable end to end.
    const auditEvents = await testPrisma.auditEvent.findMany({
      where: { findingId: finding.id },
      orderBy: { createdAt: "asc" },
    });
    expect(auditEvents.map((e) => e.eventType)).toEqual([
      "finding.created",
      "finding.source_confirmed",
      "finding.validation_queued",
      "finding.confirmed",
      "finding.fix_pending",
      "finding.fix_submitted",
      "finding.retesting",
      "finding.verified_fixed",
    ]);
  }, 30000);
});
