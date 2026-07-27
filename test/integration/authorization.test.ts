import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, resetDatabase, createFixtures } from "../helpers/db.js";
import { authorizeRepositoryForRun } from "../../src/authz/repository-authorization.js";
import { authorizeTargetEnvironment, assertDestructiveTestingAllowed } from "../../src/authz/target-authorization.js";
import { parseAgentPermissions } from "../../src/auth/permissions.js";
import { AuthorizationError, NotFoundError, TargetAuthorizationError } from "../../src/domain/errors.js";

describe("authorizeRepositoryForRun", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("returns the repository when it is active and in scope", async () => {
    const fx = await createFixtures();
    const permissions = parseAgentPermissions({
      repositoryIds: "all",
      operations: ["change_review"],
      targetEnvironmentIds: "all",
      maxRunBudgetUsd: 10,
      maxConcurrentRuns: 1,
    });
    const repo = await authorizeRepositoryForRun(testPrisma, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      permissions,
    });
    expect(repo.id).toBe(fx.repositoryId);
  });

  it("rejects a repository from a different organization", async () => {
    const fx = await createFixtures();
    const otherOrg = await testPrisma.organization.create({ data: { name: "Other Org" } });
    const otherRepo = await testPrisma.repository.create({
      data: { organizationId: otherOrg.id, owner: "other", name: "repo", defaultBranch: "main", status: "active" },
    });
    const permissions = parseAgentPermissions({
      repositoryIds: "all",
      operations: [],
      targetEnvironmentIds: "all",
      maxRunBudgetUsd: 10,
      maxConcurrentRuns: 1,
    });
    await expect(
      authorizeRepositoryForRun(testPrisma, {
        organizationId: fx.organizationId,
        repositoryId: otherRepo.id,
        permissions,
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("rejects a suspended repository", async () => {
    const fx = await createFixtures();
    await testPrisma.repository.update({ where: { id: fx.repositoryId }, data: { status: "suspended" } });
    const permissions = parseAgentPermissions({
      repositoryIds: "all",
      operations: [],
      targetEnvironmentIds: "all",
      maxRunBudgetUsd: 10,
      maxConcurrentRuns: 1,
    });
    await expect(
      authorizeRepositoryForRun(testPrisma, {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        permissions,
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("rejects a repository the agent is not scoped to", async () => {
    const fx = await createFixtures();
    const permissions = parseAgentPermissions({
      repositoryIds: ["some_other_repo"],
      operations: [],
      targetEnvironmentIds: "all",
      maxRunBudgetUsd: 10,
      maxConcurrentRuns: 1,
    });
    await expect(
      authorizeRepositoryForRun(testPrisma, {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        permissions,
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("raises NotFoundError for a nonexistent repository", async () => {
    const fx = await createFixtures();
    const permissions = parseAgentPermissions({
      repositoryIds: "all",
      operations: [],
      targetEnvironmentIds: "all",
      maxRunBudgetUsd: 10,
      maxConcurrentRuns: 1,
    });
    await expect(
      authorizeRepositoryForRun(testPrisma, {
        organizationId: fx.organizationId,
        repositoryId: "repo_does_not_exist",
        permissions,
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("authorizeTargetEnvironment", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function makeTarget(fx: Awaited<ReturnType<typeof createFixtures>>, overrides: Record<string, unknown> = {}) {
    return testPrisma.targetEnvironment.create({
      data: {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        name: "preview-184",
        baseUrl: "https://preview-184.example.com",
        environmentType: "preview",
        authorizationStatus: "authorized",
        allowedPaths: ["GET /api/projects/*"],
        excludedPaths: [],
        maximumRequests: 200,
        maximumConcurrency: 2,
        destructiveTestingAllowed: false,
        ...overrides,
      },
    });
  }

  const allPermissions = parseAgentPermissions({
    repositoryIds: "all",
    operations: [],
    targetEnvironmentIds: "all",
    maxRunBudgetUsd: 10,
    maxConcurrentRuns: 1,
  });

  it("authorizes a currently-valid target", async () => {
    const fx = await createFixtures();
    const target = await makeTarget(fx);
    const resolved = await authorizeTargetEnvironment(testPrisma, {
      organizationId: fx.organizationId,
      repositoryId: fx.repositoryId,
      targetEnvironmentId: target.id,
      permissions: allPermissions,
    });
    expect(resolved.id).toBe(target.id);
  });

  it("rejects a target that is not authorized", async () => {
    const fx = await createFixtures();
    const target = await makeTarget(fx, { authorizationStatus: "pending" });
    await expect(
      authorizeTargetEnvironment(testPrisma, {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        targetEnvironmentId: target.id,
        permissions: allPermissions,
      }),
    ).rejects.toThrow(TargetAuthorizationError);
  });

  it("rejects an expired authorization", async () => {
    const fx = await createFixtures();
    const target = await makeTarget(fx, { authorizationExpiresAt: new Date(Date.now() - 1000) });
    await expect(
      authorizeTargetEnvironment(testPrisma, {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        targetEnvironmentId: target.id,
        permissions: allPermissions,
      }),
    ).rejects.toThrow(TargetAuthorizationError);
  });

  it("rejects a target belonging to a different repository", async () => {
    const fx = await createFixtures();
    const otherRepo = await testPrisma.repository.create({
      data: { organizationId: fx.organizationId, owner: "acme", name: "other-repo", defaultBranch: "main", status: "active" },
    });
    const target = await makeTarget(fx, { repositoryId: otherRepo.id });
    await expect(
      authorizeTargetEnvironment(testPrisma, {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        targetEnvironmentId: target.id,
        permissions: allPermissions,
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("rejects a target from a different organization even with a matching id coincidence", async () => {
    const fx = await createFixtures();
    const otherOrg = await testPrisma.organization.create({ data: { name: "Other Org" } });
    const otherRepo = await testPrisma.repository.create({
      data: { organizationId: otherOrg.id, owner: "other", name: "repo", defaultBranch: "main", status: "active" },
    });
    const target = await testPrisma.targetEnvironment.create({
      data: {
        organizationId: otherOrg.id,
        repositoryId: otherRepo.id,
        name: "preview",
        baseUrl: "https://preview.other.example.com",
        environmentType: "preview",
        authorizationStatus: "authorized",
        allowedPaths: [],
        excludedPaths: [],
        maximumRequests: 100,
        maximumConcurrency: 1,
      },
    });
    await expect(
      authorizeTargetEnvironment(testPrisma, {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        targetEnvironmentId: target.id,
        permissions: allPermissions,
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("rejects a target the agent's permissions do not cover", async () => {
    const fx = await createFixtures();
    const target = await makeTarget(fx);
    const scoped = parseAgentPermissions({
      repositoryIds: "all",
      operations: [],
      targetEnvironmentIds: ["env_other"],
      maxRunBudgetUsd: 10,
      maxConcurrentRuns: 1,
    });
    await expect(
      authorizeTargetEnvironment(testPrisma, {
        organizationId: fx.organizationId,
        repositoryId: fx.repositoryId,
        targetEnvironmentId: target.id,
        permissions: scoped,
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("assertDestructiveTestingAllowed blocks destructive missions on non-destructive targets", async () => {
    const fx = await createFixtures();
    const target = await makeTarget(fx, { destructiveTestingAllowed: false });
    expect(() => assertDestructiveTestingAllowed(target, true)).toThrow(TargetAuthorizationError);
    expect(() => assertDestructiveTestingAllowed(target, false)).not.toThrow();
  });
});
