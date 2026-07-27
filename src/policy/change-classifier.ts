import { findSensitivePaths } from "./sensitive-patterns.js";

export type RiskLevel = "critical" | "high" | "medium" | "low";
export type RecommendedReview = "none" | "deepsec_diff";

export interface ClassifyChangeFileInput {
  path: string;
  changeType: string;
}

export interface ClassifyChangeInput {
  changedFiles: readonly ClassifyChangeFileInput[];
  /** Repository-specific override of the default sensitive-path patterns. */
  sensitivePathPatterns?: readonly string[];
  /** Categories with prior confirmed findings in this repository — recurrence raises risk regardless of tier. */
  previousFindingCategories?: readonly string[];
}

export interface ChangeClassification {
  riskLevel: RiskLevel;
  securitySensitive: boolean;
  categories: string[];
  recommendedReview: RecommendedReview;
  requiresPreviewTarget: boolean;
  reasons: string[];
}

// Deterministic path-pattern -> category mapping. Full repository audits are
// never recommended here (they must stay an explicit operation per the
// spec) — this classifier only ever recommends the change-scoped review.
const CATEGORY_PATTERNS: Record<string, readonly string[]> = {
  authentication: ["auth", "authentication", "login", "session"],
  authorization: ["authorization", "permission", "role", "middleware", "admin", "polic"],
  "tenant-isolation": ["tenant", "organization", "workspace"],
  "payment-manipulation": ["billing", "payment", "invoice", "checkout"],
  "file-handling": ["upload", "file", "attachment"],
  "secrets-exposure": ["secret", "credential", "environment", "apikey", "api_key"],
  infrastructure: ["infra", "deploy", "docker", "kubernetes", "terraform"],
  deserialization: ["deserializ", "unmarshal", "pickle"],
  webhooks: ["webhook"],
  "background-jobs": ["job", "queue", "worker", "cron"],
  "api-surface": ["api", "route", "endpoint", "controller"],
  "data-access": ["database", "migration", "schema", "repository"],
};

const DEPENDENCY_MANIFEST_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "pipfile.lock",
  "poetry.lock",
  "gemfile.lock",
  "go.sum",
  "go.mod",
  "cargo.lock",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "composer.lock",
]);

// Checked in this order per file, and the first match wins — several
// patterns are substrings of each other (e.g. "auth" inside
// "authorization"), so exclusive priority matching avoids double-counting a
// single file into multiple categories and inflating the risk level.
const CATEGORY_PRIORITY: readonly string[] = [
  "secrets-exposure",
  "payment-manipulation",
  "authorization",
  "authentication",
  "tenant-isolation",
  "deserialization",
  "webhooks",
  "background-jobs",
  "infrastructure",
  "file-handling",
  "data-access",
  "api-surface",
];

const HIGH_RISK_CATEGORIES = new Set([
  "authentication",
  "authorization",
  "tenant-isolation",
  "payment-manipulation",
  "secrets-exposure",
  "deserialization",
]);

/**
 * Deterministic, rule-based change classifier — no LLM in the loop. Every
 * output is traceable to a specific matched path or a specific prior
 * finding, which is what `reasons` records.
 */
export function classifyChange(input: ClassifyChangeInput): ChangeClassification {
  const categoryHits = new Map<string, string[]>();

  const recordHit = (category: string, filePath: string) => {
    const files = categoryHits.get(category) ?? [];
    if (!files.includes(filePath)) files.push(filePath);
    categoryHits.set(category, files);
  };

  for (const file of input.changedFiles) {
    const lower = file.path.toLowerCase();
    for (const category of CATEGORY_PRIORITY) {
      const patterns = CATEGORY_PATTERNS[category]!;
      if (patterns.some((pattern) => lower.includes(pattern))) {
        recordHit(category, file.path);
        break; // one file contributes to at most one pattern-derived category
      }
    }
    const basename = lower.split("/").pop() ?? lower;
    if (DEPENDENCY_MANIFEST_BASENAMES.has(basename)) {
      recordHit("dependency-change", file.path);
    }
  }

  if (input.sensitivePathPatterns && input.sensitivePathPatterns.length > 0) {
    const hits = findSensitivePaths(
      input.changedFiles.map((f) => f.path),
      input.sensitivePathPatterns,
    );
    for (const hit of hits) {
      recordHit("repository-policy", hit);
    }
  }

  const previousCategories = new Set(input.previousFindingCategories ?? []);
  const categories = [...categoryHits.keys()];
  const securitySensitive = categories.length > 0;

  const reasons: string[] = [];
  for (const category of categories) {
    const example = categoryHits.get(category)![0];
    reasons.push(`The change touches a "${category}"-sensitive path (${example}).`);
    if (previousCategories.has(category)) {
      reasons.push(`This repository has confirmed findings in the "${category}" category before.`);
    }
  }
  if (reasons.length === 0) {
    reasons.push("No changed file paths matched a configured sensitive-path pattern.");
  }

  const highHits = categories.filter((c) => HIGH_RISK_CATEGORIES.has(c) || previousCategories.has(c));

  let riskLevel: RiskLevel;
  if (!securitySensitive) {
    riskLevel = "low";
  } else if (highHits.length === 0) {
    riskLevel = "medium";
  } else {
    const hasSecrets = categories.includes("secrets-exposure");
    const hasAuthCombo = categories.includes("authentication") || categories.includes("authorization");
    riskLevel = highHits.length >= 3 || (hasSecrets && hasAuthCombo) ? "critical" : "high";
  }

  const recommendedReview: RecommendedReview = securitySensitive ? "deepsec_diff" : "none";
  const requiresPreviewTarget = riskLevel === "critical" || riskLevel === "high";

  return { riskLevel, securitySensitive, categories, recommendedReview, requiresPreviewTarget, reasons };
}
