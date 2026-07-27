import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { IdempotencyConflictError } from "../domain/errors.js";

export interface WithIdempotencyParams {
  organizationId: string;
  endpoint: string;
  idempotencyKey: string;
  requestBody: unknown;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  deduplicated: boolean;
}

function hashRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

/**
 * Wraps a mutation handler so a repeated call with the same Idempotency-Key
 * returns the original response instead of re-executing side effects. A
 * repeated key with a *different* request body is a client bug, not a
 * cache hit — it's rejected rather than silently returning a mismatched
 * response.
 */
export async function withIdempotency<T>(
  prisma: PrismaClient,
  params: WithIdempotencyParams,
  handler: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashRequest(params.requestBody);

  const existing = await prisma.idempotencyRecord.findUnique({
    where: {
      organizationId_endpoint_idempotencyKey: {
        organizationId: params.organizationId,
        endpoint: params.endpoint,
        idempotencyKey: params.idempotencyKey,
      },
    },
  });

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        `Idempotency-Key "${params.idempotencyKey}" was already used with a different request body`,
      );
    }
    return { status: existing.responseStatus, body: existing.responseBody as T, deduplicated: true };
  }

  const result = await handler();

  await prisma.idempotencyRecord.create({
    data: {
      organizationId: params.organizationId,
      endpoint: params.endpoint,
      idempotencyKey: params.idempotencyKey,
      requestHash,
      responseStatus: result.status,
      responseBody: result.body as Prisma.InputJsonValue,
    },
  });

  return { ...result, deduplicated: false };
}
