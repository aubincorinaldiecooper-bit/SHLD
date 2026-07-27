import type { PrismaClient } from "@prisma/client";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import { gatherReceiptData } from "./gather-receipt-data.js";
import { computeReceiptStatus, type ReceiptStatus } from "./receipt-status.js";
import { renderReceiptJson, type ReceiptJson } from "./render-receipt-json.js";
import { renderReceiptMarkdown } from "./render-receipt-markdown.js";

export interface GenerateReceiptOutcome {
  receiptId: string;
  status: ReceiptStatus;
  json: ReceiptJson;
  markdown: string;
  jsonArtifactId: string;
  markdownArtifactId: string;
}

/**
 * Generates (or regenerates) the receipt for a run: gathers the full
 * structured picture, derives the status from run + finding state, renders
 * both formats, stores each as a restricted artifact, and upserts the
 * Receipt row pointing at them.
 */
export async function generateReceipt(
  prisma: PrismaClient,
  artifactStore: ArtifactStore,
  runId: string,
): Promise<GenerateReceiptOutcome> {
  const data = await gatherReceiptData(prisma, runId);
  const status = computeReceiptStatus(
    data.runStatus as Parameters<typeof computeReceiptStatus>[0],
    data.findings.map((f) => f.status) as Parameters<typeof computeReceiptStatus>[1],
  );

  const json = renderReceiptJson(data, status);
  const markdown = renderReceiptMarkdown(data, status);

  const storedJson = await artifactStore.store(JSON.stringify(json, null, 2), "receipts");
  const storedMarkdown = await artifactStore.store(markdown, "receipts");

  const receipt = await prisma.$transaction(async (tx) => {
    const jsonArtifact = await tx.artifact.create({
      data: {
        organizationId: data.organizationId,
        runId: data.runId,
        type: "receipt_json",
        storageLocation: storedJson.storageLocation,
        contentHash: storedJson.contentHash,
      },
    });
    const markdownArtifact = await tx.artifact.create({
      data: {
        organizationId: data.organizationId,
        runId: data.runId,
        type: "receipt_markdown",
        storageLocation: storedMarkdown.storageLocation,
        contentHash: storedMarkdown.contentHash,
      },
    });

    return tx.receipt.upsert({
      where: { runId: data.runId },
      create: {
        runId: data.runId,
        status,
        jsonArtifactId: jsonArtifact.id,
        markdownArtifactId: markdownArtifact.id,
      },
      update: {
        status,
        jsonArtifactId: jsonArtifact.id,
        markdownArtifactId: markdownArtifact.id,
        generatedAt: new Date(),
      },
    });
  });

  return {
    receiptId: receipt.id,
    status,
    json,
    markdown,
    jsonArtifactId: receipt.jsonArtifactId!,
    markdownArtifactId: receipt.markdownArtifactId!,
  };
}
