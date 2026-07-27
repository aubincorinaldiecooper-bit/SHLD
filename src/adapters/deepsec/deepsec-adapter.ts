import { DomainError } from "../../domain/errors.js";
import { normalizeDeepSecFinding, type NormalizedFinding } from "./normalize.js";
import { deepSecRunOutputSchema, type DeepSecExecutionRequest, type DeepSecExecutionStrategy } from "./types.js";

export class DeepSecExecutionError extends DomainError {}
export class DeepSecTimeoutError extends DomainError {}
export class DeepSecOutputParseError extends DomainError {}

export interface DeepSecRunResult {
  exitCode: number;
  rawStdout: string;
  rawStderr: string;
  durationMs: number;
  findings: NormalizedFinding[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  engineVersion: string;
}

const TIMEOUT_EXIT_CODE = 124;

/**
 * The only place in the platform that knows DeepSec's CLI shape and output
 * format. Everything downstream (routing, correlation, receipts) works off
 * the normalized, platform-schema Finding — never raw DeepSec JSON.
 */
export class DeepSecAdapter {
  constructor(private readonly strategy: DeepSecExecutionStrategy) {}

  async run(request: DeepSecExecutionRequest, repositoryId: string): Promise<DeepSecRunResult> {
    const result = await this.strategy.execute(request);

    if (result.exitCode === TIMEOUT_EXIT_CODE) {
      throw new DeepSecTimeoutError("DeepSec execution timed out or was cancelled");
    }
    if (result.exitCode !== 0) {
      throw new DeepSecExecutionError(
        `DeepSec exited with code ${result.exitCode}: ${result.stderr.slice(0, 2000) || "(no stderr)"}`,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.stdout);
    } catch (error) {
      throw new DeepSecOutputParseError(
        `DeepSec stdout was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const parsed = deepSecRunOutputSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new DeepSecOutputParseError(`DeepSec output did not match the expected schema: ${parsed.error.message}`);
    }

    const findings = parsed.data.findings.map((raw) => normalizeDeepSecFinding(raw, repositoryId));

    return {
      exitCode: result.exitCode,
      rawStdout: result.stdout,
      rawStderr: result.stderr,
      durationMs: result.durationMs,
      findings,
      model: parsed.data.model,
      inputTokens: parsed.data.input_tokens,
      outputTokens: parsed.data.output_tokens,
      estimatedCostUsd: parsed.data.estimated_cost_usd,
      engineVersion: parsed.data.engine_version,
    };
  }
}
