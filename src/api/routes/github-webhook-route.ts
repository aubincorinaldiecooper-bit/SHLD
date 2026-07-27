import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { JobQueue } from "../../orchestration/job-queue.js";
import { verifyGithubWebhookSignature } from "../../auth/github-webhook.js";
import { processPullRequestEvent } from "../../github/process-pull-request-event.js";

export interface GitHubWebhookContext {
  prisma: PrismaClient;
  jobQueue: JobQueue;
  webhookSecret: string;
}

export function registerGitHubWebhookRoute(fastify: FastifyInstance, ctx: GitHubWebhookContext): void {
  fastify.post("/webhooks/github", async (request, reply) => {
    const signature = request.headers["x-hub-signature-256"];
    const deliveryId = request.headers["x-github-delivery"];
    const eventType = request.headers["x-github-event"];

    if (!request.rawBody || typeof signature !== "string" || typeof deliveryId !== "string" || typeof eventType !== "string") {
      reply.code(400).send({ error: "invalid_request", message: "Missing required GitHub webhook headers" });
      return;
    }

    if (!verifyGithubWebhookSignature(request.rawBody, signature, ctx.webhookSecret)) {
      reply.code(401).send({ error: "invalid_signature" });
      return;
    }

    if (eventType !== "pull_request") {
      reply.code(202).send({ outcome: "skipped", reason: `event "${eventType}" is not handled` });
      return;
    }

    const result = await processPullRequestEvent(ctx.prisma, ctx.jobQueue, {
      deliveryId,
      eventType,
      payload: request.body,
    });

    reply.code(202).send(result);
  });
}
