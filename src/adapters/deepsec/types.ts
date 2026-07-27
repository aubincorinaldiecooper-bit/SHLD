import { z } from "zod";

export const deepSecRawFindingSchema = z.object({
  title: z.string(),
  description: z.string(),
  category: z.string(),
  cwe: z.string().optional(),
  severity: z.string(),
  confidence: z.string(),
  file_path: z.string(),
  start_line: z.number().int().optional(),
  end_line: z.number().int().optional(),
  symbol: z.string().optional(),
  recommendation: z.string().optional(),
  revalidation_verdict: z.enum(["true_positive", "false_positive", "unknown"]).optional(),
});
export type DeepSecRawFinding = z.infer<typeof deepSecRawFindingSchema>;

export const deepSecRunOutputSchema = z.object({
  findings: z.array(deepSecRawFindingSchema),
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nonnegative(),
  engine_version: z.string(),
});
export type DeepSecRunOutput = z.infer<typeof deepSecRunOutputSchema>;

export type DeepSecOperation = "change_review" | "full_audit" | "fix_revalidation";

export interface DeepSecOriginalFinding {
  title: string;
  filePath: string;
  category: string;
}

export interface DeepSecExecutionRequest {
  operation: DeepSecOperation;
  snapshotPath: string;
  baseSha: string;
  headSha: string;
  originalFinding?: DeepSecOriginalFinding;
  workDir: string;
  signal?: AbortSignal;
}

export interface DeepSecExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface DeepSecExecutionStrategy {
  execute(request: DeepSecExecutionRequest): Promise<DeepSecExecutionResult>;
}
