import { describe, expect, it } from "vitest";
import {
  DeepSecAdapter,
  DeepSecExecutionError,
  DeepSecOutputParseError,
  DeepSecTimeoutError,
} from "../../src/adapters/deepsec/deepsec-adapter.js";
import { MockDeepSecExecutionStrategy } from "../../src/adapters/deepsec/execution-strategy.js";
import type { DeepSecExecutionRequest, DeepSecExecutionResult, DeepSecExecutionStrategy } from "../../src/adapters/deepsec/types.js";

const baseRequest: DeepSecExecutionRequest = {
  operation: "change_review",
  snapshotPath: "/tmp/snapshot",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  workDir: "/tmp/work",
};

describe("DeepSecAdapter with a mock strategy", () => {
  it("normalizes findings from a successful run", async () => {
    const strategy = new MockDeepSecExecutionStrategy(() => ({
      findings: [
        {
          title: "Cross-tenant project access",
          description: "desc",
          category: "authorization",
          severity: "high",
          confidence: "high",
          file_path: "src/api/projects/[id].ts",
        },
      ],
      model: "deepsec-analyzer-v1",
      input_tokens: 1000,
      output_tokens: 500,
      estimated_cost_usd: 0.12,
      engine_version: "1.2.3",
    }));
    const adapter = new DeepSecAdapter(strategy);
    const result = await adapter.run(baseRequest, "repo_1");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("high");
    expect(result.model).toBe("deepsec-analyzer-v1");
    expect(result.estimatedCostUsd).toBe(0.12);
  });

  it("throws DeepSecTimeoutError when the strategy reports a timeout exit code", async () => {
    const strategy: DeepSecExecutionStrategy = {
      async execute(): Promise<DeepSecExecutionResult> {
        return { exitCode: 124, stdout: "", stderr: "", durationMs: 5000 };
      },
    };
    const adapter = new DeepSecAdapter(strategy);
    await expect(adapter.run(baseRequest, "repo_1")).rejects.toThrow(DeepSecTimeoutError);
  });

  it("throws DeepSecExecutionError on a nonzero exit code", async () => {
    const strategy: DeepSecExecutionStrategy = {
      async execute(): Promise<DeepSecExecutionResult> {
        return { exitCode: 1, stdout: "", stderr: "model API key missing", durationMs: 10 };
      },
    };
    const adapter = new DeepSecAdapter(strategy);
    await expect(adapter.run(baseRequest, "repo_1")).rejects.toThrow(DeepSecExecutionError);
  });

  it("throws DeepSecOutputParseError on malformed JSON", async () => {
    const strategy: DeepSecExecutionStrategy = {
      async execute(): Promise<DeepSecExecutionResult> {
        return { exitCode: 0, stdout: "not json", stderr: "", durationMs: 10 };
      },
    };
    const adapter = new DeepSecAdapter(strategy);
    await expect(adapter.run(baseRequest, "repo_1")).rejects.toThrow(DeepSecOutputParseError);
  });

  it("throws DeepSecOutputParseError when JSON doesn't match the expected schema", async () => {
    const strategy: DeepSecExecutionStrategy = {
      async execute(): Promise<DeepSecExecutionResult> {
        return { exitCode: 0, stdout: JSON.stringify({ unexpected: true }), stderr: "", durationMs: 10 };
      },
    };
    const adapter = new DeepSecAdapter(strategy);
    await expect(adapter.run(baseRequest, "repo_1")).rejects.toThrow(DeepSecOutputParseError);
  });

  it("throws DeepSecOutputParseError when a finding has an unrecognized severity", async () => {
    const strategy = new MockDeepSecExecutionStrategy(() => ({
      findings: [
        {
          title: "t",
          description: "d",
          category: "c",
          severity: "apocalyptic",
          confidence: "high",
          file_path: "f.ts",
        },
      ],
      model: "m",
      input_tokens: 1,
      output_tokens: 1,
      estimated_cost_usd: 0,
      engine_version: "1",
    }));
    const adapter = new DeepSecAdapter(strategy);
    await expect(adapter.run(baseRequest, "repo_1")).rejects.toThrow();
  });

  it("respects an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const strategy = new MockDeepSecExecutionStrategy(() => {
      throw new Error("should not be called");
    });
    const adapter = new DeepSecAdapter(strategy);
    await expect(adapter.run({ ...baseRequest, signal: controller.signal }, "repo_1")).rejects.toThrow(
      DeepSecTimeoutError,
    );
  });
});
