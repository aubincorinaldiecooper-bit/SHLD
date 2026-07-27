import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixture } from "../helpers/git-fixture.js";
import {
  computeSnapshotId,
  prepareRepositorySnapshot,
  RepositoryPreparationError,
} from "../../src/repo-prep/repository-preparation.js";

describe("prepareRepositorySnapshot", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function newWorkspaceRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "shld-workspace-"));
    cleanupDirs.push(dir);
    return dir;
  }

  it("checks out the head SHA and computes changed files with correct change types", async () => {
    const fixture = await createGitFixture();
    cleanupDirs.push(fixture.repoPath);
    const workspaceRoot = await newWorkspaceRoot();

    const snapshot = await prepareRepositorySnapshot({
      repositoryId: "repo_1",
      cloneUrl: fixture.repoPath,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      workspaceRoot,
    });

    expect(snapshot.snapshotId).toBe(computeSnapshotId("repo_1", fixture.baseSha, fixture.headSha));
    expect(snapshot.headSha).toBe(fixture.headSha);
    expect(snapshot.treeHash).toMatch(/^[0-9a-f]{40}$/);

    const byPath = Object.fromEntries(snapshot.changedFiles.map((f) => [f.path, f.changeType]));
    expect(byPath["src/auth/middleware.ts"]).toBe("added");
    expect(byPath["src/api/projects.ts"]).toBe("modified");
    expect(Object.keys(byPath).sort()).toEqual(["src/api/projects.ts", "src/auth/middleware.ts"]);
  });

  it("identifies sensitive paths and detected languages from the changed files", async () => {
    const fixture = await createGitFixture();
    cleanupDirs.push(fixture.repoPath);
    const workspaceRoot = await newWorkspaceRoot();

    const snapshot = await prepareRepositorySnapshot({
      repositoryId: "repo_1",
      cloneUrl: fixture.repoPath,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      workspaceRoot,
    });

    expect(snapshot.detectedLanguages).toEqual(["typescript"]);
    expect(snapshot.sensitivePaths.sort()).toEqual(["src/api/projects.ts", "src/auth/middleware.ts"]);
  });

  it("rejects a branch name in place of a resolved SHA", async () => {
    const fixture = await createGitFixture();
    cleanupDirs.push(fixture.repoPath);
    const workspaceRoot = await newWorkspaceRoot();

    await expect(
      prepareRepositorySnapshot({
        repositoryId: "repo_1",
        cloneUrl: fixture.repoPath,
        baseSha: "main",
        headSha: fixture.headSha,
        workspaceRoot,
      }),
    ).rejects.toThrow(RepositoryPreparationError);
  });

  it("rejects an unresolvable commit SHA", async () => {
    const fixture = await createGitFixture();
    cleanupDirs.push(fixture.repoPath);
    const workspaceRoot = await newWorkspaceRoot();

    await expect(
      prepareRepositorySnapshot({
        repositoryId: "repo_1",
        cloneUrl: fixture.repoPath,
        baseSha: fixture.baseSha,
        headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        workspaceRoot,
      }),
    ).rejects.toThrow(RepositoryPreparationError);
  });

  it("is idempotent: a second call with identical inputs reuses the materialized snapshot", async () => {
    const fixture = await createGitFixture();
    cleanupDirs.push(fixture.repoPath);
    const workspaceRoot = await newWorkspaceRoot();

    const first = await prepareRepositorySnapshot({
      repositoryId: "repo_1",
      cloneUrl: fixture.repoPath,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      workspaceRoot,
    });
    const second = await prepareRepositorySnapshot({
      repositoryId: "repo_1",
      cloneUrl: fixture.repoPath,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      workspaceRoot,
    });

    expect(second.snapshotPath).toBe(first.snapshotPath);
    expect(second.treeHash).toBe(first.treeHash);
  });

  it("strips write permission bits from the snapshot working tree", async () => {
    // NB: this asserts the mode bits our chmod pass sets, not that writes
    // are actually blocked — this test suite runs as root, which bypasses
    // POSIX permission checks entirely. The mode bits are still real
    // defense-in-depth for the non-root user the worker process runs as in
    // deployment.
    const fixture = await createGitFixture();
    cleanupDirs.push(fixture.repoPath);
    const workspaceRoot = await newWorkspaceRoot();

    const snapshot = await prepareRepositorySnapshot({
      repositoryId: "repo_1",
      cloneUrl: fixture.repoPath,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      workspaceRoot,
    });

    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(path.join(snapshot.snapshotPath, "src", "api", "projects.ts"));
    const writableByAnyone = (fileStat.mode & 0o222) !== 0;
    expect(writableByAnyone).toBe(false);
  });
});
