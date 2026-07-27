import { z } from "zod";

export interface StrixTestAccount {
  label: string;
  username: string;
  /** Opaque reference resolved to a real secret only inside the disposable sandbox. */
  credentialRef: string;
}

export type StrixVerdict = "confirmed" | "not_reproduced" | "inconclusive" | "failed";

export interface StrixMission {
  findingId: string;
  hypothesis: string;
  sourceFile: string;
  sourceLines?: string;
  targetBaseUrl: string;
  allowedScope: string[];
  excludedPaths: string[];
  testAccounts: StrixTestAccount[];
  destructiveTestingAllowed: boolean;
  stopCondition?: string;
}

export const strixRawResultSchema = z.object({
  verdict: z.enum(["confirmed", "not_reproduced", "inconclusive", "failed"]),
  endpoint: z.string().optional(),
  method: z.string().optional(),
  evidence_summary: z.string().optional(),
  reproduction_steps: z.array(z.string()).optional(),
  poc: z.string().optional(),
  cvss: z.number().min(0).max(10).optional(),
  agent_reasoning: z.string().optional(),
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nonnegative(),
  engine_version: z.string(),
});
export type StrixRawResult = z.infer<typeof strixRawResultSchema>;

export interface StrixExecutionRequest {
  mission: StrixMission;
  instruction: string;
  targetBuildId?: string;
  workDir: string;
  signal?: AbortSignal;
}

export interface StrixExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface StrixExecutionStrategy {
  execute(request: StrixExecutionRequest): Promise<StrixExecutionResult>;
}
