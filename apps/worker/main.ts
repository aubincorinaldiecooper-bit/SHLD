import { getPrismaClient } from "../../src/db/client.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { BullMqJobQueue } from "../../src/orchestration/bullmq-job-queue.js";
import { registerJobHandlers } from "../../src/orchestration/handlers/register.js";
import type { HandlerDeps } from "../../src/orchestration/handlers/deps.js";
import { DeepSecAdapter } from "../../src/adapters/deepsec/deepsec-adapter.js";
import { CliDeepSecExecutionStrategy } from "../../src/adapters/deepsec/execution-strategy.js";
import { StrixAdapter } from "../../src/adapters/strix/strix-adapter.js";
import { CliStrixExecutionStrategy } from "../../src/adapters/strix/execution-strategy.js";

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  const artifactStore = new ArtifactStore(process.env.ARTIFACT_STORAGE_DIR ?? "./.artifacts");
  const jobQueue = new BullMqJobQueue({ redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379" });

  const deps: HandlerDeps = {
    prisma,
    jobQueue,
    artifactStore,
    deepsecAdapter: new DeepSecAdapter(
      new CliDeepSecExecutionStrategy({ cliPath: process.env.DEEPSEC_CLI_PATH ?? "deepsec" }),
    ),
    strixAdapter: new StrixAdapter(new CliStrixExecutionStrategy({ cliPath: process.env.STRIX_CLI_PATH ?? "strix" })),
    workspaceRoot: process.env.WORKSPACE_ROOT ?? "./.workspace",
    resolveCloneUrl: (repository) => {
      if (repository.provider !== "github") {
        throw new Error(`Unsupported repository provider: ${repository.provider}`);
      }
      const token = process.env.GITHUB_CLONE_TOKEN;
      const auth = token ? `${token}@` : "";
      return `https://${auth}github.com/${repository.owner}/${repository.name}.git`;
    },
    policyVersion: process.env.POLICY_VERSION ?? "2026-01-01",
  };

  registerJobHandlers(jobQueue, deps);
  await jobQueue.start({ concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5) });
  console.log("SHLD worker started");
}

main().catch((error) => {
  console.error("Fatal error starting worker:", error);
  process.exit(1);
});
