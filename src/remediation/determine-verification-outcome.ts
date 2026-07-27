export type VerificationOutcome =
  | "verified_fixed"
  | "still_exploitable"
  | "partially_fixed"
  | "inconclusive"
  | "verification_failed";

export interface DetermineVerificationOutcomeParams {
  /** null = the revalidation itself failed to produce a verdict (operational). */
  sourceRevalidationPassed: boolean | null;
  runtimeRetestRequired: boolean;
  /** Only meaningful when runtimeRetestRequired; null = not run or inconclusive. */
  runtimeRetestPassed: boolean | null;
  /** Only meaningful when runtimeRetestRequired. */
  targetBuildMatchesFixCommit: boolean;
  operationalFailure?: boolean;
}

/**
 * A runtime-confirmed finding can only become verified_fixed when the
 * source revalidation passes AND the patched target matched the fix
 * commit AND the original exploit no longer succeeds — an agent's claim
 * that a fix is complete is never sufficient on its own.
 */
export function determineVerificationOutcome(params: DetermineVerificationOutcomeParams): VerificationOutcome {
  if (params.operationalFailure) return "verification_failed";
  if (params.sourceRevalidationPassed === null) return "verification_failed";

  if (!params.runtimeRetestRequired) {
    return params.sourceRevalidationPassed ? "verified_fixed" : "still_exploitable";
  }

  if (!params.targetBuildMatchesFixCommit) return "inconclusive";
  if (params.runtimeRetestPassed === null) return "inconclusive";

  if (params.sourceRevalidationPassed && params.runtimeRetestPassed) return "verified_fixed";
  if (!params.sourceRevalidationPassed && !params.runtimeRetestPassed) return "still_exploitable";
  return "partially_fixed";
}
