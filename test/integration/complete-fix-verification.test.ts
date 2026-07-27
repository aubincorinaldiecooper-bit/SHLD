import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { submitFix } from "../../src/remediation/submit-fix.js";
import { startFixVerification } from "../../src/remediation/start-fix-verification.js";
import { completeFixVerification } from "../../src/remediation/complete-fix-verification.js";

describe("completeFixVerification", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  async function setupRetesting(fx: Awaited<ReturnType<typeof createFixtures>>) {
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
    const { runId } = await startFixVerification(testPrisma, {
      findingId: finding.id,
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      requestedByAgentId: fx.agentIdentityId,
      policyVersion: "2026-01-01",
      idempotencyKey: `verify-${Math.random()}`,
      actor: { type: "agent" },
    });
    return { finding, runId };
  }

  it("verified_fixed: updates the remediation and the finding", async () => {
    const fx = await createFixtures();
    const { finding, runId } = await setupRetesting(fx);

    const outcome = await completeFixVerification(testPrisma, {
      findingId: finding.id,
      runId,
      actor: { type: "system" },
      sourceRevalidationPassed: true,
      runtimeRetestRequired: false,
      runtimeRetestPassed: null,
      targetBuildMatchesFixCommit: false,
    });

    expect(outcome).toEqual({ outcome: "verified_fixed", findingStatus: "verified_fixed" });

    const remediation = await testPrisma.remediation.findUniqueOrThrow({ where: { findingId: finding.id } });
    expect(remediation.finalStatus).toBe("verified_fixed");
    expect(remediation.sourceRevalidationStatus).toBe("passed");

    const dbFinding = await testPrisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(dbFinding.status).toBe("verified_fixed");
  });

  it("still_exploitable: source revalidation fails on a source-only finding", async () => {
    const fx = await createFixtures();
    const { finding, runId } = await setupRetesting(fx);

    const outcome = await completeFixVerification(testPrisma, {
      findingId: finding.id,
      runId,
      actor: { type: "system" },
      sourceRevalidationPassed: false,
      runtimeRetestRequired: false,
      runtimeRetestPassed: null,
      targetBuildMatchesFixCommit: false,
    });

    expect(outcome.outcome).toBe("still_exploitable");
    const dbFinding = await testPrisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(dbFinding.status).toBe("still_exploitable");
  });

  it("verification_failed leaves the finding at retesting for later retry", async () => {
    const fx = await createFixtures();
    const { finding, runId } = await setupRetesting(fx);

    const outcome = await completeFixVerification(testPrisma, {
      findingId: finding.id,
      runId,
      actor: { type: "system" },
      sourceRevalidationPassed: true,
      runtimeRetestRequired: false,
      runtimeRetestPassed: null,
      targetBuildMatchesFixCommit: false,
      operationalFailure: true,
    });

    expect(outcome).toEqual({ outcome: "verification_failed", findingStatus: null });
    const dbFinding = await testPrisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(dbFinding.status).toBe("retesting");

    const remediation = await testPrisma.remediation.findUniqueOrThrow({ where: { findingId: finding.id } });
    expect(remediation.finalStatus).toBe("verification_failed");
  });

  it("partially_fixed for a runtime-confirmed finding maps the finding to inconclusive", async () => {
    const fx = await createFixtures();
    const { finding, runId } = await setupRetesting(fx);

    const outcome = await completeFixVerification(testPrisma, {
      findingId: finding.id,
      runId,
      actor: { type: "system" },
      sourceRevalidationPassed: true,
      runtimeRetestRequired: true,
      runtimeRetestPassed: false,
      targetBuildMatchesFixCommit: true,
    });

    expect(outcome.outcome).toBe("partially_fixed");
    expect(outcome.findingStatus).toBe("inconclusive");
    const remediation = await testPrisma.remediation.findUniqueOrThrow({ where: { findingId: finding.id } });
    expect(remediation.runtimeRetestStatus).toBe("failed");
  });
});
