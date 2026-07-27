import { z } from "zod";

export const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    head: z.object({ sha: z.string() }),
    base: z.object({ sha: z.string() }),
  }),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
  installation: z.object({ id: z.number() }).optional(),
});
export type PullRequestWebhookPayload = z.infer<typeof pullRequestWebhookSchema>;

/** Only these pull_request actions trigger a security review. */
export const TRACKED_PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
