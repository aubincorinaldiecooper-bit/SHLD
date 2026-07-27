import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, UserRole } from "@prisma/client";
import { AuthorizationError } from "../domain/errors.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export interface AuthenticatedUser {
  userId: string;
  organizationId: string;
  role: UserRole;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Dashboard session auth. The raw token lives only in the response cookie. */
export async function createSession(prisma: PrismaClient, userId: string): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });
  return { token, expiresAt };
}

export async function authenticateSession(prisma: PrismaClient, token: string): Promise<AuthenticatedUser> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    throw new AuthorizationError("Invalid or expired session");
  }
  return {
    userId: session.user.id,
    organizationId: session.user.organizationId,
    role: session.user.role,
  };
}

export async function revokeSession(prisma: PrismaClient, token: string): Promise<void> {
  await prisma.session.updateMany({
    where: { tokenHash: hashToken(token) },
    data: { revokedAt: new Date() },
  });
}
