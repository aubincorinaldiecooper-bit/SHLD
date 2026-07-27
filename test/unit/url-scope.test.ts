import { describe, expect, it } from "vitest";
import { assertUrlWithinAuthorizedTarget, matchesAuthority } from "../../src/authz/url-scope.js";
import { TargetAuthorizationError } from "../../src/domain/errors.js";

const target = {
  baseUrl: "https://preview-184.example.com",
  allowedPaths: ["GET /api/projects/*"],
  excludedPaths: ["/api/projects/internal/*"],
};

describe("assertUrlWithinAuthorizedTarget", () => {
  it("allows an in-scope GET within the allowed path", () => {
    expect(() =>
      assertUrlWithinAuthorizedTarget("https://preview-184.example.com/api/projects/42", "GET", target),
    ).not.toThrow();
  });

  it("rejects a method not covered by the allow-list", () => {
    expect(() =>
      assertUrlWithinAuthorizedTarget("https://preview-184.example.com/api/projects/42", "DELETE", target),
    ).toThrow(TargetAuthorizationError);
  });

  it("rejects a path outside the allow-list", () => {
    expect(() =>
      assertUrlWithinAuthorizedTarget("https://preview-184.example.com/admin/users", "GET", target),
    ).toThrow(TargetAuthorizationError);
  });

  it("rejects an explicitly excluded path even if it would otherwise match", () => {
    expect(() =>
      assertUrlWithinAuthorizedTarget(
        "https://preview-184.example.com/api/projects/internal/42",
        "GET",
        target,
      ),
    ).toThrow(TargetAuthorizationError);
  });

  it("rejects a lookalike-suffix host (authorized.com.evil.com)", () => {
    expect(() =>
      assertUrlWithinAuthorizedTarget("https://preview-184.example.com.evil.com/api/projects/1", "GET", target),
    ).toThrow(TargetAuthorizationError);
  });

  it("rejects a userinfo trick (authorized-looking userinfo, different real host)", () => {
    expect(() =>
      assertUrlWithinAuthorizedTarget(
        "https://preview-184.example.com@evil.com/api/projects/1",
        "GET",
        target,
      ),
    ).toThrow(TargetAuthorizationError);
  });

  it("rejects a different port on an otherwise-matching host", () => {
    expect(() =>
      assertUrlWithinAuthorizedTarget("https://preview-184.example.com:8443/api/projects/1", "GET", target),
    ).toThrow(TargetAuthorizationError);
  });

  it("rejects a scheme downgrade to http", () => {
    expect(() =>
      assertUrlWithinAuthorizedTarget("http://preview-184.example.com/api/projects/1", "GET", target),
    ).toThrow(TargetAuthorizationError);
  });

  it("rejects a non-http(s) protocol", () => {
    expect(() =>
      assertUrlWithinAuthorizedTarget("file:///etc/passwd", "GET", {
        baseUrl: "file:///etc/passwd",
        allowedPaths: [],
        excludedPaths: [],
      }),
    ).toThrow(TargetAuthorizationError);
  });

  it("rejects a malformed URL", () => {
    expect(() => assertUrlWithinAuthorizedTarget("not a url", "GET", target)).toThrow(TargetAuthorizationError);
  });

  it("allows any path when no allow-list is configured (open scope)", () => {
    expect(() =>
      assertUrlWithinAuthorizedTarget("https://preview-184.example.com/anything", "GET", {
        baseUrl: "https://preview-184.example.com",
        allowedPaths: [],
        excludedPaths: [],
      }),
    ).not.toThrow();
  });
});

describe("matchesAuthority", () => {
  it("treats default https port and explicit :443 as equal", () => {
    const a = new URL("https://example.com/path");
    const b = new URL("https://example.com:443/path");
    expect(matchesAuthority(a, b)).toBe(true);
  });
});
