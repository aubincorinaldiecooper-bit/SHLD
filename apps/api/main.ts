import { getPrismaClient } from "../../src/db/client.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { BullMqJobQueue } from "../../src/orchestration/bullmq-job-queue.js";
import { buildApp } from "../../src/api/app.js";

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  const artifactStore = new ArtifactStore(process.env.ARTIFACT_STORAGE_DIR ?? "./.artifacts");
  const jobQueue = new BullMqJobQueue({ redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379" });

  const app = await buildApp({ prisma, jobQueue, artifactStore, logger: true });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`SHLD API listening on :${port}`);
}

main().catch((error) => {
  console.error("Fatal error starting API server:", error);
  process.exit(1);
});
