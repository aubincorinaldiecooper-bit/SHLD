import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX_LENGTH = 12;
const KEY_PREFIX = "shld_";

export interface GeneratedApiKey {
  /** Shown to the caller exactly once — never persisted in plaintext. */
  raw: string;
  /** Safe to store/display for identification (e.g. "shld_a1b2c3d4"). */
  prefix: string;
  /** HMAC-SHA256(raw) using the server-side pepper — what actually gets stored. */
  hash: string;
}

function pepper(): string {
  const value = process.env.API_KEY_PEPPER;
  if (!value) {
    throw new Error("API_KEY_PEPPER is not configured");
  }
  return value;
}

export function hashApiKey(raw: string): string {
  return createHmac("sha256", pepper()).update(raw).digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(32).toString("base64url");
  const raw = `${KEY_PREFIX}${secret}`;
  return { raw, prefix: raw.slice(0, PREFIX_LENGTH), hash: hashApiKey(raw) };
}

export function isWellFormedApiKey(raw: string): boolean {
  return raw.startsWith(KEY_PREFIX) && raw.length > KEY_PREFIX.length + 16;
}

/** Constant-time comparison of two equal-length hex digests. */
export function safeCompareHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
