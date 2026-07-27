import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/**
 * Preserves the raw request body alongside Fastify's normal JSON parsing
 * so webhook signature verification (which must hash the exact bytes
 * sent, not a re-serialized version) has something to check against.
 * Every other route keeps using `request.body` as parsed JSON, unaffected.
 */
export const rawBodyPlugin = fp(async function rawBodyPluginImpl(fastify: FastifyInstance) {
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
});
