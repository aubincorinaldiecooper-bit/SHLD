import { describe, expect, it } from "vitest";
import { classifyChange } from "../../src/policy/change-classifier.js";

describe("classifyChange", () => {
  it("classifies a change with no sensitive paths as low risk, not security sensitive", () => {
    const result = classifyChange({
      changedFiles: [{ path: "src/components/Button.tsx", changeType: "modified" }],
    });
    expect(result).toMatchObject({
      riskLevel: "low",
      securitySensitive: false,
      categories: [],
      recommendedReview: "none",
      requiresPreviewTarget: false,
    });
  });

  it("matches the spec's worked example: authorization + tenant-isolation -> high", () => {
    const result = classifyChange({
      changedFiles: [
        { path: "src/api/projects/[id].ts", changeType: "modified" }, // api-surface
        { path: "src/middleware/authorization.ts", changeType: "modified" }, // authorization
        { path: "src/tenant/context.ts", changeType: "modified" }, // tenant-isolation
      ],
    });
    expect(result.securitySensitive).toBe(true);
    expect(result.categories).toEqual(expect.arrayContaining(["authorization", "tenant-isolation"]));
    expect(result.riskLevel).toBe("high");
    expect(result.recommendedReview).toBe("deepsec_diff");
    expect(result.requiresPreviewTarget).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("escalates to critical when secrets exposure combines with an auth category", () => {
    const result = classifyChange({
      changedFiles: [
        { path: "src/auth/login.ts", changeType: "modified" },
        { path: "config/secrets.env.ts", changeType: "modified" },
      ],
    });
    expect(result.categories).toEqual(expect.arrayContaining(["authentication", "secrets-exposure"]));
    expect(result.riskLevel).toBe("critical");
  });

  it("treats a dependency-manifest-only change as medium risk", () => {
    const result = classifyChange({
      changedFiles: [{ path: "package.json", changeType: "modified" }],
    });
    expect(result.categories).toEqual(["dependency-change"]);
    expect(result.securitySensitive).toBe(true);
    expect(result.riskLevel).toBe("medium");
    expect(result.requiresPreviewTarget).toBe(false);
  });

  it("escalates a normally-medium category to high when it has prior confirmed findings", () => {
    const result = classifyChange({
      changedFiles: [{ path: "src/api/reports.ts", changeType: "modified" }],
      previousFindingCategories: ["api-surface"],
    });
    expect(result.categories).toEqual(["api-surface"]);
    expect(result.riskLevel).toBe("high");
    expect(result.reasons.some((r) => r.includes("confirmed findings"))).toBe(true);
  });

  it("honors a repository-specific sensitive path override", () => {
    const result = classifyChange({
      changedFiles: [{ path: "src/legacy/proprietary_ranking_engine.ts", changeType: "modified" }],
      sensitivePathPatterns: ["proprietary_ranking"],
    });
    expect(result.categories).toEqual(["repository-policy"]);
    expect(result.securitySensitive).toBe(true);
    expect(result.riskLevel).toBe("medium");
  });

  it("never recommends a full repository audit", () => {
    const result = classifyChange({
      changedFiles: [{ path: "src/auth/login.ts", changeType: "modified" }],
    });
    expect(result.recommendedReview).not.toBe("deepsec_full");
  });
});
