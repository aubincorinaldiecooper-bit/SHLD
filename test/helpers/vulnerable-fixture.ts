import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";

export interface VulnerableFixture {
  repoPath: string;
  baseSha: string;
  vulnerableSha: string;
  fixedSha: string;
}

const VULNERABLE_HANDLER = `export async function getProject(req: Request) {
  const project = await db.projects.findById(req.params.id);
  return project; // BUG: no check that project.tenantId === req.user.tenantId
}
`;

const FIXED_HANDLER = `export async function getProject(req: Request) {
  const project = await db.projects.findById(req.params.id);
  if (project.tenantId !== req.user.tenantId) {
    throw new ForbiddenError();
  }
  return project;
}
`;

/**
 * A minimal IDOR/cross-tenant-access fixture: base commit has no project
 * endpoint at all, the vulnerable commit adds one missing a tenant check,
 * and the fixed commit adds the check back. Mirrors the spec's worked
 * cross-tenant-access example end to end.
 */
export async function createVulnerableFixture(): Promise<VulnerableFixture> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "shld-vuln-fixture-"));
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig("user.email", "test@shld.dev");
  await git.addConfig("user.name", "SHLD Test");

  await mkdir(path.join(repoPath, "src", "api", "projects"), { recursive: true });
  await writeFile(path.join(repoPath, "README.md"), "# Fixture app\n");
  await git.add(".");
  await git.commit("initial commit");
  const baseSha = (await git.revparse(["HEAD"])).trim();

  await writeFile(path.join(repoPath, "src", "api", "projects", "[id].ts"), VULNERABLE_HANDLER);
  await git.add(".");
  await git.commit("add project detail endpoint");
  const vulnerableSha = (await git.revparse(["HEAD"])).trim();

  await writeFile(path.join(repoPath, "src", "api", "projects", "[id].ts"), FIXED_HANDLER);
  await git.add(".");
  await git.commit("fix: enforce tenant check on project detail endpoint");
  const fixedSha = (await git.revparse(["HEAD"])).trim();

  return { repoPath, baseSha, vulnerableSha, fixedSha };
}
