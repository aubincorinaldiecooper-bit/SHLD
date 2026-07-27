import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { applyRoutingPolicy } from "../../src/policy/apply-routing-policy.js";
import type { RoutingPolicyInput } from "../../src/policy/routing-policy.js";

function baseInput(overrides: Partial<RoutingPolicyInput> = {}): RoutingPolicyInput {
  return {
    severity: "high",
    confidence: "high",
    category: "authorization",
    targetAuthorized: true,
    canBeExercisedDynamically: true,
    alreadyTestedAgainstBuild: false,
    remainingBudgetUsd: 50,
    estimatedValidationCostUsd: 2,
    policyVersion: "2026-01-01",
    ...overrides,
  };
}

describe("applyRoutingPolicy", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  async function createSourceConfirmedFinding(fx: Awaited<ReturnType<typeof createFixtures>>) {
    return testPrisma.finding.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        fingerprint: "fp-routing-1",
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
  }

  async function createRun(fx: Awaited<ReturnType<typeof createFixtures>>) {
    return testPrisma.securityRun.create({
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
  }

  it("escalating persists the decision and advances the finding to validation_queued", async () => {
    const fx = await createFixtures();
    const finding = await createSourceConfirmedFinding(fx);
    const run = await createRun(fx);

    const result = await testPrisma.$transaction((tx) =>
      applyRoutingPolicy(tx, { runId: run.id, findingId: finding.id, input: baseInput() }),
    );
    expect(result.decision).toBe("escalate");

    const dbFinding = await testPrisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(dbFinding.status).toBe("validation_queued");

    const decisionRow = await testPrisma.routingDecision.findFirst({ where: { findingId: finding.id } });
    expect(decisionRow).toMatchObject({ escalate: true, policyVersion: "2026-01-01" });
    expect(decisionRow?.reason).toContain("Strix validation was requested");

    const events = await testPrisma.auditEvent.findMany({
      where: { findingId: finding.id, eventType: "finding.validation_queued" },
    });
    expect(events).toHaveLength(1);
  });

  it("skipping persists the decision without transitioning the finding", async () => {
    const fx = await createFixtures();
    const finding = await createSourceConfirmedFinding(fx);
    const run = await createRun(fx);

    const result = await testPrisma.$transaction((tx) =>
      applyRoutingPolicy(tx, {
        runId: run.id,
        findingId: finding.id,
        input: baseInput({ targetAuthorized: false }),
      }),
    );
    expect(result.decision).toBe("skip");

    const dbFinding = await testPrisma.finding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(dbFinding.status).toBe("source_confirmed");

    const decisionRow = await testPrisma.routingDecision.findFirst({ where: { findingId: finding.id } });
    expect(decisionRow).toMatchObject({ escalate: false });
  });

  it("rejects applying routing policy to a finding that is not yet source_confirmed", async () => {
    const fx = await createFixtures();
    const finding = await testPrisma.finding.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        fingerprint: "fp-routing-2",
        title: "Another finding",
        description: "desc",
        category: "authorization",
        severity: "high",
        confidence: "high",
        status: "suspected",
        firstSeenCommit: "a".repeat(40),
        lastSeenCommit: "a".repeat(40),
      },
    });
    const run = await createRun(fx);

    await expect(
      testPrisma.$transaction((tx) =>
        applyRoutingPolicy(tx, { runId: run.id, findingId: finding.id, input: baseInput() }),
      ),
    ).rejects.toThrow();

    // The routing decision itself is still recorded — only the finding
    // transition is invalid — but the transaction rolls back everything.
    const decisionRow = await testPrisma.routingDecision.findFirst({ where: { findingId: finding.id } });
    expect(decisionRow).toBeNull();
  });
});
