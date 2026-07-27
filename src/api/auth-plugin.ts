import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { authenticateAgentByApiKey, type AuthenticatedAgent } from "../auth/authenticate-agent.js";
import { AuthorizationError } from "../domain/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    agent?: AuthenticatedAgent;
  }
}

export interface AuthPluginOptions {
  prisma: PrismaClient;
}

/**
 * Resolves `Authorization: Bearer <key>` into `request.agent` for every
 * route under /v1/security. The same authentication path the MCP server
 * uses — there is exactly one way an agent identity gets established.
 */
export const authPlugin = fp(async function authPluginImpl(fastify: FastifyInstance, options: AuthPluginOptions) {
  fastify.decorateRequest("agent", undefined);

  fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/v1/security")) return;

    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      await reply.code(401).send({ error: "unauthorized", message: "Missing Authorization: Bearer <api-key> header" });
      return reply;
    }

    try {
      request.agent = await authenticateAgentByApiKey(options.prisma, header.slice("Bearer ".length));
    } catch (error) {
      if (error instanceof AuthorizationError) {
        await reply.code(401).send({ error: "unauthorized", message: error.message });
        return reply;
      }
      throw error;
    }
  });
});
