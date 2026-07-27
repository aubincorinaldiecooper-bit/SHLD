import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { JobQueue } from "../orchestration/job-queue.js";
import type { AuthenticatedAgent } from "../auth/authenticate-agent.js";
import { createSecurityReview } from "../api/services/create-security-review.js";
import { getRun } from "../api/services/get-run.js";
import {
  getFinding,
  submitFixForFinding,
  validateFinding,
  verifyFixForFinding,
} from "../api/services/finding-services.js";
import { getReceipt } from "../api/services/get-receipt.js";

export interface McpServerContext {
  prisma: PrismaClient;
  jobQueue: JobQueue;
  artifactStore: ArtifactStore;
  agent: AuthenticatedAgent;
}

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textResult(data: unknown): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown): ToolTextResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * MCP tool -> API service -> authorization -> policy -> orchestration ->
 * engine adapter, exactly per the spec's architecture diagram. Every tool
 * here calls the *same* service function the HTTP API route calls — no
 * DeepSec/Strix access, no separate run state, no separate routing rules.
 * The agent identity is resolved once when the server starts (one MCP
 * server process per agent connection), so every tool call runs with the
 * same authorization/permission checks a direct API call would get.
 */
export function createShldMcpServer(ctx: McpServerContext): McpServer {
  const server = new McpServer({ name: "shld-security", version: "0.1.0" });

  server.registerTool(
    "security_review_change",
    {
      description:
        "Submit a repository change (a resolved base/head commit pair) for security review. Change-scoped by default.",
      inputSchema: {
        repository_id: z.string(),
        base_sha: z.string(),
        head_sha: z.string(),
        pull_request_number: z.number().int().optional(),
        target_environment_id: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const result = await createSecurityReview(ctx.prisma, ctx.jobQueue, {
          agent: ctx.agent,
          repositoryId: args.repository_id,
          baseSha: args.base_sha,
          headSha: args.head_sha,
          pullRequestNumber: args.pull_request_number,
          targetEnvironmentId: args.target_environment_id,
        });
        return textResult({ run_id: result.runId, status: result.status });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "security_get_run",
    {
      description:
        "Get a security run's status, current phase, findings, routing decisions, engine executions, and required next action.",
      inputSchema: { run_id: z.string() },
    },
    async (args) => {
      try {
        return textResult(await getRun(ctx.prisma, ctx.agent, args.run_id));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "security_get_finding",
    {
      description: "Get a normalized finding and its source/runtime evidence.",
      inputSchema: { finding_id: z.string() },
    },
    async (args) => {
      try {
        return textResult(await getFinding(ctx.prisma, ctx.agent, args.finding_id));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "security_validate_finding",
    {
      description:
        "Request focused runtime validation of a finding against an authorized target environment. Does not bypass policy or authorization.",
      inputSchema: { finding_id: z.string(), target_environment_id: z.string() },
    },
    async (args) => {
      try {
        const result = await validateFinding(
          ctx.prisma,
          ctx.jobQueue,
          ctx.agent,
          args.finding_id,
          args.target_environment_id,
        );
        return textResult({ run_id: result.runId, status: result.status });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "security_submit_fix",
    {
      description: "Attach a fix commit to a finding, queuing it for verification.",
      inputSchema: { finding_id: z.string(), fix_commit_sha: z.string() },
    },
    async (args) => {
      try {
        const result = await submitFixForFinding(ctx.prisma, ctx.agent, args.finding_id, args.fix_commit_sha);
        return textResult({ finding_id: result.findingId, status: result.status });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "security_verify_fix",
    {
      description:
        "Start fix verification: DeepSec source revalidation, plus a Strix replay of the original exploit when the finding was runtime-confirmed. An agent's claim that the fix is complete is never sufficient on its own.",
      inputSchema: { finding_id: z.string(), target_environment_id: z.string().optional() },
    },
    async (args) => {
      try {
        const result = await verifyFixForFinding(
          ctx.prisma,
          ctx.jobQueue,
          ctx.agent,
          args.finding_id,
          args.target_environment_id,
        );
        return textResult({ run_id: result.runId, status: result.status });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "security_get_receipt",
    {
      description: "Retrieve the final security verification receipt for a run, in JSON or Markdown.",
      inputSchema: { run_id: z.string(), format: z.enum(["json", "markdown"]).optional() },
    },
    async (args) => {
      try {
        const receipt = await getReceipt(ctx.prisma, ctx.artifactStore, ctx.agent, args.run_id, args.format ?? "json");
        return { content: [{ type: "text", text: receipt.body }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
