import { createHash } from "node:crypto";
import type { FindingConfidence, FindingSeverity } from "@prisma/client";
import { DomainError } from "../../domain/errors.js";
import type { DeepSecRawFinding } from "./types.js";

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

export interface FingerprintInput {
  repositoryId: string;
  category: string;
  filePath: string;
  symbol?: string;
  title: string;
}

/**
 * repository + normalized category + file path + symbol (when available) +
 * normalized title. Deliberately excludes line numbers so a finding that
 * survives a refactor (lines shift, the vulnerable logic doesn't) keeps its
 * identity across runs instead of being treated as a new finding.
 */
export function computeFindingFingerprint(input: FingerprintInput): string {
  const normalizedCategory = input.category.trim().toLowerCase();
  const normalizedTitle = input.title.trim().toLowerCase().replace(/\s+/g, " ");
  const parts = [input.repositoryId, normalizedCategory, input.filePath, input.symbol ?? "", normalizedTitle];
  return createHash("sha256").update(parts.join("::")).digest("hex");
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
