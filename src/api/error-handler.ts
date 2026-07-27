import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  AuthorizationError,
  BudgetExceededError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  PolicyViolationError,
  TargetAuthorizationError,
} from "../domain/errors.js";

/** Maps the platform's domain errors to HTTP status codes consistently across every route. */
export function apiErrorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof NotFoundError) {
    reply.code(404).send({ error: "not_found", message: error.message });
    return;
  }
  if (error instanceof AuthorizationError || error instanceof TargetAuthorizationError) {
    reply.code(403).send({ error: "forbidden", message: error.message });
    return;
  }
  if (error instanceof BudgetExceededError) {
    reply.code(429).send({ error: "budget_exceeded", message: error.message });
    return;
  }
  if (error instanceof IdempotencyConflictError) {
    reply.code(409).send({ error: "idempotency_conflict", message: error.message });
    return;
  }
  if (error instanceof InvalidStateTransitionError) {
    reply.code(409).send({ error: "invalid_state_transition", message: error.message });
    return;
  }
  if (error instanceof PolicyViolationError) {
    reply.code(422).send({ error: "policy_violation", message: error.message });
    return;
  }
  if (error instanceof ZodError) {
    reply.code(400).send({ error: "invalid_request", message: error.message, issues: error.issues });
    return;
  }
  if ((error as FastifyError).validation) {
    reply.code(400).send({ error: "invalid_request", message: error.message });
    return;
  }

  request.log.error(error);
  reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}
