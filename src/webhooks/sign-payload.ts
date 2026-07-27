import { createHmac, timingSafeEqual } from "node:crypto";

/** Signs an outbound webhook payload the same way GitHub signs inbound ones: HMAC-SHA256, hex-encoded. */
export function signWebhookPayload(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export function verifyWebhookSignature(payload: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expected = signWebhookPayload(payload, secret);
  const expectedBuf = Buffer.from(expected);
  const gotBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}
