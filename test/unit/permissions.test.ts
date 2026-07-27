import { describe, expect, it } from "vitest";
import {
  assertOperationAllowed,
  assertRepositoryAllowed,
  assertTargetEnvironmentAllowed,
  parseAgentPermissions,
} from "../../src/auth/permissions.js";
import { AuthorizationError } from "../../src/domain/errors.js";

describe("agent permissions", () => {
  const scoped = parseAgentPermissions({
    repositoryIds: ["repo_1"],
    operations: ["change_review"],
    targetEnvironmentIds: ["env_1"],
    maxRunBudgetUsd: 10,
    maxConcurrentRuns: 2,
  });

  const unrestricted = parseAgentPermissions({
    repositoryIds: "all",
    operations: ["change_review", "validate_finding"],
    targetEnvironmentIds: "all",
    maxRunBudgetUsd: 100,
    maxConcurrentRuns: 5,
  });

  it("allows access to an explicitly listed repository", () => {
    expect(() => assertRepositoryAllowed(scoped, "repo_1")).not.toThrow();
  });

  it("denies access to a repository not in the allow-list", () => {
    expect(() => assertRepositoryAllowed(scoped, "repo_2")).toThrow(AuthorizationError);
  });

  it("'all' grants access to any repository", () => {
    expect(() => assertRepositoryAllowed(unrestricted, "repo_999")).not.toThrow();
  });

  it("denies an operation not in the allow-list", () => {
    expect(() => assertOperationAllowed(scoped, "validate_finding")).toThrow(AuthorizationError);
  });

  it("denies a target environment not in the allow-list", () => {
    expect(() => assertTargetEnvironmentAllowed(scoped, "env_2")).toThrow(AuthorizationError);
  });

  it("rejects a malformed permissions object", () => {
    expect(() => parseAgentPermissions({ repositoryIds: "all" })).toThrow();
  });
});
