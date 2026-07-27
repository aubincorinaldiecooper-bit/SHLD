import { createHash } from "node:crypto";

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
 * identity across runs instead of being treated as a new finding. Shared
 * across engines: a Strix-discovered dynamic finding and a DeepSec-discovered
 * source finding use the same algorithm so they can be recognized as the
 * same issue if they ever describe the same location.
 */
export function computeFindingFingerprint(input: FingerprintInput): string {
  const normalizedCategory = input.category.trim().toLowerCase();
  const normalizedTitle = input.title.trim().toLowerCase().replace(/\s+/g, " ");
  const parts = [input.repositoryId, normalizedCategory, input.filePath, input.symbol ?? "", normalizedTitle];
  return createHash("sha256").update(parts.join("::")).digest("hex");
}
