import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../domain/errors.js";

export interface ReceiptSourceLocation {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
}

export interface ReceiptValidation {
  status: string;
  endpoint: string | null;
  method: string | null;
  evidenceSummary: string | null;
  targetBuildId: string | null;
  proofArtifactId: string | null;
  validatedAt: Date | null;
}

export interface ReceiptRemediation {
  fixCommitSha: string;
  sourceRevalidationStatus: string;
  runtimeRetestStatus: string;
  regressionTestStatus: string;
  finalStatus: string;
}

export interface ReceiptFinding {
  id: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  confidence: string;
  status: string;
  discoveryEngine: string;
  findingClass: string;
  sourceLocations: ReceiptSourceLocation[];
  validations: ReceiptValidation[];
  remediation: ReceiptRemediation | null;
}

export interface ReceiptEngineExecution {
  engine: string;
  operation: string;
  status: string;
  engineVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  outputArtifactId: string | null;
  failureReason: string | null;
}

export interface ReceiptRoutingDecision {
  findingId: string | null;
  escalate: boolean;
  reason: string;
  policyVersion: string;
}

export interface ReceiptData {
  runId: string;
  organizationId: string;
  organizationName: string;
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber: number | null;
  baseSha: string;
  headSha: string;
  runType: string;
  runStatus: string;
  requestingAgentName: string;
  requestingAgentType: string;
  policyVersion: string;
  classification: {
    riskLevel: string;
    securitySensitive: boolean;
    categories: string[];
    recommendedReview: string;
    requiresPreviewTarget: boolean;
    reasons: string[];
  } | null;
  routingDecisions: ReceiptRoutingDecision[];
  engineExecutions: ReceiptEngineExecution[];
  findings: ReceiptFinding[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number | null;
  artifactIds: string[];
  auditEventIds: string[];
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
}

/** Assembles everything a receipt needs from a run's id — pure reads, no writes. */
export async function gatherReceiptData(prisma: PrismaClient, runId: string): Promise<ReceiptData> {
  const run = await prisma.securityRun.findUnique({
    where: { id: runId },
    include: {
      organization: true,
      repository: true,
      requestedByAgent: true,
      classification: true,
      routingDecisions: true,
      engineExecutions: true,
      artifacts: true,
      auditEvents: true,
    },
  });
  if (!run) {
    throw new NotFoundError(`Security run ${runId} not found`);
  }

  // A finding is "part of this run" if any audit event during the run
  // referenced it — every finding-touching persistence path in this
  // codebase records the run id on its audit events.
  const findingIds = [...new Set(run.auditEvents.map((e) => e.findingId).filter((id): id is string => Boolean(id)))];
  const findings = findingIds.length
    ? await prisma.finding.findMany({
        where: { id: { in: findingIds } },
        include: { sourceLocations: true, validations: true, remediation: true },
      })
    : [];

  const totalCostUsd = run.engineExecutions.reduce((sum, e) => sum + Number(e.estimatedCostUsd ?? 0), 0);
  const totalInputTokens = run.engineExecutions.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0);
  const totalOutputTokens = run.engineExecutions.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0);
  const durationMs = run.startedAt && run.completedAt ? run.completedAt.getTime() - run.startedAt.getTime() : null;

  return {
    runId: run.id,
    organizationId: run.organizationId,
    organizationName: run.organization.name,
    repositoryOwner: run.repository.owner,
    repositoryName: run.repository.name,
    pullRequestNumber: run.pullRequestNumber,
    baseSha: run.baseSha,
    headSha: run.headSha,
    runType: run.runType,
    runStatus: run.status,
    requestingAgentName: run.requestedByAgent.name,
    requestingAgentType: run.requestedByAgent.type,
    policyVersion: run.policyVersion,
    classification: run.classification
      ? {
          riskLevel: run.classification.riskLevel,
          securitySensitive: run.classification.securitySensitive,
          categories: run.classification.categories,
          recommendedReview: run.classification.recommendedReview,
          requiresPreviewTarget: run.classification.requiresPreviewTarget,
          reasons: run.classification.reasons,
        }
      : null,
    routingDecisions: run.routingDecisions.map((d) => ({
      findingId: d.findingId,
      escalate: d.escalate,
      reason: d.reason,
      policyVersion: d.policyVersion,
    })),
    engineExecutions: run.engineExecutions.map((e) => ({
      engine: e.engine,
      operation: e.operation,
      status: e.status,
      engineVersion: e.engineVersion,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      estimatedCostUsd: e.estimatedCostUsd ? Number(e.estimatedCostUsd) : null,
      startedAt: e.startedAt,
      completedAt: e.completedAt,
      outputArtifactId: e.outputArtifactId,
      failureReason: e.failureReason,
    })),
    findings: findings.map((f) => ({
      id: f.id,
      title: f.title,
      description: f.description,
      category: f.category,
      severity: f.severity,
      confidence: f.confidence,
      status: f.status,
      discoveryEngine: f.discoveryEngine,
      findingClass: f.findingClass,
      sourceLocations: f.sourceLocations.map((l) => ({
        filePath: l.filePath,
        startLine: l.startLine,
        endLine: l.endLine,
        symbol: l.symbol,
      })),
      validations: f.validations.map((v) => ({
        status: v.status,
        endpoint: v.endpoint,
        method: v.method,
        evidenceSummary: v.evidenceSummary,
        targetBuildId: v.targetBuildId,
        proofArtifactId: v.proofArtifactId,
        validatedAt: v.validatedAt,
      })),
      remediation: f.remediation
        ? {
            fixCommitSha: f.remediation.fixCommitSha,
            sourceRevalidationStatus: f.remediation.sourceRevalidationStatus,
            runtimeRetestStatus: f.remediation.runtimeRetestStatus,
            regressionTestStatus: f.remediation.regressionTestStatus,
            finalStatus: f.remediation.finalStatus,
          }
        : null,
    })),
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    durationMs,
    artifactIds: run.artifacts.map((a) => a.id),
    auditEventIds: run.auditEvents.map((a) => a.id),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    failureReason: run.failureReason,
  };
}
