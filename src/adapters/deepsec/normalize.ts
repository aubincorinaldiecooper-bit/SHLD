import type { FindingConfidence, FindingSeverity } from "@prisma/client";
import { DomainError } from "../../domain/errors.js";
import { computeFindingFingerprint, type FingerprintInput } from "../../correlation/fingerprint.js";
import type { DeepSecRawFinding } from "./types.js";

export { computeFindingFingerprint, type FingerprintInput };

export class DeepSecOutputError extends DomainError {}

const SEVERITY_MAP: Record<string, FindingSeverity> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  moderate: "medium",
  low: "low",
  info: "info",
  informational: "info",
};

const CONFIDENCE_MAP: Record<string, FindingConfidence> = {
  high: "high",
  medium: "medium",
  low: "low",
};

export function normalizeSeverity(raw: string): FindingSeverity {
  const mapped = SEVERITY_MAP[raw.trim().toLowerCase()];
  if (!mapped) throw new DeepSecOutputError(`Unrecognized DeepSec severity value: "${raw}"`);
  return mapped;
}

export function normalizeConfidence(raw: string): FindingConfidence {
  const mapped = CONFIDENCE_MAP[raw.trim().toLowerCase()];
  if (!mapped) throw new DeepSecOutputError(`Unrecognized DeepSec confidence value: "${raw}"`);
  return mapped;
}

export interface NormalizedFinding {
  title: string;
  description: string;
  category: string;
  cwe?: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  filePath: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  recommendation?: string;
  fingerprint: string;
  revalidationVerdict?: "true_positive" | "false_positive" | "unknown";
}

export function normalizeDeepSecFinding(raw: DeepSecRawFinding, repositoryId: string): NormalizedFinding {
  const severity = normalizeSeverity(raw.severity);
  const confidence = normalizeConfidence(raw.confidence);
  const fingerprint = computeFindingFingerprint({
    repositoryId,
    category: raw.category,
    filePath: raw.file_path,
    symbol: raw.symbol,
    title: raw.title,
  });
  return {
    title: raw.title,
    description: raw.description,
    category: raw.category,
    cwe: raw.cwe,
    severity,
    confidence,
    filePath: raw.file_path,
    startLine: raw.start_line,
    endLine: raw.end_line,
    symbol: raw.symbol,
    recommendation: raw.recommendation,
    fingerprint,
    revalidationVerdict: raw.revalidation_verdict,
  };
}
