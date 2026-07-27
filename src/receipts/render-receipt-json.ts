import type { ReceiptData } from "./gather-receipt-data.js";
import type { ReceiptStatus } from "./receipt-status.js";

export interface ReceiptJson {
  run_id: string;
  organization: string;
  repository: string;
  pull_request: number | null;
  base_commit: string;
  head_commit: string;
  requesting_agent: { name: string; type: string };
  policy_version: string;
  run_type: string;
  status: ReceiptStatus;
  classification: ReceiptData["classification"];
  routing_decisions: ReceiptData["routingDecisions"];
  engines_used: Array<{ engine: string; engine_version: string | null; operation: string; status: string }>;
  findings: Array<{
    id: string;
    title: string;
    category: string;
    severity: string;
    confidence: string;
    status: string;
    discovery_engine: string;
    finding_class: string;
    source_evidence: ReceiptData["findings"][number]["sourceLocations"];
    runtime_evidence: ReceiptData["findings"][number]["validations"];
    fix_commit: string | null;
    source_revalidation_result: string | null;
    runtime_retest_result: string | null;
    final_status: string | null;
  }>;
  usage: { total_cost_usd: number; total_input_tokens: number; total_output_tokens: number };
  duration_ms: number | null;
  artifact_references: string[];
  audit_event_references: string[];
  timestamps: { created_at: string; started_at: string | null; completed_at: string | null };
  failure_reason: string | null;
  generated_at: string;
}

export function renderReceiptJson(data: ReceiptData, status: ReceiptStatus): ReceiptJson {
  return {
    run_id: data.runId,
    organization: data.organizationName,
    repository: `${data.repositoryOwner}/${data.repositoryName}`,
    pull_request: data.pullRequestNumber,
    base_commit: data.baseSha,
    head_commit: data.headSha,
    requesting_agent: { name: data.requestingAgentName, type: data.requestingAgentType },
    policy_version: data.policyVersion,
    run_type: data.runType,
    status,
    classification: data.classification,
    routing_decisions: data.routingDecisions,
    engines_used: data.engineExecutions.map((e) => ({
      engine: e.engine,
      engine_version: e.engineVersion,
      operation: e.operation,
      status: e.status,
    })),
    findings: data.findings.map((f) => ({
      id: f.id,
      title: f.title,
      category: f.category,
      severity: f.severity,
      confidence: f.confidence,
      status: f.status,
      discovery_engine: f.discoveryEngine,
      finding_class: f.findingClass,
      source_evidence: f.sourceLocations,
      runtime_evidence: f.validations,
      fix_commit: f.remediation?.fixCommitSha ?? null,
      source_revalidation_result: f.remediation?.sourceRevalidationStatus ?? null,
      runtime_retest_result: f.remediation?.runtimeRetestStatus ?? null,
      final_status: f.remediation?.finalStatus ?? null,
    })),
    usage: {
      total_cost_usd: data.totalCostUsd,
      total_input_tokens: data.totalInputTokens,
      total_output_tokens: data.totalOutputTokens,
    },
    duration_ms: data.durationMs,
    artifact_references: data.artifactIds,
    audit_event_references: data.auditEventIds,
    timestamps: {
      created_at: data.createdAt.toISOString(),
      started_at: data.startedAt?.toISOString() ?? null,
      completed_at: data.completedAt?.toISOString() ?? null,
    },
    failure_reason: data.failureReason,
    generated_at: new Date().toISOString(),
  };
}
