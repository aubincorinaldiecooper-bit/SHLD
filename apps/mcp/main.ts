import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPrismaClient } from "../../src/db/client.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { BullMqJobQueue } from "../../src/orchestration/bullmq-job-queue.js";
import { authenticateAgentByApiKey } from "../../src/auth/authenticate-agent.js";
import { createShldMcpServer } from "../../src/mcp/create-mcp-server.js";

async function main(): Promise<void> {
  const apiKey = process.env.SHLD_API_KEY;
  if (!apiKey) {
    throw new Error("SHLD_API_KEY is required to start the MCP server");
  }

  const prisma = getPrismaClient();
  const agent = await authenticateAgentByApiKey(prisma, apiKey);

  const artifactStore = new ArtifactStore(process.env.ARTIFACT_STORAGE_DIR ?? "./.artifacts");
  const jobQueue = new BullMqJobQueue({ redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379" });

  const server = createShldMcpServer({ prisma, jobQueue, artifactStore, agent });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
