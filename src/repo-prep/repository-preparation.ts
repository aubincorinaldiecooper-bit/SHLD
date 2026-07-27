import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { DomainError } from "../domain/errors.js";
import { findSensitivePaths } from "../policy/sensitive-patterns.js";
import { detectFrameworksFromManifest, detectLanguagesFromPaths } from "./language-detection.js";

export class RepositoryPreparationError extends DomainError {}

export type ChangeType = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  changeType: ChangeType;
  previousPath?: string;
}

export interface SubmoduleIssue {
  path: string;
  reason: string;
}

export interface SourceSnapshot {
  snapshotId: string;
  snapshotPath: string;
  repositoryId: string;
  baseSha: string;
  headSha: string;
  treeHash: string;
  changedFiles: ChangedFile[];
  detectedLanguages: string[];
  detectedFrameworks: string[];
  sensitivePaths: string[];
  submoduleIssues: SubmoduleIssue[];
  createdAt: Date;
}

export interface PrepareRepositorySnapshotParams {
  repositoryId: string;
  cloneUrl: string;
  baseSha: string;
  headSha: string;
  workspaceRoot: string;
  sensitivePathPatterns?: readonly string[];
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const SNAPSHOT_MARKER_FILE = ".shld-snapshot-complete";

export function computeSnapshotId(repositoryId: string, baseSha: string, headSha: string): string {
  return createHash("sha256").update(`${repositoryId}:${baseSha}:${headSha}`).digest("hex").slice(0, 32);
}

/**
 * Materializes an immutable, checked-out source snapshot for a base/head
 * commit pair. Never accepts branch names — only resolved SHAs — so a
 * mutable ref cannot be scanned out from under the platform between
 * classification and engine execution.
 */
export async function prepareRepositorySnapshot(params: PrepareRepositorySnapshotParams): Promise<SourceSnapshot> {
  if (!SHA_PATTERN.test(params.baseSha) || !SHA_PATTERN.test(params.headSha)) {
    throw new RepositoryPreparationError("baseSha and headSha must be resolved commit SHAs, not branch names");
  }

  const snapshotId = computeSnapshotId(params.repositoryId, params.baseSha, params.headSha);
  const snapshotPath = path.join(params.workspaceRoot, "snapshots", snapshotId);
  const markerPath = path.join(snapshotPath, SNAPSHOT_MARKER_FILE);

  if (!existsSync(markerPath)) {
    if (existsSync(snapshotPath)) {
      // Leftover from a prior failed/partial attempt — start clean rather
      // than trust a snapshot that never finished materializing.
      await rm(snapshotPath, { recursive: true, force: true });
    }
    await mkdir(snapshotPath, { recursive: true });

    await simpleGit().clone(params.cloneUrl, snapshotPath, ["--no-checkout"]);
    const repoGit = simpleGit(snapshotPath);

    await ensureCommitPresent(repoGit, params.headSha);
    await ensureCommitPresent(repoGit, params.baseSha);
    await repoGit.checkout(params.headSha);

    await writeFile(markerPath, new Date().toISOString());
    await makeReadOnlyRecursive(snapshotPath);
    await chmod(snapshotPath, 0o555).catch(() => undefined);
  }

  const repoGit = simpleGit(snapshotPath);
  const treeHash = (await repoGit.raw(["rev-parse", `${params.headSha}^{tree}`])).trim();
  const changedFiles = await computeChangedFiles(repoGit, params.baseSha, params.headSha);
  const submoduleIssues = await resolveSubmodules(repoGit, snapshotPath);

  const changedPaths = changedFiles.map((f) => f.path);
  const detectedLanguages = detectLanguagesFromPaths(changedPaths);
  const detectedFrameworks = await detectFrameworksFromManifest(snapshotPath);
  const sensitivePaths = findSensitivePaths(changedPaths, params.sensitivePathPatterns);

  return {
    snapshotId,
    snapshotPath,
    repositoryId: params.repositoryId,
    baseSha: params.baseSha,
    headSha: params.headSha,
    treeHash,
    changedFiles,
    detectedLanguages,
    detectedFrameworks,
    sensitivePaths,
    submoduleIssues,
    createdAt: new Date(),
  };
}

async function ensureCommitPresent(repoGit: SimpleGit, sha: string): Promise<void> {
  try {
    await repoGit.raw(["rev-parse", "--verify", `${sha}^{commit}`]);
    return;
  } catch {
    // fall through to fetch attempt below
  }
  try {
    await repoGit.fetch(["origin", sha]);
    await repoGit.raw(["rev-parse", "--verify", `${sha}^{commit}`]);
  } catch {
    throw new RepositoryPreparationError(`Commit ${sha} could not be resolved in the repository`);
  }
}

async function computeChangedFiles(repoGit: SimpleGit, baseSha: string, headSha: string): Promise<ChangedFile[]> {
  const raw = await repoGit.raw(["diff", "--name-status", "-M", baseSha, headSha]);
  const files: ChangedFile[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0]!;
    if (status.startsWith("R")) {
      files.push({ path: parts[2]!, previousPath: parts[1], changeType: "renamed" });
    } else if (status === "A") {
      files.push({ path: parts[1]!, changeType: "added" });
    } else if (status === "D") {
      files.push({ path: parts[1]!, changeType: "deleted" });
    } else {
      files.push({ path: parts[1]!, changeType: "modified" });
    }
  }
  return files;
}

async function resolveSubmodules(repoGit: SimpleGit, snapshotPath: string): Promise<SubmoduleIssue[]> {
  if (!existsSync(path.join(snapshotPath, ".gitmodules"))) {
    return [];
  }

  const issues: SubmoduleIssue[] = [];
  try {
    const status = await repoGit.raw(["submodule", "status"]);
    const submodulePaths = status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1])
      .filter((p): p is string => Boolean(p));

    for (const submodulePath of submodulePaths) {
      try {
        await repoGit.raw(["submodule", "update", "--init", "--depth", "1", submodulePath]);
      } catch (error) {
        issues.push({ path: submodulePath, reason: describeError(error) });
      }
    }
  } catch (error) {
    issues.push({ path: "*", reason: `Failed to enumerate submodules: ${describeError(error)}` });
  }
  return issues;
}

async function makeReadOnlyRecursive(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue; // git internals must stay writable for diff/rev-parse
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnlyRecursive(full);
      await chmod(full, 0o555).catch(() => undefined);
    } else {
      await chmod(full, 0o444).catch(() => undefined);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
