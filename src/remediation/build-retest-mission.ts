import type { StrixMission, StrixTestAccount } from "../adapters/strix/types.js";

export interface OriginalExploitEvidence {
  endpoint?: string | null;
  method?: string | null;
  evidenceSummary?: string | null;
}

export interface BuildRetestMissionParams {
  findingId: string;
  findingTitle: string;
  sourceFile: string;
  sourceLines?: string;
  targetBaseUrl: string;
  allowedScope: string[];
  excludedPaths: string[];
  testAccounts: StrixTestAccount[];
  destructiveTestingAllowed: boolean;
  originalEvidence: OriginalExploitEvidence;
}

/**
 * Builds the Strix replay mission for a fix retest. The hypothesis is
 * seeded from the original confirmed exploit's evidence and endpoint —
 * Strix is replaying a known exploit, not re-discovering one from scratch.
 */
export function buildRetestMission(params: BuildRetestMissionParams): StrixMission {
  const originalSummary = params.originalEvidence.evidenceSummary?.trim();
  const target = params.originalEvidence.endpoint
    ? `${params.originalEvidence.method ?? "GET"} ${params.originalEvidence.endpoint}`
    : "the previously confirmed endpoint";

  const hypothesis = [
    `Replay the original exploit for finding ${params.findingId} (${params.findingTitle}) against the patched build.`,
    originalSummary ? `Original confirmed evidence: ${originalSummary}` : undefined,
    `Original request: ${target}.`,
    "The fix is verified only if this exact exploit no longer succeeds.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    findingId: params.findingId,
    hypothesis,
    sourceFile: params.sourceFile,
    sourceLines: params.sourceLines,
    targetBaseUrl: params.targetBaseUrl,
    allowedScope: params.allowedScope,
    excludedPaths: params.excludedPaths,
    testAccounts: params.testAccounts,
    destructiveTestingAllowed: params.destructiveTestingAllowed,
    stopCondition: "Stop once the original exploit request has been retried against the patched build.",
  };
}
