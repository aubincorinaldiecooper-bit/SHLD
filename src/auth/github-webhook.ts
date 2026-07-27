import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a GitHub webhook's `X-Hub-Signature-256` header against the raw
 * request body. Must run against the raw (unparsed) body — GitHub signs the
 * exact bytes it sent.
 */
export function verifyGithubWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const gotBuf = Buffer.from(signatureHeader.slice("sha256=".length), "utf8");
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}
