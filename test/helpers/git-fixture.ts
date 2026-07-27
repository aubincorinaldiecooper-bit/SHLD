import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";

export interface GitFixture {
  repoPath: string;
  baseSha: string;
  headSha: string;
}

/** A tiny local git repo with a base commit and a head commit touching a sensitive path. */
export async function createGitFixture(): Promise<GitFixture> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "shld-fixture-"));
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig("user.email", "test@shld.dev");
  await git.addConfig("user.name", "SHLD Test");

  await mkdir(path.join(repoPath, "src", "api"), { recursive: true });
  await writeFile(path.join(repoPath, "README.md"), "# Fixture repo\n");
  await writeFile(path.join(repoPath, "src", "api", "projects.ts"), "export function getProject() {}\n");
  await git.add(".");
  await git.commit("initial commit");
  const baseSha = (await git.revparse(["HEAD"])).trim();

  await writeFile(
    path.join(repoPath, "src", "api", "projects.ts"),
    "export function getProject(id: string) { return db.projects.find(id); }\n",
  );
  await mkdir(path.join(repoPath, "src", "auth"), { recursive: true });
  await writeFile(path.join(repoPath, "src", "auth", "middleware.ts"), "export function requireAuth() {}\n");
  await git.add(".");
  await git.commit("add auth middleware, touch projects api");
  const headSha = (await git.revparse(["HEAD"])).trim();

  return { repoPath, baseSha, headSha };
}
