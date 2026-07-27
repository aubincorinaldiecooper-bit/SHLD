import { DomainError, TargetAuthorizationError } from "../../domain/errors.js";
import { strixRawResultSchema, type StrixExecutionRequest, type StrixExecutionStrategy, type StrixVerdict } from "./types.js";

export class StrixExecutionError extends DomainError {}
export class StrixTimeoutError extends DomainError {}
export class StrixOutputParseError extends DomainError {}

export interface NormalizedValidation {
  status: StrixVerdict;
  endpoint?: string;
  method?: string;
  evidenceSummary?: string;
  reproductionSteps: string[];
  proofOfConcept?: string;
  cvss?: number;
  agentReasoning?: string;
}

export interface StrixRunResult {
  exitCode: number;
  rawStdout: string;
  rawStderr: string;
  durationMs: number;
  validation: NormalizedValidation;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  engineVersion: string;
}

const TIMEOUT_EXIT_CODE = 124;

/**
 * The only place in the platform that knows Strix's CLI shape and output
 * format. The caller is expected to have already resolved and authorized
 * the target via authorizeTargetEnvironment (task 6) before building a
 * mission — this adapter's own check is a narrow sanity guard against a
 * malformed or non-http(s) base URL slipping through into the sandbox;
 * the real scope/authority enforcement lives in the target-authorization
 * service and (in deployment) the sandbox's network egress policy.
 */
export class StrixAdapter {
  constructor(private readonly strategy: StrixExecutionStrategy) {}

  async run(request: StrixExecutionRequest): Promise<StrixRunResult> {
    assertWellFormedTarget(request.mission.targetBaseUrl);

    const result = await this.strategy.execute(request);

    if (result.exitCode === TIMEOUT_EXIT_CODE) {
      throw new StrixTimeoutError("Strix execution timed out or was cancelled");
    }
    if (result.exitCode !== 0) {
      throw new StrixExecutionError(
        `Strix exited with code ${result.exitCode}: ${result.stderr.slice(0, 2000) || "(no stderr)"}`,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.stdout);
    } catch (error) {
      throw new StrixOutputParseError(
        `Strix stdout was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const parsed = strixRawResultSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new StrixOutputParseError(`Strix output did not match the expected schema: ${parsed.error.message}`);
    }

    const validation: NormalizedValidation = {
      status: parsed.data.verdict,
      endpoint: parsed.data.endpoint,
      method: parsed.data.method,
      evidenceSummary: parsed.data.evidence_summary,
      reproductionSteps: parsed.data.reproduction_steps ?? [],
      proofOfConcept: parsed.data.poc,
      cvss: parsed.data.cvss,
      agentReasoning: parsed.data.agent_reasoning,
    };

    return {
      exitCode: result.exitCode,
      rawStdout: result.stdout,
      rawStderr: result.stderr,
      durationMs: result.durationMs,
      validation,
      model: parsed.data.model,
      inputTokens: parsed.data.input_tokens,
      outputTokens: parsed.data.output_tokens,
      estimatedCostUsd: parsed.data.estimated_cost_usd,
      engineVersion: parsed.data.engine_version,
    };
  }
}

function assertWellFormedTarget(targetBaseUrl: string): void {
  let url: URL;
  try {
    url = new URL(targetBaseUrl);
  } catch {
    throw new TargetAuthorizationError(`Malformed Strix mission target URL: ${targetBaseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TargetAuthorizationError(`Unsupported protocol for Strix mission target: ${url.protocol}`);
  }
}
