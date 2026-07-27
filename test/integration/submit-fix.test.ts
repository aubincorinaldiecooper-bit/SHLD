import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { submitFix } from "../../src/remediation/submit-fix.js";
import { NotFoundError, InvalidStateTransitionError } from "../../src/domain/errors.js";

describe("submitFix", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  async function createFinding(
    fx: Awaited<ReturnType<typeof createFixtures>>,
    status: "confirmed" | "source_confirmed" | "suspected" = "confirmed",
  ) {
    return testPrisma.finding.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        fingerprint: `fp-submit-${Math.random()}`,
        title: "Cross-tenant project access",
        description: "desc",
        category: "authorization",
        severity: "high",
        confidence: "high",
        status,
        firstSeenCommit: "a".repeat(40),
        lastSeenCommit: "a".repeat(40),
      },
    });
  }

  it("submits a fix for a runtime-confirmed finding and requires a runtime retest", async () => {
    const fx = await createFixtures();
    const finding = await createFinding(fx, "confirmed");
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "finding_validation",
        status: "completed",
        baseSha: "a".repeat(40),
        headSha: "a".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: `run-${Math.random()}`,
      },
    });
    const engineExecution = await testPrisma.engineExecution.create({
      data: { runId: run.id, engine: "strix", operation: "run_strix_validation", status: "completed" },
    });
    await testPrisma.validation.create({
      data: { findingId: finding.id, engineExecutionId: engineExecution.id, status: "confirmed" },
    });

    const outcome = await submitFix(testPrisma, {
      findingId: finding.id,
      fixCommitSha: "c".repeat(40),
      actor: { type: "agent", id: fx.agentIdentityId },
    });

    expect(outcome.findingStatus).toBe("fix_submitted");
    expect(outcome.requiresRuntimeRetest).toBe(true);

    const remediation = await testPrisma.remediation.findUniqueOrThrow({ where: { findingId: finding.id } });
    expect(remediation.fixCommitSha).toBe("c".repeat(40));
    expect(remediation.runtimeRetestStatus).toBe("pending");

    const events = await testPrisma.auditEvent.findMany({
      where: { findingId: finding.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.eventType)).toEqual(["finding.fix_pending", "finding.fix_submitted"]);
  });

  it("submits a fix for a source-only finding and does not require a runtime retest", async () => {
    const fx = await createFixtures();
    const finding = await createFinding(fx, "source_confirmed");

    const outcome = await submitFix(testPrisma, {
      findingId: finding.id,
      fixCommitSha: "c".repeat(40),
      actor: { type: "agent" },
    });

    expect(outcome.requiresRuntimeRetest).toBe(false);
    const remediation = await testPrisma.remediation.findUniqueOrThrow({ where: { findingId: finding.id } });
    expect(remediation.runtimeRetestStatus).toBe("not_applicable");
  });

  it("allows resubmitting a fix after a prior attempt was still exploitable", async () => {
    const fx = await createFixtures();
    const finding = await createFinding(fx, "confirmed");
    await submitFix(testPrisma, { findingId: finding.id, fixCommitSha: "c".repeat(40), actor: { type: "agent" } });
    await testPrisma.finding.update({ where: { id: finding.id }, data: { status: "still_exploitable" } });

    const outcome = await submitFix(testPrisma, {
      findingId: finding.id,
      fixCommitSha: "d".repeat(40),
      actor: { type: "agent" },
    });
    expect(outcome.findingStatus).toBe("fix_submitted");
    const remediation = await testPrisma.remediation.findUniqueOrThrow({ where: { findingId: finding.id } });
    expect(remediation.fixCommitSha).toBe("d".repeat(40));
  });

  it("rejects submitting a fix for a finding that isn't yet confirmed in any way", async () => {
    const fx = await createFixtures();
    const finding = await createFinding(fx, "suspected");
    await expect(
      submitFix(testPrisma, { findingId: finding.id, fixCommitSha: "c".repeat(40), actor: { type: "agent" } }),
    ).rejects.toThrow(InvalidStateTransitionError);
  });

  it("raises NotFoundError for a nonexistent finding", async () => {
    await createFixtures();
    await expect(
      submitFix(testPrisma, { findingId: "finding_missing", fixCommitSha: "c".repeat(40), actor: { type: "agent" } }),
    ).rejects.toThrow(NotFoundError);
  });
});
