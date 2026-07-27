import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { submitFix } from "../../src/remediation/submit-fix.js";
import { startFixVerification, RemediationNotFoundError } from "../../src/remediation/start-fix-verification.js";
import { NotFoundError } from "../../src/domain/errors.js";

describe("startFixVerification", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  async function createFindingWithFixSubmitted(fx: Awaited<ReturnType<typeof createFixtures>>) {
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        fingerprint: `fp-${Math.random()}`,
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
    await submitFix(testPrisma, { findingId: finding.id, fixCommitSha: "c".repeat(40), actor: { type: "agent" } });
    return finding;
  }

  it("creates a fix_verification run and moves the finding to retesting", async () => {
    const fx = await createFixtures();
    const finding = await createFindingWithFixSubmitted(fx);

    const outcome = await startFixVerification(testPrisma, {
      findingId: finding.id,
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      requestedByAgentId: fx.agentIdentityId,
      policyVersion: "2026-01-01",
      idempotencyKey: `verify-${Math.random()}`,
      actor: { type: "agent" },
    });

    expect(outcome.fixCommitSha).toBe("c".repeat(40));
    expect(outcome.requiresRuntimeRetest).toBe(false);

    const run = await testPrisma.securityRun.findUniqueOrThrow({ where: { id: outcome.runId } });
    expect(run.runType).toBe("fix_verification");
    expect(run.headSha).toBe("c".repeat(40));
    expect(run.status).toBe("queued");

    const dbFinding = await testPrisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(dbFinding.status).toBe("retesting");
  });

  it("raises RemediationNotFoundError when no fix has been submitted", async () => {
    const fx = await createFixtures();
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        fingerprint: `fp-${Math.random()}`,
        title: "t",
        description: "d",
        category: "authorization",
        severity: "high",
        confidence: "high",
        status: "source_confirmed",
        firstSeenCommit: "a".repeat(40),
        lastSeenCommit: "a".repeat(40),
      },
    });
    await expect(
      startFixVerification(testPrisma, {
        findingId: finding.id,
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        policyVersion: "2026-01-01",
        idempotencyKey: `verify-${Math.random()}`,
        actor: { type: "agent" },
      }),
    ).rejects.toThrow(RemediationNotFoundError);
  });

  it("raises NotFoundError for a nonexistent finding", async () => {
    const fx = await createFixtures();
    await expect(
      startFixVerification(testPrisma, {
        findingId: "finding_missing",
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        policyVersion: "2026-01-01",
        idempotencyKey: `verify-${Math.random()}`,
        actor: { type: "agent" },
      }),
    ).rejects.toThrow(NotFoundError);
  });
});
