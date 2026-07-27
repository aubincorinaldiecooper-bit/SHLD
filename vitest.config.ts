import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 15000,
    setupFiles: ["./test/setup.ts"],
    // Integration tests share one local Postgres database and truncate
    // tables between cases; running test files in parallel races those
    // truncations against other files' fixtures. Sequential files keep the
    // suite correct without needing a per-worker schema scheme.
    fileParallelism: false,
  },
});
