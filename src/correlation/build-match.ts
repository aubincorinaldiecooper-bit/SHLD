/**
 * A "target build" is treated as the commit SHA a preview/staging
 * deployment was built from. Runtime evidence only counts as conclusive
 * when it was gathered against the exact commit under review.
 */
export function commitMatchesBuild(expectedCommitSha: string, actualTargetBuildId: string | undefined): boolean {
  if (!actualTargetBuildId) return false;
  return expectedCommitSha.trim().toLowerCase() === actualTargetBuildId.trim().toLowerCase();
}
