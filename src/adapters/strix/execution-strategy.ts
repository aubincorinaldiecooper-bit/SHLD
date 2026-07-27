import { spawn } from "node:child_process";
import type { StrixExecutionRequest, StrixExecutionResult, StrixExecutionStrategy, StrixRawResult } from "./types.js";

export type MockStrixResponder = (request: StrixExecutionRequest) => StrixRawResult | Promise<StrixRawResult>;

/** Used whenever STRIX_EXECUTION_MODE=mock (the default) — see the DeepSec mock strategy for rationale. */
export class MockStrixExecutionStrategy implements StrixExecutionStrategy {
  constructor(private readonly responder: MockStrixResponder) {}

  async execute(request: StrixExecutionRequest): Promise<StrixExecutionResult> {
    if (request.signal?.aborted) {
      return { exitCode: 124, stdout: "", stderr: "aborted before execution", durationMs: 0 };
    }
    const start = Date.now();
    const output = await this.responder(request);
    return { exitCode: 0, stdout: JSON.stringify(output), stderr: "", durationMs: Date.now() - start };
  }
}

export interface CliStrixExecutionStrategyOptions {
  /** Path to the strix executable (or a stand-in script in tests). */
  cliPath: string;
  extraArgs?: string[];
}

const TIMEOUT_EXIT_CODE = 124;

/**
 * Spawns the real Strix CLI inside what the caller has already prepared as
 * a disposable sandbox (working directory + restricted environment). The
 * instruction file's path is passed via --instruction; Strix reads its
 * mission from there rather than a broad natural-language prompt.
 */
export class CliStrixExecutionStrategy implements StrixExecutionStrategy {
  constructor(private readonly options: CliStrixExecutionStrategyOptions) {}

  async execute(request: StrixExecutionRequest): Promise<StrixExecutionResult> {
    const args = [
      "validate",
      "--instruction-file",
      request.workDir + "/instruction.md",
      "--json",
      ...(this.options.extraArgs ?? []),
    ];
    const start = Date.now();

    return new Promise<StrixExecutionResult>((resolve, reject) => {
      const child = spawn(this.options.cliPath, args, { cwd: request.workDir });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let killedByAbort = false;

      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

      const onAbort = () => {
        killedByAbort = true;
        child.kill("SIGTERM");
      };
      request.signal?.addEventListener("abort", onAbort);

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener("abort", onAbort);
        resolve({
          exitCode: killedByAbort ? TIMEOUT_EXIT_CODE : (code ?? -1),
          stdout,
          stderr,
          durationMs: Date.now() - start,
        });
      });
    });
  }
}
