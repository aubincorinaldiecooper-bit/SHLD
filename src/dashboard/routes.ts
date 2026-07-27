import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { getRun } from "../api/services/get-run.js";
import { getFinding, listRunFindings } from "../api/services/finding-services.js";
import { esc, layout, statusBadge } from "./render.js";

export interface DashboardContext {
  prisma: PrismaClient;
}

/**
 * Minimal, read-only operator views per the spec: Runs, Run Detail,
 * Finding Detail, Settings. No compliance dashboards, analytics, or
 * report builders — just enough to see what the API-driven verification
 * loop is doing. Every page reuses the same service functions the API
 * and MCP call (see get-run.ts / finding-services.ts).
 */
export function registerDashboardRoutes(fastify: FastifyInstance, ctx: DashboardContext): void {
  fastify.get("/dashboard/runs", async (request, reply) => {
    const runs = await ctx.prisma.securityRun.findMany({
      where: { organizationId: request.dashboardUser!.organizationId },
      include: { repository: true, requestedByAgent: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const rows = runs
      .map(
        (run) => `<tr>
          <td><a href="/dashboard/runs/${esc(run.id)}">${esc(run.repository.owner)}/${esc(run.repository.name)}</a></td>
          <td>${run.pullRequestNumber ? `#${esc(run.pullRequestNumber)}` : esc(run.headSha.slice(0, 7))}</td>
          <td>${esc(run.requestedByAgent.name)}</td>
          <td>${esc(run.runType)}</td>
          <td>${statusBadge(run.status)}</td>
          <td>${esc(run.createdAt.toISOString())}</td>
        </tr>`,
      )
      .join("\n");

    reply
      .type("text/html")
      .send(
        layout(
          "Runs",
          `<h1>Security Runs</h1>
          <table>
            <thead><tr><th>Repository</th><th>PR / Commit</th><th>Agent</th><th>Type</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6">No runs yet.</td></tr>'}</tbody>
          </table>`,
        ),
      );
  });

  fastify.get("/dashboard/runs/:run_id", async (request, reply) => {
    const { run_id } = request.params as { run_id: string };
    const run = await getRun(ctx.prisma, request.dashboardUser!, run_id);
    const findings = await listRunFindings(ctx.prisma, request.dashboardUser!, run_id);

    const findingRows = findings
      .map(
        (f) => `<tr>
          <td><a href="/dashboard/findings/${esc(f.id)}">${esc(f.title)}</a></td>
          <td>${esc(f.severity)}</td>
          <td>${esc(f.category)}</td>
          <td>${statusBadge(f.status)}</td>
        </tr>`,
      )
      .join("\n");

    reply.type("text/html").send(
      layout(
        `Run ${run.runId}`,
        `<h1>Run ${esc(run.runId)}</h1>
        <p>${esc(run.repository.owner)}/${esc(run.repository.name)} ${run.pullRequestNumber ? `#${esc(run.pullRequestNumber)}` : ""}
           — requested by ${esc(run.requestingAgent.name)}</p>
        <p>Status: ${statusBadge(run.status)} — ${esc(run.nextAction)}</p>
        <p>Base: <code>${esc(run.baseSha)}</code> &rarr; Head: <code>${esc(run.headSha)}</code></p>
        <p>Total cost: $${run.totalCostUsd.toFixed(4)}</p>
        <p><a href="/v1/security/runs/${esc(run.runId)}/receipt?format=markdown">View receipt (Markdown)</a></p>
        <h2>Findings</h2>
        <table>
          <thead><tr><th>Title</th><th>Severity</th><th>Category</th><th>Status</th></tr></thead>
          <tbody>${findingRows || '<tr><td colspan="4">No findings.</td></tr>'}</tbody>
        </table>
        <h2>Engine Executions</h2>
        <pre>${esc(JSON.stringify(run.engineExecutions, null, 2))}</pre>
        <h2>Routing Decisions</h2>
        <pre>${esc(JSON.stringify(run.routingDecisions, null, 2))}</pre>`,
      ),
    );
  });

  fastify.get("/dashboard/findings/:finding_id", async (request, reply) => {
    const { finding_id } = request.params as { finding_id: string };
    const finding = await getFinding(ctx.prisma, request.dashboardUser!, finding_id);

    reply.type("text/html").send(
      layout(
        finding.title,
        `<h1>${esc(finding.title)}</h1>
        <p>Status: ${statusBadge(finding.status)} — Severity: ${esc(finding.severity)} — Confidence: ${esc(finding.confidence)}</p>
        <p>Category: ${esc(finding.category)} ${finding.cwe ? `(${esc(finding.cwe)})` : ""}</p>
        <p>Discovered by: ${esc(finding.discoveryEngine)} (${esc(finding.findingClass)})</p>
        <h2>Description</h2>
        <p>${esc(finding.description)}</p>
        <h2>Source locations</h2>
        <pre>${esc(JSON.stringify(finding.sourceLocations, null, 2))}</pre>
        <h2>Runtime validations</h2>
        <pre>${esc(JSON.stringify(finding.validations, null, 2))}</pre>
        ${finding.remediation ? `<h2>Remediation</h2><pre>${esc(JSON.stringify(finding.remediation, null, 2))}</pre>` : ""}`,
      ),
    );
  });

  fastify.get("/dashboard/settings", async (request, reply) => {
    const organizationId = request.dashboardUser!.organizationId;
    const [repositories, targets, agents, webhooks] = await Promise.all([
      ctx.prisma.repository.findMany({ where: { organizationId } }),
      ctx.prisma.targetEnvironment.findMany({ where: { organizationId } }),
      ctx.prisma.agentIdentity.findMany({ where: { organizationId } }),
      ctx.prisma.webhookEndpoint.findMany({ where: { organizationId } }),
    ]);

    reply.type("text/html").send(
      layout(
        "Settings",
        `<h1>Settings</h1>
        <h2>Repositories</h2>
        <table><thead><tr><th>Repository</th><th>Status</th></tr></thead><tbody>
          ${repositories.map((r) => `<tr><td>${esc(r.owner)}/${esc(r.name)}</td><td>${esc(r.status)}</td></tr>`).join("") || '<tr><td colspan="2">None connected.</td></tr>'}
        </tbody></table>
        <h2>Target Environments</h2>
        <table><thead><tr><th>Name</th><th>Type</th><th>Base URL</th><th>Authorization</th></tr></thead><tbody>
          ${targets.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.environmentType)}</td><td>${esc(t.baseUrl)}</td><td>${esc(t.authorizationStatus)}</td></tr>`).join("") || '<tr><td colspan="4">None configured.</td></tr>'}
        </table>
        <h2>Agent Identities</h2>
        <table><thead><tr><th>Name</th><th>Type</th><th>Last used</th></tr></thead><tbody>
          ${agents.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.type)}</td><td>${a.lastUsedAt ? esc(a.lastUsedAt.toISOString()) : "never"}</td></tr>`).join("") || '<tr><td colspan="3">None.</td></tr>'}
        </table>
        <h2>Webhook Endpoints</h2>
        <table><thead><tr><th>URL</th><th>Events</th><th>Active</th></tr></thead><tbody>
          ${webhooks.map((w) => `<tr><td>${esc(w.url)}</td><td>${esc(w.eventTypes.join(", "))}</td><td>${esc(w.active)}</td></tr>`).join("") || '<tr><td colspan="3">None configured.</td></tr>'}
        </table>`,
      ),
    );
  });
}
