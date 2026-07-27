import type { FindingStatus } from "@prisma/client";
import type { StrixVerdict } from "../adapters/strix/types.js";

export interface ResolveFindingStatusParams {
  verdict: StrixVerdict;
  buildMatches: boolean;
  testComplete: boolean;
}

/**
 * The correlation engine's conflict rules for a Strix validation of an
 * existing (DeepSec-sourced) finding:
 *
 *  - A build mismatch or an incomplete test can never produce a conclusive
 *    confirmed/not_reproduced verdict — both collapse to `inconclusive`
 *    regardless of what Strix itself reported, because the evidence
 *    doesn't actually speak to the commit under review.
 *  - `failed` is an operational outcome, not evidence either way, and
 *    never touches finding state — the caller should leave the finding as
 *    is and let the job retry.
 */
export function resolveFindingStatusFromValidation(params: ResolveFindingStatusParams): FindingStatus | null {
  if (params.verdict === "failed") return null;
  if (!params.buildMatches) return "inconclusive";
  if (!params.testComplete) return "inconclusive";

  switch (params.verdict) {
    case "confirmed":
      return "confirmed";
    case "not_reproduced":
      return "not_reproduced";
    case "inconclusive":
      return "inconclusive";
  }
}
