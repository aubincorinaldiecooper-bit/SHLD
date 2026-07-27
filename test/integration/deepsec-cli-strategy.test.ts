import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CliDeepSecExecutionStrategy } from "../../src/adapters/deepsec/execution-strategy.js";
import type { DeepSecExecutionRequest } from "../../src/adapters/deepsec/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeCliPath = path.join(__dirname, "..", "fixtures", "fake-deepsec-cli.mjs");

const baseRequest: DeepSecExecutionRequest = {
  operation: "change_review",
  snapshotPath: process.cwd(),
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  workDir: "/tmp",
};

describe("CliDeepSecExecutionStrategy", () => {
  it("captures stdout and a zero exit code from a successful run", async () => {
    const strategy = new CliDeepSecExecutionStrategy({ cliPath: fakeCliPath });
    const result = await strategy.execute({ ...baseRequest, signal: undefined });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.engine_version).toBe("test-1.0");
    expect(parsed.args_received).toEqual(["process", "--diff", baseRequest.baseSha, "--json"]);
  });

  it("captures stderr and a nonzero exit code from a failing run", async () => {
    const strategy = new CliDeepSecExecutionStrategy({ cliPath: fakeCliPath });
    const originalEnv = process.env.FAKE_DEEPSEC_MODE;
    process.env.FAKE_DEEPSEC_MODE = "fail";
    try {
      const result = await strategy.execute(baseRequest);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("simulated failure");
    } finally {
      process.env.FAKE_DEEPSEC_MODE = originalEnv;
    }
  });

  it("kills the subprocess and reports a timeout exit code on abort", async () => {
    const strategy = new CliDeepSecExecutionStrategy({ cliPath: fakeCliPath });
    const controller = new AbortController();
    const originalEnv = process.env.FAKE_DEEPSEC_MODE;
    process.env.FAKE_DEEPSEC_MODE = "sleep";
    try {
      const resultPromise = strategy.execute({ ...baseRequest, signal: controller.signal });
      setTimeout(() => controller.abort(), 200);
      const result = await resultPromise;
      expect(result.exitCode).toBe(124);
    } finally {
      process.env.FAKE_DEEPSEC_MODE = originalEnv;
    }
  }, 10000);

  it("builds the correct args for fix_revalidation", async () => {
    const strategy = new CliDeepSecExecutionStrategy({ cliPath: fakeCliPath });
    const result = await strategy.execute({
      ...baseRequest,
      operation: "fix_revalidation",
      originalFinding: { title: "Cross-tenant access", filePath: "src/api/projects.ts", category: "authorization" },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.args_received).toEqual([
      "revalidate",
      "--finding-title",
      "Cross-tenant access",
      "--file",
      "src/api/projects.ts",
      "--json",
    ]);
  });
});
