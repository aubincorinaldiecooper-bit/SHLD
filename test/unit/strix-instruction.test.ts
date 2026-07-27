import { describe, expect, it } from "vitest";
import { buildStrixInstruction } from "../../src/adapters/strix/build-instruction.js";
import type { StrixMission } from "../../src/adapters/strix/types.js";

const mission: StrixMission = {
  findingId: "finding_123",
  hypothesis:
    "A standard user may retrieve another tenant's project by changing\nthe project ID in the request.",
  sourceFile: "src/api/projects/[id].ts",
  sourceLines: "82-113",
  targetBaseUrl: "https://preview-184.example.com",
  allowedScope: ["GET /api/projects/*"],
  excludedPaths: [],
  testAccounts: [
    { label: "Tenant A", username: "tenant-a@test.dev", credentialRef: "cred_a" },
    { label: "Tenant B", username: "tenant-b@test.dev", credentialRef: "cred_b" },
  ],
  destructiveTestingAllowed: false,
};

describe("buildStrixInstruction", () => {
  it("includes the finding id, hypothesis, source location, target, and scope", () => {
    const text = buildStrixInstruction(mission);
    expect(text).toContain("Validate finding finding_123.");
    expect(text).toContain("Hypothesis:");
    expect(text).toContain("A standard user may retrieve another tenant's project");
    expect(text).toContain("Source:");
    expect(text).toContain("src/api/projects/[id].ts, lines 82-113.");
    expect(text).toContain("Target:");
    expect(text).toContain("https://preview-184.example.com");
    expect(text).toContain("Allowed scope:");
    expect(text).toContain("GET /api/projects/*");
  });

  it("names both approved test accounts and restricts scope to them", () => {
    const text = buildStrixInstruction(mission);
    expect(text).toContain("Use only the supplied Tenant A and Tenant B test accounts.");
  });

  it("forbids destructive actions by default", () => {
    const text = buildStrixInstruction(mission);
    expect(text).toContain("Do not perform destructive actions.");
  });

  it("permits destructive actions only when explicitly authorized", () => {
    const text = buildStrixInstruction({ ...mission, destructiveTestingAllowed: true });
    expect(text).not.toContain("Do not perform destructive actions.");
    expect(text).toContain("Destructive actions are permitted only when required to reproduce the hypothesis.");
  });

  it("always includes a stop condition and unrelated-endpoint restriction", () => {
    const text = buildStrixInstruction(mission);
    expect(text).toContain("Do not test unrelated endpoints.");
    expect(text).toContain("Stop after confirming, disproving or exhausting the hypothesis.");
  });

  it("lists excluded paths when present", () => {
    const text = buildStrixInstruction({ ...mission, excludedPaths: ["/api/projects/internal/*"] });
    expect(text).toContain("Excluded paths:");
    expect(text).toContain("/api/projects/internal/*");
  });

  it("omits the test-account line when no accounts are supplied", () => {
    const text = buildStrixInstruction({ ...mission, testAccounts: [] });
    expect(text).not.toContain("test account");
  });

  it("appends a custom stop condition when provided", () => {
    const text = buildStrixInstruction({ ...mission, stopCondition: "Do not exceed 20 requests." });
    expect(text).toContain("Do not exceed 20 requests.");
  });
});
