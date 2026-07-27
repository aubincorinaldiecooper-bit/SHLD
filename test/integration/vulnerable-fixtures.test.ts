import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { createMultiVulnerabilityFixture, type MultiVulnerabilityFixture } from "../helpers/multi-vulnerability-fixture.js";
import { prepareRepositorySnapshot } from "../../src/repo-prep/repository-preparation.js";
import { classifyChange } from "../../src/policy/change-classifier.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { InMemoryJobQueue } from "../../src/orchestration/in-memory-job-queue.js";
import { registerJobHandlers } from "../../src/orchestration/handlers/register.js";
import type { HandlerDeps } from "../../src/orchestration/handlers/deps.js";
import { DeepSecAdapter } from "../../src/adapters/deepsec/deepsec-adapter.js";
import { MockDeepSecExecutionStrategy } from "../../src/adapters/deepsec/execution-strategy.js";
import type { DeepSecExecutionRequest, DeepSecRunOutput } from "../../src/adapters/deepsec/types.js";
import { StrixAdapter } from "../../src/adapters/strix/strix-adapter.js";
import { MockStrixExecutionStrategy } from "../../src/adapters/strix/execution-strategy.js";
import { computeRunIdempotencyKey } from "../../src/orchestration/run-idempotency-key.js";
import { submitFix } from "../../src/remediation/submit-fix.js";
import { startFixVerification } from "../../src/remediation/start-fix-verification.js";

