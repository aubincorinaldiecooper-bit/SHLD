#!/usr/bin/env node
// Stand-in for the real Strix CLI — exercises CliStrixExecutionStrategy's
// subprocess handling without needing the real binary/sandbox.
const args = process.argv.slice(2);
const mode = process.env.FAKE_STRIX_MODE || "success";

if (mode === "sleep") {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  process.stderr.write("simulated sandbox crash\n");
  process.exit(2);
} else {
  const output = {
    verdict: "confirmed",
    endpoint: "/api/projects/42",
    method: "GET",
    evidence_summary: "Tenant B's project was returned to Tenant A's session.",
    reproduction_steps: ["Log in as Tenant A", "GET /api/projects/42"],
    model: "fake-strix-model",
    input_tokens: 500,
    output_tokens: 200,
    estimated_cost_usd: 0.05,
    engine_version: "test-1.0",
    args_received: args,
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
