/**
 * Initial sensitive-path patterns from the spec. Matched as case-insensitive
 * substrings against a changed file's path — deliberately coarse (a stem
 * like "auth" also catches "authentication", "unauthorized", etc.).
 * Configurable per repository via RepositoryPolicyConfig.sensitivePathPatterns.
 */
export const DEFAULT_SENSITIVE_PATH_PATTERNS: readonly string[] = [
  "auth",
  "authentication",
  "authorization",
  "permission",
  "role",
  "middleware",
  "api",
  "route",
  "billing",
  "payment",
  "upload",
  "file",
  "admin",
  "database",
  "polic", // policy / policies
  "secret",
  "environment",
  "infra",
  "deserializ",
  "webhook",
  "job", // background jobs
  "queue",
];

export function isSensitivePath(filePath: string, patterns: readonly string[] = DEFAULT_SENSITIVE_PATH_PATTERNS): boolean {
  const lower = filePath.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

export function findSensitivePaths(
  paths: readonly string[],
  patterns: readonly string[] = DEFAULT_SENSITIVE_PATH_PATTERNS,
): string[] {
  return paths.filter((p) => isSensitivePath(p, patterns));
}