describe("controlled vulnerable applications: classifier detection", () => {
  let fixture: MultiVulnerabilityFixture;
  let workspaceRoot: string;

  beforeEach(async () => {
    fixture = await createMultiVulnerabilityFixture();
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "shld-workspace-"));
  });

  afterEach(async () => {
    await rm(fixture.repoPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it("flags the command-injection commit as security-sensitive", async () => {
    const snapshot = await prepareRepositorySnapshot({
      repositoryId: "repo_1",
      cloneUrl: fixture.repoPath,
      baseSha: fixture.stages.sqlInjection.fixedSha,
      headSha: fixture.stages.commandInjection.vulnerableSha,
      workspaceRoot,
    });
    const classification = classifyChange({ changedFiles: snapshot.changedFiles });
    expect(classification.securitySensitive).toBe(true);
    expect(classification.categories).toContain("api-surface");
  });

  it("flags the SSRF commit (webhook URL fetch) as security-sensitive", async () => {
    const snapshot = await prepareRepositorySnapshot({
      repositoryId: "repo_1",
      cloneUrl: fixture.repoPath,
      baseSha: fixture.stages.commandInjection.fixedSha,
      headSha: fixture.stages.ssrf.vulnerableSha,
      workspaceRoot,
    });
    const classification = classifyChange({ changedFiles: snapshot.changedFiles });
    expect(classification.securitySensitive).toBe(true);
    expect(classification.categories).toContain("webhooks");
  });

  it("flags the exposed-secret commit as security-sensitive with high risk", async () => {
    const snapshot = await prepareRepositorySnapshot({
      repositoryId: "repo_1",
      cloneUrl: fixture.repoPath,
      baseSha: fixture.stages.ssrf.fixedSha,
      headSha: fixture.stages.exposedSecret.vulnerableSha,
      workspaceRoot,
    });
    const classification = classifyChange({ changedFiles: snapshot.changedFiles });
    expect(classification.securitySensitive).toBe(true);
    expect(classification.categories).toContain("secrets-exposure");
    expect(classification.riskLevel).toBe("high");
  });

  it("each vulnerable commit has a corresponding fixed commit with a resolvable diff", async () => {
    for (const stage of Object.values(fixture.stages)) {
      const snapshot = await prepareRepositorySnapshot({
        repositoryId: "repo_1",
        cloneUrl: fixture.repoPath,
        baseSha: stage.vulnerableSha,
        headSha: stage.fixedSha,
        workspaceRoot,
      });
      expect(snapshot.changedFiles.map((f) => f.path)).toContain(stage.filePath);
    }
  });
});

describe("source-only finding: SQL injection through the full submit -> revalidate -> verified_fixed loop", () => {
  let fixture: MultiVulnerabilityFixture;
  let artifactDir: string;
  let workspaceRoot: string;
  let artifactStore: ArtifactStore;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await createMultiVulnerabilityFixture();
    artifactDir = await mkdtemp(path.join(tmpdir(), "shld-artifacts-"));
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "shld-workspace-"));
    artifactStore = new ArtifactStore(artifactDir);
  });

  afterEach(async () => {
    await rm(fixture.repoPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  function deepsecResponder(request: DeepSecExecutionRequest): DeepSecRunOutput {
    if (request.operation === "fix_revalidation") {
      return {
        findings: [
          {
            title: "SQL injection in project search",
            description: "User input is concatenated directly into a SQL query.",
            category: "injection",
            severity: "medium",
            confidence: "high",
            file_path: fixture.stages.sqlInjection.filePath,
            symbol: "searchProjects",
            revalidation_verdict: "false_positive",
          },
        ],
        model: "deepsec-analyzer-v1",
        input_tokens: 300,
        output_tokens: 100,
        estimated_cost_usd: 0.02,
        engine_version: "1.0.0",
      };
    }
    return {
      findings: [
        {
          title: "SQL injection in project search",
          description: "User input is concatenated directly into a SQL query.",
          category: "injection",
          // Deliberately medium severity so the routing policy does not
          // auto-escalate to Strix — this proves the source-only
          // verification path, distinct from the IDOR fixture's
          // runtime-confirmed path in orchestration-pipeline.test.ts.
          severity: "medium",
          confidence: "high",
          file_path: fixture.stages.sqlInjection.filePath,
          symbol: "searchProjects",
          recommendation: "Use a parameterized query instead of string interpolation.",
        },
      ],
      model: "deepsec-analyzer-v1",
      input_tokens: 1000,
      output_tokens: 400,
      estimated_cost_usd: 0.08,
      engine_version: "1.0.0",
    };
  }

  async function buildDeps() {
    const queue = new InMemoryJobQueue();
    const deps: HandlerDeps = {
      prisma: testPrisma,
      jobQueue: queue,
      artifactStore,
      deepsecAdapter: new DeepSecAdapter(new MockDeepSecExecutionStrategy(deepsecResponder)),
      strixAdapter: new StrixAdapter(new MockStrixExecutionStrategy(() => {
        throw new Error("Strix should never run for a medium-severity, non-escalating finding");
      })),
      workspaceRoot,
      resolveCloneUrl: () => fixture.repoPath,
      policyVersion: "2026-01-01",
    };
    registerJobHandlers(queue, deps);
    return queue;
  }

  it("never escalates to Strix, reaches awaiting_fix, and verified_fixed after DeepSec-only revalidation", async () => {
    const fx = await createFixtures();
    const queue = await buildDeps();

    const idempotencyKey = computeRunIdempotencyKey({
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      baseSha: fixture.baseSha,
      headSha: fixture.stages.sqlInjection.vulnerableSha,
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
        headSha: fixture.stages.sqlInjection.vulnerableSha,
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

    const runAfterDiscovery = await testPrisma.securityRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runAfterDiscovery.status).toBe("awaiting_fix");

    const finding = await testPrisma.finding.findFirstOrThrow({ where: { repositoryId: fx.repositoryId } });
    expect(finding.status).toBe("source_confirmed");
    expect(finding.category).toBe("injection");

    const routingDecision = await testPrisma.routingDecision.findFirstOrThrow({ where: { findingId: finding.id } });
    expect(routingDecision.escalate).toBe(false);
    const validations = await testPrisma.validation.findMany({ where: { findingId: finding.id } });
    expect(validations).toHaveLength(0);

    // --- Fix submitted ---
    await submitFix(testPrisma, {
      findingId: finding.id,
      fixCommitSha: fixture.stages.sqlInjection.fixedSha,
      actor: { type: "agent", id: fx.agentIdentityId },
    });
    const remediationAfterSubmit = await testPrisma.remediation.findUniqueOrThrow({ where: { findingId: finding.id } });
    expect(remediationAfterSubmit.runtimeRetestStatus).toBe("not_applicable");

    const fixIdempotencyKey = computeRunIdempotencyKey({
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      baseSha: finding.lastSeenCommit,
      headSha: fixture.stages.sqlInjection.fixedSha,
      runType: "fix_verification",
      policyVersion: "2026-01-01",
    });
    const { runId: fixRunId } = await startFixVerification(testPrisma, {
      findingId: finding.id,
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      requestedByAgentId: fx.agentIdentityId,
      policyVersion: "2026-01-01",
      idempotencyKey: fixIdempotencyKey,
      actor: { type: "agent", id: fx.agentIdentityId },
    });

    await queue.enqueue({
      jobType: "prepare_repository",
      organizationId: fx.organizationId,
      idempotencyKey: `${fixIdempotencyKey}:prepare`,
      payload: { runId: fixRunId },
    });
    await queue.start();

    const fixRun = await testPrisma.securityRun.findUniqueOrThrow({ where: { id: fixRunId } });
    expect(fixRun.status).toBe("completed");

    const findingAfterVerification = await testPrisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(findingAfterVerification.status).toBe("verified_fixed");

    const remediation = await testPrisma.remediation.findUniqueOrThrow({ where: { findingId: finding.id } });
    expect(remediation.finalStatus).toBe("verified_fixed");
    expect(remediation.sourceRevalidationStatus).toBe("passed");
    expect(remediation.runtimeRetestStatus).toBe("not_applicable");

    const receipt = await testPrisma.receipt.findUniqueOrThrow({ where: { runId: fixRunId } });
    expect(receipt.status).toBe("passed_with_findings");
  }, 30000);
});
