import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { authenticateSession, type AuthenticatedUser } from "../auth/sessions.js";
import { AuthorizationError } from "../domain/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    dashboardUser?: AuthenticatedUser;
  }
}

export interface SessionAuthPluginOptions {
  prisma: PrismaClient;
  cookieName?: string;
}

/**
 * Resolves the `shld_session` cookie into `request.dashboardUser` for
 * every route under /dashboard. Session *creation* (the login flow) is
 * out of scope for this beta — see the final report — so tests exercise
 * this by inserting a Session row directly, the same way a real login
 * flow eventually would via createSession.
 */
export const dashboardSessionAuthPlugin = fp(async function dashboardSessionAuthPluginImpl(
  fastify: FastifyInstance,
  options: SessionAuthPluginOptions,
) {
  const cookieName = options.cookieName ?? "shld_session";
  fastify.decorateRequest("dashboardUser", undefined);

  fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/dashboard")) return;

    const cookieHeader = request.headers.cookie ?? "";
    const match = cookieHeader.match(new RegExp(`${cookieName}=([^;]+)`));
    if (!match) {
      await reply.code(401).send("Not authenticated. Please log in.");
      return reply;
    }

    try {
      request.dashboardUser = await authenticateSession(options.prisma, decodeURIComponent(match[1]!));
    } catch (error) {
      if (error instanceof AuthorizationError) {
        await reply.code(401).send("Session expired or invalid. Please log in again.");
        return reply;
      }
      throw error;
    }
  });
});
