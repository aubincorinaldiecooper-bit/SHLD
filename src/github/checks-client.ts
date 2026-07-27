import type { SecurityRunStatus } from "@prisma/client";
import type { ReceiptStatus } from "../receipts/receipt-status.js";

export type CheckRunState = "queued" | "in_progress" | "completed";
export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "action_required"
  | "timed_out";

export interface CheckRunUpdate {
  status: CheckRunState;
  conclusion?: CheckRunConclusion;
  title: string;
  summary: string;
}

/**
 * Maps platform run status (and, once available, receipt status) to the
 * GitHub check phases the spec lists. Consulting receiptStatus lets
 * "Inconclusive" surface distinctly from a bare "completed".
 */
export function mapRunStatusToCheckRun(runStatus: SecurityRunStatus, receiptStatus?: ReceiptStatus): CheckRunUpdate {
  switch (runStatus) {
    case "queued":
    case "classifying":
      return { status: "queued", title: "Security review queued", summary: "Waiting to start." };
    case "source_review_running":
      return { status: "in_progress", title: "Source review running", summary: "DeepSec is reviewing the change." };
    case "source_review_completed":
      return { status: "in_progress", title: "Source review completed", summary: "Evaluating routing policy." };
    case "validation_waiting_for_target":
      return {
        status: "in_progress",
        title: "Runtime validation waiting for preview",
        summary: "Waiting for an authorized preview/staging target.",
      };
    case "validation_running":
      return { status: "in_progress", title: "Runtime validation running", summary: "Strix is validating a finding." };
    case "awaiting_fix":
      return {
        status: "completed",
        conclusion: "action_required",
        title: "Fix verification required",
        summary: "A confirmed finding needs a fix commit.",
      };
    case "fix_verification_running":
      return { status: "in_progress", title: "Fix verification running", summary: "Revalidating the submitted fix." };
    case "completed":
      if (receiptStatus === "inconclusive") {
        return { status: "completed", conclusion: "neutral", title: "Inconclusive", summary: "Verification could not reach a conclusive result." };
      }
      return { status: "completed", conclusion: "success", title: "Passed", summary: "Security review passed." };
    case "blocked":
      return { status: "completed", conclusion: "failure", title: "Blocked", summary: "A confirmed exploitable finding blocks this change." };
    case "failed":
      return { status: "completed", conclusion: "failure", title: "Failed", summary: "The security review failed to complete." };
    case "cancelled":
      return { status: "completed", conclusion: "cancelled", title: "Cancelled", summary: "The security review was cancelled." };
  }
}

export interface UpdateCheckRunParams {
  owner: string;
  repo: string;
  headSha: string;
  runId: string;
  runStatus: SecurityRunStatus;
  receiptStatus?: ReceiptStatus;
  /** Absolute URL to the run/receipt detail — the check always links back here. */
  detailsUrl: string;
}

export interface GitHubChecksClient {
  upsertCheckRun(params: UpdateCheckRunParams): Promise<void>;
}

/**
 * Real GitHub Checks API implementation. Not exercised against live
 * GitHub in this environment (no App credentials/network here) —
 * mapRunStatusToCheckRun is unit tested in isolation, and this class is
 * covered by an interface-conformance test using a mock.
 */
export class RestGitHubChecksClient implements GitHubChecksClient {
  constructor(private readonly getInstallationToken: (owner: string, repo: string) => Promise<string>) {}

  async upsertCheckRun(params: UpdateCheckRunParams): Promise<void> {
    const token = await this.getInstallationToken(params.owner, params.repo);
    const update = mapRunStatusToCheckRun(params.runStatus, params.receiptStatus);

    const response = await fetch(`https://api.github.com/repos/${params.owner}/${params.repo}/check-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        name: "SHLD Security Review",
        head_sha: params.headSha,
        status: update.status,
        conclusion: update.conclusion,
        details_url: params.detailsUrl,
        external_id: params.runId,
        output: { title: update.title, summary: update.summary },
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update GitHub check run: ${response.status} ${await response.text()}`);
    }
  }
}
