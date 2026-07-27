import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { JobQueue } from "../orchestration/job-queue.js";
import { authPlugin } from "./auth-plugin.js";
import { rawBodyPlugin } from "./raw-body-plugin.js";
import { apiErrorHandler } from "./error-handler.js";
import { registerSecurityRoutes } from "./routes/security-routes.js";
import { registerGitHubWebhookRoute } from "./routes/github-webhook-route.js";
import { dashboardSessionAuthPlugin } from "../dashboard/session-auth-plugin.js";
import { registerDashboardRoutes } from "../dashboard/routes.js";

export interface BuildAppOptions {
  prisma: PrismaClient;
  jobQueue: JobQueue;
  artifactStore: ArtifactStore;
  logger?: boolean;
  /** Omit to leave the GitHub webhook route unregistered (e.g. in tests that don't need it). */
  githubWebhookSecret?: string;
  /** Defaults to true — set false to leave the dashboard unregistered. */
  enableDashboard?: boolean;
}

/** Builds the canonical API. MCP, GitHub integrations, and the dashboard all call the same services this exposes. */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: options.logger ?? false });

  await fastify.register(rawBodyPlugin);
  await fastify.register(authPlugin, { prisma: options.prisma });
  fastify.setErrorHandler(apiErrorHandler);

  registerSecurityRoutes(fastify, {
    prisma: options.prisma,
    jobQueue: options.jobQueue,
    artifactStore: options.artifactStore,
  });

  if (options.githubWebhookSecret) {
    registerGitHubWebhookRoute(fastify, {
      prisma: options.prisma,
      jobQueue: options.jobQueue,
      webhookSecret: options.githubWebhookSecret,
    });
  }

  if (options.enableDashboard ?? true) {
    await fastify.register(dashboardSessionAuthPlugin, { prisma: options.prisma });
    registerDashboardRoutes(fastify, { prisma: options.prisma });
  }

  fastify.get("/healthz", async () => ({ status: "ok" }));

  return fastify;
}
