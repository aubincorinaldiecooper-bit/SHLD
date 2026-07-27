import type { PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "../../artifacts/artifact-store.js";
import type { AuthenticatedAgent } from "../../auth/authenticate-agent.js";
import { assertSameOrganization } from "../../auth/tenant-isolation.js";
import { NotFoundError } from "../../domain/errors.js";
import { generateReceipt } from "../../receipts/generate-receipt.js";

export type ReceiptFormat = "json" | "markdown";

/** Retrieve Receipt (GET /v1/security/runs/{run_id}/receipt). Generates on demand if not already cached. */
export async function getReceipt(
  prisma: PrismaClient,
  artifactStore: ArtifactStore,
  agent: AuthenticatedAgent,
  runId: string,
  format: ReceiptFormat,
): Promise<{ contentType: string; body: string }> {
  const run = await prisma.securityRun.findUnique({ where: { id: runId } });
  if (!run) throw new NotFoundError(`Security run ${runId} not found`);
  assertSameOrganization(agent.organizationId, run.organizationId, "security run");

  const existing = await prisma.receipt.findUnique({ where: { runId } });
  const artifactId = existing
    ? format === "json"
      ? existing.jsonArtifactId
      : existing.markdownArtifactId
    : null;

  if (existing && artifactId) {
    const artifact = await prisma.artifact.findUnique({ where: { id: artifactId } });
    if (artifact) {
      const content = await artifactStore.read(artifact.storageLocation);
      return {
        contentType: format === "json" ? "application/json" : "text/markdown",
        body: content.toString("utf8"),
      };
    }
  }

  const generated = await generateReceipt(prisma, artifactStore, runId);
  return format === "json"
    ? { contentType: "application/json", body: JSON.stringify(generated.json, null, 2) }
    : { contentType: "text/markdown", body: generated.markdown };
}
