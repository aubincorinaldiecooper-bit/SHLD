import type { FindingStatus, SecurityRunStatus } from "@prisma/client";

export type ReceiptStatus = "passed" | "passed_with_findings" | "blocked" | "awaiting_fix" | "inconclusive" | "failed";

const BENIGN_FINDING_STATUSES: readonly FindingStatus[] = [
  "verified_fixed",
  "not_reproduced",
  "dismissed",
  "accepted_risk",
];

/**
 * By the time a run reaches `completed`, the run state machine has already
 * ruled out any unresolved blocking finding (that would have routed the
 * run to `blocked` or `awaiting_fix` instead) — so a completed run's
 * findings can only be benign or inconclusive, and this just distinguishes
 * "nothing to report" from "some open questions" from "resolved findings
 * on record".
 */
export function computeReceiptStatus(runStatus: SecurityRunStatus, findingStatuses: readonly FindingStatus[]): ReceiptStatus {
  if (runStatus === "failed") return "failed";
  if (runStatus === "cancelled") return "failed";
  if (runStatus === "blocked") return "blocked";
  if (runStatus === "awaiting_fix") return "awaiting_fix";

  if (findingStatuses.length === 0) return "passed";
  if (findingStatuses.some((s) => s === "inconclusive")) return "inconclusive";
  if (findingStatuses.every((s) => BENIGN_FINDING_STATUSES.includes(s))) return "passed_with_findings";
  return "passed_with_findings";
}
