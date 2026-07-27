import { describe, expect, it } from "vitest";
import {
  StrixAdapter,
  StrixExecutionError,
  StrixOutputParseError,
  StrixTimeoutError,
} from "../../src/adapters/strix/strix-adapter.js";
import { MockStrixExecutionStrategy } from "../../src/adapters/strix/execution-strategy.js";
import { buildStrixInstruction } from "../../src/adapters/strix/build-instruction.js";
import type { StrixExecutionRequest, StrixExecutionResult, StrixExecutionStrategy, StrixMission } from "../../src/adapters/strix/types.js";
import { TargetAuthorizationError } from "../../src/domain/errors.js";

const mission: StrixMission = {
  findingId: "finding_123",
  hypothesis: "Cross-tenant project access via project ID substitution.",
  sourceFile: "src/api/projects/[id].ts",
  sourceLines: "82-113",
  targetBaseUrl: "https://preview-184.example.com",
  allowedScope: ["GET /api/projects/*"],
  excludedPaths: [],
  testAccounts: [{ label: "Tenant A", username: "a@test.dev", credentialRef: "cred_a" }],
  destructiveTestingAllowed: false,
};

function baseRequest(overrides: Partial<StrixExecutionRequest> = {}): StrixExecutionRequest {
  return {
    mission,
    instruction: buildStrixInstruction(mission),
    workDir: "/tmp/strix-work",
    ...overrides,
  };
}

describe("StrixAdapter with a mock strategy", () => {
  it("normalizes a confirmed verdict", async () => {
    const strategy = new MockStrixExecutionStrategy(() => ({
      verdict: "confirmed",
      endpoint: "/api/projects/42",
      method: "GET",
      evidence_summary: "Tenant B's project was returned to Tenant A's session.",
      reproduction_steps: ["Log in as Tenant A", "GET /api/projects/42 (owned by Tenant B)"],
      poc: "curl -H 'Authorization: Bearer <tenant-a-token>' https://preview-184.example.com/api/projects/42",
      cvss: 8.1,
      model: "strix-agent-v1",
      input_tokens: 2000,
      output_tokens: 800,
      estimated_cost_usd: 0.25,
      engine_version: "0.9.0",
    }));
    const adapter = new StrixAdapter(strategy);
    const result = await adapter.run(baseRequest());

    expect(result.validation.status).toBe("confirmed");
    expect(result.validation.endpoint).toBe("/api/projects/42");
    expect(result.validation.reproductionSteps).toHaveLength(2);
    expect(result.validation.proofOfConcept).toContain("curl");
    expect(result.estimatedCostUsd).toBe(0.25);
  });

  it("normalizes a not_reproduced verdict", async () => {
    const strategy = new MockStrixExecutionStrategy(() => ({
      verdict: "not_reproduced",
      evidence_summary: "Access correctly returned 403 for cross-tenant requests.",
      model: "strix-agent-v1",
      input_tokens: 100,
      output_tokens: 50,
      estimated_cost_usd: 0.01,
      engine_version: "0.9.0",
    }));
    const adapter = new StrixAdapter(strategy);
    const result = await adapter.run(baseRequest());
    expect(result.validation.status).toBe("not_reproduced");
  });

  it("rejects a mission with a malformed target URL", async () => {
    const strategy = new MockStrixExecutionStrategy(() => {
      throw new Error("should not execute");
    });
    const adapter = new StrixAdapter(strategy);
    const badMission: StrixMission = { ...mission, targetBaseUrl: "not a url" };
    await expect(
      adapter.run(baseRequest({ mission: badMission, instruction: buildStrixInstruction(badMission) })),
    ).rejects.toThrow(TargetAuthorizationError);
  });

  it("rejects a mission with a non-http(s) target URL", async () => {
    const strategy = new MockStrixExecutionStrategy(() => {
      throw new Error("should not execute");
    });
    const adapter = new StrixAdapter(strategy);
    const badMission: StrixMission = { ...mission, targetBaseUrl: "file:///etc/passwd" };
    await expect(
      adapter.run(baseRequest({ mission: badMission, instruction: buildStrixInstruction(badMission) })),
    ).rejects.toThrow(TargetAuthorizationError);
  });

  it("throws StrixTimeoutError on a timeout exit code", async () => {
    const strategy: StrixExecutionStrategy = {
      async execute(): Promise<StrixExecutionResult> {
        return { exitCode: 124, stdout: "", stderr: "", durationMs: 3000 };
      },
    };
    const adapter = new StrixAdapter(strategy);
    await expect(adapter.run(baseRequest())).rejects.toThrow(StrixTimeoutError);
  });

  it("throws StrixExecutionError on a nonzero exit code", async () => {
    const strategy: StrixExecutionStrategy = {
      async execute(): Promise<StrixExecutionResult> {
        return { exitCode: 1, stdout: "", stderr: "sandbox crashed", durationMs: 10 };
      },
    };
    const adapter = new StrixAdapter(strategy);
    await expect(adapter.run(baseRequest())).rejects.toThrow(StrixExecutionError);
  });

  it("throws StrixOutputParseError on malformed JSON", async () => {
    const strategy: StrixExecutionStrategy = {
      async execute(): Promise<StrixExecutionResult> {
        return { exitCode: 0, stdout: "not json", stderr: "", durationMs: 10 };
      },
    };
    const adapter = new StrixAdapter(strategy);
    await expect(adapter.run(baseRequest())).rejects.toThrow(StrixOutputParseError);
  });

  it("throws StrixOutputParseError on an invalid verdict value", async () => {
    const strategy: StrixExecutionStrategy = {
      async execute(): Promise<StrixExecutionResult> {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            verdict: "definitely_vulnerable",
            model: "m",
            input_tokens: 1,
            output_tokens: 1,
            estimated_cost_usd: 0,
            engine_version: "1",
          }),
          stderr: "",
          durationMs: 10,
        };
      },
    };
    const adapter = new StrixAdapter(strategy);
    await expect(adapter.run(baseRequest())).rejects.toThrow(StrixOutputParseError);
  });

  it("respects an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const strategy = new MockStrixExecutionStrategy(() => {
      throw new Error("should not be called");
    });
    const adapter = new StrixAdapter(strategy);
    await expect(adapter.run(baseRequest({ signal: controller.signal }))).rejects.toThrow(StrixTimeoutError);
  });
});
