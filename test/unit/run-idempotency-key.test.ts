import { describe, expect, it } from "vitest";
import { computeRunIdempotencyKey, computeValidationIdempotencyKey } from "../../src/orchestration/run-idempotency-key.js";

describe("computeRunIdempotencyKey", () => {
  const base = {
    organizationId: "org_1",
    repositoryId: "repo_1",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    runType: "change_review",
    policyVersion: "2026-01-01",
  };

  it("is deterministic for identical inputs", () => {
    expect(computeRunIdempotencyKey(base)).toBe(computeRunIdempotencyKey({ ...base }));
  });

  it("is case-insensitive on SHAs", () => {
    expect(computeRunIdempotencyKey(base)).toBe(
      computeRunIdempotencyKey({ ...base, baseSha: base.baseSha.toUpperCase(), headSha: base.headSha.toUpperCase() }),
    );
  });

  it("differs when the head SHA differs", () => {
    expect(computeRunIdempotencyKey(base)).not.toBe(computeRunIdempotencyKey({ ...base, headSha: "c".repeat(40) }));
  });

  it("differs when the run type differs", () => {
    expect(computeRunIdempotencyKey(base)).not.toBe(computeRunIdempotencyKey({ ...base, runType: "repository_scan" }));
  });

  it("differs when the policy version differs", () => {
    expect(computeRunIdempotencyKey(base)).not.toBe(
      computeRunIdempotencyKey({ ...base, policyVersion: "2026-02-01" }),
    );
  });
});

describe("computeValidationIdempotencyKey", () => {
  const base = {
    findingFingerprint: "fp-1",
    targetBuildId: "build-184-a",
    targetEnvironmentId: "env_1",
    validationPolicyVersion: "2026-01-01",
    engineVersion: "0.9.0",
  };

  it("is deterministic", () => {
    expect(computeValidationIdempotencyKey(base)).toBe(computeValidationIdempotencyKey({ ...base }));
  });

  it("differs across target builds", () => {
    expect(computeValidationIdempotencyKey(base)).not.toBe(
      computeValidationIdempotencyKey({ ...base, targetBuildId: "build-184-b" }),
    );
  });
});
