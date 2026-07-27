#!/usr/bin/env node
// Stand-in for the real DeepSec CLI, used only to exercise
// CliDeepSecExecutionStrategy's subprocess handling (stdout/stderr capture,
// exit codes, SIGTERM-on-cancel) without needing the real binary.
const args = process.argv.slice(2);
const mode = process.env.FAKE_DEEPSEC_MODE || "success";

if (mode === "sleep") {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  process.stderr.write("simulated failure\n");
  process.exit(2);
} else {
  const output = {
    findings: [],
    model: "fake-model",
    input_tokens: 10,
    output_tokens: 5,
    estimated_cost_usd: 0.001,
    engine_version: "test-1.0",
    args_received: args,
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
