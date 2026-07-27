import type { ReceiptData, ReceiptFinding } from "./gather-receipt-data.js";
import type { ReceiptStatus } from "./receipt-status.js";

const STATUS_LABELS: Record<ReceiptStatus, string> = {
  passed: "Passed",
  passed_with_findings: "Passed (with findings)",
  blocked: "Blocked",
  awaiting_fix: "Awaiting fix",
  inconclusive: "Inconclusive",
  failed: "Failed",
};

function describeDiscovery(finding: ReceiptFinding): string {
  const lines = [finding.discoveryEngine === "deepsec" ? "DeepSec" : "Strix"];
  if (finding.discoveryEngine === "deepsec") {
    lines.push(`${finding.confidence[0]!.toUpperCase()}${finding.confidence.slice(1)}-confidence source finding`);
  } else {
    lines.push(`Dynamically discovered (${finding.findingClass})`);
  }
  return lines.join("\n");
}

function describeRuntimeValidation(finding: ReceiptFinding): string | undefined {
  const validation = finding.validations.at(-1);
  if (!validation) return undefined;
  const verdictText: Record<string, string> = {
    confirmed: "Exploit confirmed",
    not_reproduced: "Exploit not reproduced",
    inconclusive: "Inconclusive",
    failed: "Validation failed",
  };
  const target = validation.targetBuildId ? ` against build ${validation.targetBuildId}` : "";
  return `Strix\n${verdictText[validation.status] ?? validation.status}${target}`;
}

function describeFix(finding: ReceiptFinding): string[] {
  if (!finding.remediation) return [];
  const r = finding.remediation;
  const lines: string[] = [];
  lines.push("Fix:", `Commit ${r.fixCommitSha}`, "");
  lines.push("Source revalidation:", capitalize(r.sourceRevalidationStatus), "");
  if (r.runtimeRetestStatus !== "not_applicable") {
    const passed = r.runtimeRetestStatus === "passed";
    lines.push(
      "Exploit replay:",
      `${capitalize(r.runtimeRetestStatus)}${passed ? " — original exploit no longer succeeds" : ""}`,
      "",
    );
  }
  lines.push("Final decision:", humanizeFinalStatus(r.finalStatus), "");
  return lines;
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1).replace(/_/g, " ") : s;
}

function humanizeFinalStatus(status: string): string {
  const map: Record<string, string> = {
    verified_fixed: "Verified fixed",
    still_exploitable: "Still exploitable",
    partially_fixed: "Partially fixed",
    inconclusive: "Inconclusive",
    verification_failed: "Verification failed",
    pending: "Pending",
  };
  return map[status] ?? status;
}

/** Renders the receipt in the spec's worked example shape, generalized to any number of findings. */
export function renderReceiptMarkdown(data: ReceiptData, status: ReceiptStatus): string {
  const lines: string[] = [];

  lines.push("Security Verification Receipt", "");
  lines.push(`Repository: ${data.repositoryOwner}/${data.repositoryName}`);
  if (data.pullRequestNumber) lines.push(`Pull request: #${data.pullRequestNumber}`);
  lines.push(`Base commit: ${data.baseSha}`);
  lines.push(`Head commit: ${data.headSha}`);
  lines.push(`Requesting agent: ${data.requestingAgentName}`);
  lines.push(`Policy version: ${data.policyVersion}`);
  lines.push(`Status: ${STATUS_LABELS[status]}`, "");

  if (data.classification) {
    lines.push(
      `Classification: ${data.classification.riskLevel} risk` +
        (data.classification.categories.length ? ` (${data.classification.categories.join(", ")})` : ""),
      "",
    );
  }

  if (data.routingDecisions.length > 0) {
    lines.push("Routing decisions:");
    for (const decision of data.routingDecisions) {
      lines.push(`- ${decision.escalate ? "Escalated" : "Not escalated"}: ${decision.reason}`);
    }
    lines.push("");
  }

  if (data.findings.length === 0) {
    lines.push("No findings were raised against this change.", "");
  }

  for (const finding of data.findings) {
    lines.push("Finding:", finding.title, "");
    lines.push("Discovery:", describeDiscovery(finding), "");
    const runtime = describeRuntimeValidation(finding);
    if (runtime) lines.push("Runtime validation:", runtime, "");
    lines.push(...describeFix(finding));
  }

  lines.push("Engines used:");
  for (const engine of data.engineExecutions) {
    lines.push(`- ${engine.engine} (${engine.engineVersion ?? "unknown version"}) — ${engine.operation}: ${engine.status}`);
  }
  lines.push("");

  lines.push("Usage:");
  lines.push(`- Cost: $${data.totalCostUsd.toFixed(4)}`);
  lines.push(`- Tokens: ${data.totalInputTokens} in / ${data.totalOutputTokens} out`);
  if (data.durationMs !== null) lines.push(`- Duration: ${(data.durationMs / 1000).toFixed(1)}s`);
  lines.push("");

  if (data.artifactIds.length > 0) {
    lines.push(`Artifacts: ${data.artifactIds.length} referenced (${data.artifactIds.join(", ")})`, "");
  }
  lines.push(`Audit trail: ${data.auditEventIds.length} events recorded`, "");

  if (data.failureReason) {
    lines.push(`Failure reason: ${data.failureReason}`, "");
  }

  return lines.join("\n").trimEnd() + "\n";
}
