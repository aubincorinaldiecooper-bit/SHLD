import { describe, expect, it } from "vitest";
import { buildRetestMission } from "../../src/remediation/build-retest-mission.js";
import { buildStrixInstruction } from "../../src/adapters/strix/build-instruction.js";

describe("buildRetestMission", () => {
  it("seeds the hypothesis from the original confirmed evidence and endpoint", () => {
    const mission = buildRetestMission({
      findingId: "finding_123",
      findingTitle: "Cross-tenant project access",
      sourceFile: "src/api/projects/[id].ts",
      sourceLines: "82-113",
      targetBaseUrl: "https://preview-184-a.example.com",
      allowedScope: ["GET /api/projects/*"],
      excludedPaths: [],
      testAccounts: [],
      destructiveTestingAllowed: false,
      originalEvidence: {
        endpoint: "/api/projects/42",
        method: "GET",
        evidenceSummary: "Tenant B's project was returned to Tenant A's session.",
      },
    });

    expect(mission.hypothesis).toContain("finding_123");
    expect(mission.hypothesis).toContain("Tenant B's project was returned to Tenant A's session.");
    expect(mission.hypothesis).toContain("GET /api/projects/42");
    expect(mission.hypothesis).toContain("no longer succeeds");
  });

  it("falls back to a generic description when no original endpoint is known", () => {
    const mission = buildRetestMission({
      findingId: "finding_456",
      findingTitle: "Some finding",
      sourceFile: "src/x.ts",
      targetBaseUrl: "https://preview.example.com",
      allowedScope: [],
      excludedPaths: [],
      testAccounts: [],
      destructiveTestingAllowed: false,
      originalEvidence: {},
    });
    expect(mission.hypothesis).toContain("previously confirmed endpoint");
  });

  it("produces a mission that renders through the standard instruction builder", () => {
    const mission = buildRetestMission({
      findingId: "finding_123",
      findingTitle: "Cross-tenant project access",
      sourceFile: "src/api/projects/[id].ts",
      targetBaseUrl: "https://preview-184-a.example.com",
      allowedScope: ["GET /api/projects/*"],
      excludedPaths: [],
      testAccounts: [{ label: "Tenant A", username: "a@test.dev", credentialRef: "cred_a" }],
      destructiveTestingAllowed: false,
      originalEvidence: { endpoint: "/api/projects/42", method: "GET" },
    });
    const instruction = buildStrixInstruction(mission);
    expect(instruction).toContain("Validate finding finding_123.");
    expect(instruction).toContain("Use only the supplied Tenant A test account.");
  });
});
