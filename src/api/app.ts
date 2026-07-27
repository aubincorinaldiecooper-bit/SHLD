import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { JobQueue } from "../orchestration/job-queue.js";
import { authPlugin } from "./auth-plugin.js";
import { apiErrorHandler } from "./error-handler.js";
import { registerSecurityRoutes } from "./routes/security-routes.js";

export interface BuildAppOptions {
  prisma: PrismaClient;
  jobQueue: JobQueue;
  artifactStore: ArtifactStore;
  logger?: boolean;
}

/** Builds the canonical API. MCP, GitHub integrations, and the dashboard all call the same services this exposes. */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: options.logger ?? false });

  await fastify.register(authPlugin, { prisma: options.prisma });
  fastify.setErrorHandler(apiErrorHandler);

  registerSecurityRoutes(fastify, {
    prisma: options.prisma,
    jobQueue: options.jobQueue,
    artifactStore: options.artifactStore,
  });

  fastify.get("/healthz", async () => ({ status: "ok" }));

  return fastify;
}
