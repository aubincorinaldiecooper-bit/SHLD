import type { PrismaClient } from "@prisma/client";
import type { JobQueue } from "../orchestration/job-queue.js";
import { getOrCreateGithubAgentIdentity } from "../auth/authenticate-agent.js";
import { createSecurityReview } from "../api/services/create-security-review.js";
import { pullRequestWebhookSchema, TRACKED_PULL_REQUEST_ACTIONS } from "./webhook-event.js";

export interface ProcessPullRequestEventParams {
  deliveryId: string;
  eventType: string;
  payload: unknown;
}

export type ProcessPullRequestEventResult =
  | { outcome: "created"; runId: string; status: string }
  | { outcome: "skipped"; reason: string };

/**
 * pull_request.opened/synchronize/reopened -> a security review through
 * the same createSecurityReview service the API and MCP use. Deduplicates
 * by GitHub's own delivery id so a webhook retry never creates a second
 * run — the run-level idempotency key would also catch it, but dedup here
 * avoids the wasted authorization/DB round trip entirely.
 */
export async function processPullRequestEvent(
  prisma: PrismaClient,
  jobQueue: JobQueue,
  params: ProcessPullRequestEventParams,
): Promise<ProcessPullRequestEventResult> {
  const existing = await prisma.inboundGithubEvent.findUnique({ where: { deliveryId: params.deliveryId } });
  if (existing) {
    return { outcome: "skipped", reason: "duplicate delivery" };
  }

  const parsed = pullRequestWebhookSchema.safeParse(params.payload);
  if (!parsed.success) {
    await recordDelivery(prisma, params);
    return { outcome: "skipped", reason: "unrecognized payload shape" };
  }

  if (!TRACKED_PULL_REQUEST_ACTIONS.has(parsed.data.action)) {
    await recordDelivery(prisma, params);
    return { outcome: "skipped", reason: `action "${parsed.data.action}" is not tracked` };
  }

  const repository = await prisma.repository.findFirst({
    where: { provider: "github", owner: parsed.data.repository.owner.login, name: parsed.data.repository.name },
  });
  if (!repository) {
    await recordDelivery(prisma, params);
    return { outcome: "skipped", reason: "repository is not connected to SHLD" };
  }

  const githubAgent = await getOrCreateGithubAgentIdentity(prisma, repository.organizationId);

  const result = await createSecurityReview(prisma, jobQueue, {
    agent: githubAgent,
    repositoryId: repository.id,
    baseSha: parsed.data.pull_request.base.sha,
    headSha: parsed.data.pull_request.head.sha,
    pullRequestNumber: parsed.data.pull_request.number,
  });

  await recordDelivery(prisma, params);
  return { outcome: "created", runId: result.runId, status: result.status };
}

async function recordDelivery(prisma: PrismaClient, params: ProcessPullRequestEventParams): Promise<void> {
  await prisma.inboundGithubEvent.create({
    data: { deliveryId: params.deliveryId, eventType: params.eventType },
  });
}
