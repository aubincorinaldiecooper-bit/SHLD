import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, isWellFormedApiKey, safeCompareHex } from "../../src/auth/api-keys.js";

describe("api keys", () => {
  it("generates a key whose stored hash matches re-hashing the raw value", () => {
    const key = generateApiKey();
    expect(key.raw.startsWith("shld_")).toBe(true);
    expect(hashApiKey(key.raw)).toBe(key.hash);
  });

  it("generates unique keys each call", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it("rejects malformed keys", () => {
    expect(isWellFormedApiKey("not-a-key")).toBe(false);
    expect(isWellFormedApiKey("shld_")).toBe(false);
    expect(isWellFormedApiKey(generateApiKey().raw)).toBe(true);
  });

  it("safeCompareHex matches equal hashes and rejects different ones", () => {
    const h1 = hashApiKey("a");
    const h2 = hashApiKey("a");
    const h3 = hashApiKey("b");
    expect(safeCompareHex(h1, h2)).toBe(true);
    expect(safeCompareHex(h1, h3)).toBe(false);
  });
});
