import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { transitionRunStatus } from "../../src/domain/run-transitions.js";
import { transitionFindingStatus } from "../../src/domain/finding-transitions.js";
import { InvalidStateTransitionError } from "../../src/domain/errors.js";

describe("transitionRunStatus", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("persists a legal transition and writes an audit event", async () => {
    const fx = await createFixtures();
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "change_review",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: "test-key-1",
      },
    });
    expect(run.status).toBe("queued");

    await testPrisma.$transaction(async (tx) => {
      await transitionRunStatus(tx, {
        runId: run.id,
        to: "classifying",
        actor: { type: "system" },
        eventType: "run.classification_started",
      });
    });

    const updated = await testPrisma.securityRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("classifying");
    expect(updated.startedAt).not.toBeNull();

    const events = await testPrisma.auditEvent.findMany({ where: { runId: run.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      previousState: "queued",
      newState: "classifying",
      eventType: "run.classification_started",
      actorType: "system",
    });
  });

  it("rejects an illegal transition and writes no audit event", async () => {
    const fx = await createFixtures();
    const run = await testPrisma.securityRun.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        requestedByAgentId: fx.agentIdentityId,
        runType: "change_review",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        policyVersion: "2026-01-01",
        idempotencyKey: "test-key-2",
      },
    });

    await expect(
      testPrisma.$transaction(async (tx) => {
        await transitionRunStatus(tx, {
          runId: run.id,
          to: "completed",
          actor: { type: "system" },
          eventType: "run.completed",
        });
      }),
    ).rejects.toThrow(InvalidStateTransitionError);

    const unchanged = await testPrisma.securityRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(unchanged.status).toBe("queued");
    const events = await testPrisma.auditEvent.findMany({ where: { runId: run.id } });
    expect(events).toHaveLength(0);
  });

  it("stamps completedAt on terminal transitions", async () => {
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
        idempotencyKey: "test-key-3",
      },
    });

    await testPrisma.$transaction(async (tx) => {
      await transitionRunStatus(tx, {
        runId: run.id,
        to: "completed",
        actor: { type: "system" },
        eventType: "run.completed",
      });
    });

    const updated = await testPrisma.securityRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.completedAt).not.toBeNull();
  });
});

describe("transitionFindingStatus", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("walks suspected -> source_confirmed -> validation_queued -> confirmed with audit trail", async () => {
    const fx = await createFixtures();
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        fingerprint: "fp-1",
        title: "Cross-tenant project access",
        description: "IDOR on project id",
        category: "authorization",
        severity: "high",
        confidence: "high",
        firstSeenCommit: "a".repeat(40),
        lastSeenCommit: "a".repeat(40),
      },
    });

    for (const to of ["source_confirmed", "validation_queued", "confirmed"] as const) {
      await testPrisma.$transaction(async (tx) => {
        await transitionFindingStatus(tx, {
          findingId: finding.id,
          to,
          actor: { type: "system" },
          eventType: `finding.${to}`,
        });
      });
    }

    const updated = await testPrisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(updated.status).toBe("confirmed");

    const events = await testPrisma.auditEvent.findMany({
      where: { findingId: finding.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.newState)).toEqual(["source_confirmed", "validation_queued", "confirmed"]);
  });

  it("rejects an illegal finding transition", async () => {
    const fx = await createFixtures();
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        fingerprint: "fp-2",
        title: "SQL injection",
        description: "unsanitized query param",
        category: "injection",
        severity: "critical",
        confidence: "high",
        firstSeenCommit: "a".repeat(40),
        lastSeenCommit: "a".repeat(40),
      },
    });

    await expect(
      testPrisma.$transaction(async (tx) => {
        await transitionFindingStatus(tx, {
          findingId: finding.id,
          to: "verified_fixed",
          actor: { type: "system" },
          eventType: "finding.verified_fixed",
        });
      }),
    ).rejects.toThrow(InvalidStateTransitionError);
  });
});
