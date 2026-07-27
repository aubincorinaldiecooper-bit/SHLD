import { spawn } from "node:child_process";
import type { DeepSecExecutionRequest, DeepSecExecutionResult, DeepSecExecutionStrategy, DeepSecRunOutput } from "./types.js";

export type MockDeepSecResponder = (request: DeepSecExecutionRequest) => DeepSecRunOutput | Promise<DeepSecRunOutput>;

/**
 * Used whenever DEEPSEC_EXECUTION_MODE=mock (the default). Lets tests and
 * local development exercise the full adapter/persistence/routing pipeline
 * without the real DeepSec binary, model credentials, or network access —
 * the responder callback plays the part of "what DeepSec would have found".
 */
export class MockDeepSecExecutionStrategy implements DeepSecExecutionStrategy {
  constructor(private readonly responder: MockDeepSecResponder) {}

  async execute(request: DeepSecExecutionRequest): Promise<DeepSecExecutionResult> {
    if (request.signal?.aborted) {
      return { exitCode: 124, stdout: "", stderr: "aborted before execution", durationMs: 0 };
    }
    const start = Date.now();
    const output = await this.responder(request);
    return { exitCode: 0, stdout: JSON.stringify(output), stderr: "", durationMs: Date.now() - start };
  }
}

export interface CliDeepSecExecutionStrategyOptions {
  /** Path to the deepsec executable (or a stand-in script in tests). */
  cliPath: string;
  extraArgs?: string[];
}

function buildArgs(request: DeepSecExecutionRequest, extraArgs: string[]): string[] {
  switch (request.operation) {
    case "change_review":
      return ["process", "--diff", request.baseSha, "--json", ...extraArgs];
    case "full_audit":
      return ["scan", "--json", ...extraArgs];
    case "fix_revalidation":
      return [
        "revalidate",
        "--finding-title",
        request.originalFinding?.title ?? "",
        "--file",
        request.originalFinding?.filePath ?? "",
        "--json",
        ...extraArgs,
      ];
  }
}

const TIMEOUT_EXIT_CODE = 124;

/** Spawns the real DeepSec CLI as a subprocess and captures its output. */
export class CliDeepSecExecutionStrategy implements DeepSecExecutionStrategy {
  constructor(private readonly options: CliDeepSecExecutionStrategyOptions) {}

  async execute(request: DeepSecExecutionRequest): Promise<DeepSecExecutionResult> {
    const args = buildArgs(request, this.options.extraArgs ?? []);
    const start = Date.now();

    return new Promise<DeepSecExecutionResult>((resolve, reject) => {
      const child = spawn(this.options.cliPath, args, { cwd: request.snapshotPath });
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
