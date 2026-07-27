import { describe, expect, it } from "vitest";
import { renderReceiptMarkdown } from "../../src/receipts/render-receipt-markdown.js";
import type { ReceiptData } from "../../src/receipts/gather-receipt-data.js";

function baseData(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    runId: "run_123",
    organizationId: "org_1",
    organizationName: "Acme",
    repositoryOwner: "company",
    repositoryName: "application",
    pullRequestNumber: 184,
    baseSha: "abc123",
    headSha: "def456",
    runType: "change_review",
    runStatus: "completed",
    requestingAgentName: "Claude Code",
    requestingAgentType: "api",
    policyVersion: "2026-01-01",
    classification: null,
    routingDecisions: [],
    engineExecutions: [],
    findings: [],
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    durationMs: null,
    artifactIds: [],
    auditEventIds: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    startedAt: null,
    completedAt: null,
    failureReason: null,
    ...overrides,
  };
}

describe("renderReceiptMarkdown", () => {
  it("matches the spec's worked example shape for a verified-fixed runtime-confirmed finding", () => {
    const data = baseData({
      findings: [
        {
          id: "finding_1",
          title: "Cross-tenant project access",
          description: "desc",
          category: "authorization",
          severity: "high",
          confidence: "high",
          status: "verified_fixed",
          discoveryEngine: "deepsec",
          findingClass: "source",
          sourceLocations: [],
          validations: [
            {
              status: "confirmed",
              endpoint: "/api/projects/42",
              method: "GET",
              evidenceSummary: "evidence",
              targetBuildId: "preview-184-a",
              proofArtifactId: null,
              validatedAt: null,
            },
          ],
          remediation: {
            fixCommitSha: "ghi789",
            sourceRevalidationStatus: "passed",
            runtimeRetestStatus: "passed",
            regressionTestStatus: "not_applicable",
            finalStatus: "verified_fixed",
          },
        },
      ],
    });

    const markdown = renderReceiptMarkdown(data, "passed_with_findings");

    expect(markdown).toContain("Security Verification Receipt");
    expect(markdown).toContain("Repository: company/application");
    expect(markdown).toContain("Pull request: #184");
    expect(markdown).toContain("Requesting agent: Claude Code");
    expect(markdown).toContain("Cross-tenant project access");
    expect(markdown).toContain("DeepSec");
    expect(markdown).toContain("High-confidence source finding");
    expect(markdown).toContain("Strix");
    expect(markdown).toContain("Exploit confirmed against build preview-184-a");
    expect(markdown).toContain("Commit ghi789");
    expect(markdown).toContain("Source revalidation:\nPassed");
    expect(markdown).toContain("Exploit replay:\nPassed — original exploit no longer succeeds");
    expect(markdown).toContain("Final decision:\nVerified fixed");
  });

  it("reports no findings clearly when the change is clean", () => {
    const markdown = renderReceiptMarkdown(baseData(), "passed");
    expect(markdown).toContain("No findings were raised against this change.");
    expect(markdown).toContain("Status: Passed");
  });

  it("includes usage, engines, and audit trail counts", () => {
    const data = baseData({
      engineExecutions: [
        {
          engine: "deepsec",
          operation: "change_review",
          status: "completed",
          engineVersion: "1.2.3",
          inputTokens: 1000,
          outputTokens: 500,
          estimatedCostUsd: 0.12,
          startedAt: null,
          completedAt: null,
          outputArtifactId: "artifact_1",
          failureReason: null,
        },
      ],
      totalCostUsd: 0.12,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      durationMs: 4500,
      auditEventIds: ["evt_1", "evt_2"],
    });
    const markdown = renderReceiptMarkdown(data, "passed");
    expect(markdown).toContain("deepsec (1.2.3) — change_review: completed");
    expect(markdown).toContain("Cost: $0.1200");
    expect(markdown).toContain("Tokens: 1000 in / 500 out");
    expect(markdown).toContain("Duration: 4.5s");
    expect(markdown).toContain("Audit trail: 2 events recorded");
  });

  it("surfaces a blocked status and a still-exploitable outcome", () => {
    const data = baseData({
      findings: [
        {
          id: "finding_1",
          title: "IDOR",
          description: "d",
          category: "authorization",
          severity: "high",
          confidence: "high",
          status: "still_exploitable",
          discoveryEngine: "deepsec",
          findingClass: "source",
          sourceLocations: [],
          validations: [],
          remediation: {
            fixCommitSha: "abc111",
            sourceRevalidationStatus: "failed",
            runtimeRetestStatus: "not_applicable",
            regressionTestStatus: "not_applicable",
            finalStatus: "still_exploitable",
          },
        },
      ],
    });
    const markdown = renderReceiptMarkdown(data, "blocked");
    expect(markdown).toContain("Status: Blocked");
    expect(markdown).toContain("Final decision:\nStill exploitable");
  });
});
