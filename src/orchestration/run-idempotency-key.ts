import { createHash } from "node:crypto";

export interface RunIdempotencyKeyParams {
  organizationId: string;
  repositoryId: string;
  baseSha: string;
  headSha: string;
  runType: string;
  policyVersion: string;
}

/**
 * organization + repository + head commit + base commit + operation +
 * policy version. Engine version is deliberately excluded here (it's not
 * known until the engine actually runs) — it's folded into the job-level
 * idempotency key computed at enqueue time instead, matching the spec's
 * "source review" idempotency formula at the point where it's actually
 * known.
 */
export function computeRunIdempotencyKey(params: RunIdempotencyKeyParams): string {
  const parts = [
    params.organizationId,
    params.repositoryId,
    params.headSha.toLowerCase(),
    params.baseSha.toLowerCase(),
    params.runType,
    params.policyVersion,
  ];
  return createHash("sha256").update(parts.join("::")).digest("hex");
}

export interface ValidationIdempotencyKeyParams {
  findingFingerprint: string;
  targetBuildId: string;
  targetEnvironmentId: string;
  validationPolicyVersion: string;
  engineVersion: string;
}

/**
 * finding fingerprint + target build identifier + target environment +
 * validation policy version + engine version, per the spec's runtime
 * validation idempotency formula.
 */
export function computeValidationIdempotencyKey(params: ValidationIdempotencyKeyParams): string {
  const parts = [
    params.findingFingerprint,
    params.targetBuildId,
    params.targetEnvironmentId,
    params.validationPolicyVersion,
    params.engineVersion,
  ];
  return createHash("sha256").update(parts.join("::")).digest("hex");
}
