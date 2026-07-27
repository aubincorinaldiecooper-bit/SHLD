import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CliStrixExecutionStrategy } from "../../src/adapters/strix/execution-strategy.js";
import { buildStrixInstruction } from "../../src/adapters/strix/build-instruction.js";
import type { StrixExecutionRequest, StrixMission } from "../../src/adapters/strix/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeCliPath = path.join(__dirname, "..", "fixtures", "fake-strix-cli.mjs");

const mission: StrixMission = {
  findingId: "finding_123",
  hypothesis: "Cross-tenant project access.",
  sourceFile: "src/api/projects/[id].ts",
  targetBaseUrl: "https://preview-184.example.com",
  allowedScope: ["GET /api/projects/*"],
  excludedPaths: [],
  testAccounts: [],
  destructiveTestingAllowed: false,
};

function baseRequest(overrides: Partial<StrixExecutionRequest> = {}): StrixExecutionRequest {
  return {
    mission,
    instruction: buildStrixInstruction(mission),
    workDir: "/tmp",
    ...overrides,
  };
}

describe("CliStrixExecutionStrategy", () => {
  it("captures stdout and a zero exit code from a successful run", async () => {
    const strategy = new CliStrixExecutionStrategy({ cliPath: fakeCliPath });
    const result = await strategy.execute(baseRequest());
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.verdict).toBe("confirmed");
    expect(parsed.args_received).toEqual(["validate", "--instruction-file", "/tmp/instruction.md", "--json"]);
  });

  it("captures stderr and a nonzero exit code from a failing run", async () => {
    const strategy = new CliStrixExecutionStrategy({ cliPath: fakeCliPath });
    const originalEnv = process.env.FAKE_STRIX_MODE;
    process.env.FAKE_STRIX_MODE = "fail";
    try {
      const result = await strategy.execute(baseRequest());
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("simulated sandbox crash");
    } finally {
      process.env.FAKE_STRIX_MODE = originalEnv;
    }
  });

  it("kills the subprocess and reports a timeout exit code on abort", async () => {
    const strategy = new CliStrixExecutionStrategy({ cliPath: fakeCliPath });
    const controller = new AbortController();
    const originalEnv = process.env.FAKE_STRIX_MODE;
    process.env.FAKE_STRIX_MODE = "sleep";
    try {
      const resultPromise = strategy.execute(baseRequest({ signal: controller.signal }));
      setTimeout(() => controller.abort(), 200);
      const result = await resultPromise;
      expect(result.exitCode).toBe(124);
    } finally {
      process.env.FAKE_STRIX_MODE = originalEnv;
    }
  }, 10000);
});
