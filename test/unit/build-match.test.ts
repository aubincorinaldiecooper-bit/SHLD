import { describe, expect, it } from "vitest";
import { commitMatchesBuild } from "../../src/correlation/build-match.js";

describe("commitMatchesBuild", () => {
  it("matches identical SHAs", () => {
    expect(commitMatchesBuild("abc123", "abc123")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(commitMatchesBuild("ABC123", "abc123")).toBe(true);
  });

  it("does not match different SHAs", () => {
    expect(commitMatchesBuild("abc123", "def456")).toBe(false);
  });

  it("treats an unknown/unresolved build as a mismatch (fail closed)", () => {
    expect(commitMatchesBuild("abc123", undefined)).toBe(false);
  });
});
