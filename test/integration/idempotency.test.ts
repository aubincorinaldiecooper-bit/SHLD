import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { withIdempotency } from "../../src/api/idempotency.js";
import { IdempotencyConflictError } from "../../src/domain/errors.js";

describe("withIdempotency", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("executes the handler once and returns the same response for repeated calls", async () => {
    const fx = await createFixtures();
    let callCount = 0;
    const params = {
      organizationId: fx.organizationId,
      endpoint: "POST /v1/security/reviews",
      idempotencyKey: "key-1",
      requestBody: { repositoryId: fx.repositoryId },
    };

    const first = await withIdempotency(testPrisma, params, async () => {
      callCount += 1;
      return { status: 201, body: { runId: "run_1" } };
    });
    const second = await withIdempotency(testPrisma, params, async () => {
      callCount += 1;
      return { status: 201, body: { runId: "run_1" } };
    });

    expect(callCount).toBe(1);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.body).toEqual({ runId: "run_1" });
  });

  it("rejects reusing the same key with a different request body", async () => {
    const fx = await createFixtures();
    const base = {
      organizationId: fx.organizationId,
      endpoint: "POST /v1/security/reviews",
      idempotencyKey: "key-2",
    };
    await withIdempotency(testPrisma, { ...base, requestBody: { a: 1 } }, async () => ({
      status: 201,
      body: { ok: true },
    }));

    await expect(
      withIdempotency(testPrisma, { ...base, requestBody: { a: 2 } }, async () => ({ status: 201, body: { ok: true } })),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("scopes idempotency keys per organization", async () => {
    const fx1 = await createFixtures();
    const org2 = await testPrisma.organization.create({ data: { name: "Other" } });

    let callCount = 0;
    const handler = async () => {
      callCount += 1;
      return { status: 201, body: { ok: true } };
    };

    await withIdempotency(
      testPrisma,
      { organizationId: fx1.organizationId, endpoint: "POST /x", idempotencyKey: "same-key", requestBody: {} },
      handler,
    );
    await withIdempotency(
      testPrisma,
      { organizationId: org2.id, endpoint: "POST /x", idempotencyKey: "same-key", requestBody: {} },
      handler,
    );

    expect(callCount).toBe(2);
  });
});
