import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "../../artifacts/artifact-store.js";
import type { JobQueue } from "../../orchestration/job-queue.js";
import { withIdempotency } from "../idempotency.js";
import { createSecurityReview } from "../services/create-security-review.js";
import { getRun } from "../services/get-run.js";
import {
  getFinding,
  listRunFindings,
  submitFixForFinding,
  validateFinding,
  verifyFixForFinding,
} from "../services/finding-services.js";
import { cancelRun } from "../services/cancel-run.js";
import { getReceipt } from "../services/get-receipt.js";

export interface ApiContext {
  prisma: PrismaClient;
  jobQueue: JobQueue;
  artifactStore: ArtifactStore;
}

const createReviewSchema = z.object({
  repository_id: z.string(),
  base_sha: z.string(),
  head_sha: z.string(),
  pull_request_number: z.number().int().optional(),
  target_environment_id: z.string().optional(),
  run_type: z.enum(["change_review", "repository_scan"]).optional(),
});

const validateFindingSchema = z.object({ target_environment_id: z.string() });
const submitFixSchema = z.object({ fix_commit_sha: z.string() });
const verifyFixSchema = z.object({ target_environment_id: z.string().optional() });

async function withIdempotentMutation<T>(
  ctx: ApiContext,
  request: FastifyRequest,
  reply: FastifyReply,
  endpoint: string,
  successStatus: number,
  handler: () => Promise<T>,
): Promise<void> {
  const idempotencyKeyHeader = request.headers["idempotency-key"];
  const organizationId = request.agent!.organizationId;

  if (!idempotencyKeyHeader || Array.isArray(idempotencyKeyHeader)) {
    const body = await handler();
    reply.code(successStatus).send(body);
    return;
  }

  const result = await withIdempotency(
    ctx.prisma,
    { organizationId, endpoint, idempotencyKey: idempotencyKeyHeader, requestBody: request.body },
    async () => ({ status: successStatus, body: await handler() }),
  );
  reply.code(result.status).send(result.body);
}

export function registerSecurityRoutes(fastify: FastifyInstance, ctx: ApiContext): void {
  fastify.post("/v1/security/reviews", async (request, reply) => {
    const body = createReviewSchema.parse(request.body);
    await withIdempotentMutation(ctx, request, reply, "POST /v1/security/reviews", 201, async () => {
      const result = await createSecurityReview(ctx.prisma, ctx.jobQueue, {
        agent: request.agent!,
        repositoryId: body.repository_id,
        baseSha: body.base_sha,
        headSha: body.head_sha,
        pullRequestNumber: body.pull_request_number,
        targetEnvironmentId: body.target_environment_id,
        runType: body.run_type,
      });
      return { run_id: result.runId, status: result.status };
    });
  });

  fastify.get("/v1/security/runs/:run_id", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = await getRun(ctx.prisma, request.agent!, run_id);
    reply.send(run);
  });

  fastify.get("/v1/security/runs/:run_id/findings", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const findings = await listRunFindings(ctx.prisma, request.agent!, run_id);
    reply.send({ findings });
  });

  fastify.get("/v1/security/runs/:run_id/receipt", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const format = (request.query as { format?: string }).format === "markdown" ? "markdown" : "json";
    const receipt = await getReceipt(ctx.prisma, ctx.artifactStore, request.agent!, run_id, format);
    reply.header("content-type", receipt.contentType).send(receipt.body);
  });

  fastify.post("/v1/security/runs/:run_id/cancel", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    await withIdempotentMutation(ctx, request, reply, "POST /v1/security/runs/:run_id/cancel", 200, async () => {
      const result = await cancelRun(ctx.prisma, request.agent!, run_id);
      return { run_id: result.runId, status: result.status };
    });
  });

  fastify.get("/v1/security/findings/:finding_id", async (request, reply) => {
    const { finding_id } = request.params as { finding_id: string };
    const finding = await getFinding(ctx.prisma, request.agent!, finding_id);
    reply.send(finding);
  });

  fastify.post("/v1/security/findings/:finding_id/validate", async (request, reply) => {
    const { finding_id } = request.params as { finding_id: string };
    const body = validateFindingSchema.parse(request.body);
    await withIdempotentMutation(
      ctx,
      request,
      reply,
      "POST /v1/security/findings/:finding_id/validate",
      202,
      async () => {
        const result = await validateFinding(ctx.prisma, ctx.jobQueue, request.agent!, finding_id, body.target_environment_id);
        return { run_id: result.runId, status: result.status };
      },
    );
  });

  fastify.post("/v1/security/findings/:finding_id/fix", async (request, reply) => {
    const { finding_id } = request.params as { finding_id: string };
    const body = submitFixSchema.parse(request.body);
    await withIdempotentMutation(ctx, request, reply, "POST /v1/security/findings/:finding_id/fix", 200, async () => {
      const result = await submitFixForFinding(ctx.prisma, request.agent!, finding_id, body.fix_commit_sha);
      return { finding_id: result.findingId, status: result.status };
    });
  });

  fastify.post("/v1/security/findings/:finding_id/verify-fix", async (request, reply) => {
    const { finding_id } = request.params as { finding_id: string };
    const body = verifyFixSchema.parse(request.body ?? {});
    await withIdempotentMutation(
      ctx,
      request,
      reply,
      "POST /v1/security/findings/:finding_id/verify-fix",
      202,
      async () => {
        const result = await verifyFixForFinding(ctx.prisma, ctx.jobQueue, request.agent!, finding_id, body.target_environment_id);
        return { run_id: result.runId, status: result.status };
      },
    );
  });
}
