import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

/** Shared snake_case error codes; routes may add feature-specific ones. */
export type ErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_request"
  | "unauthenticated"
  | "rate_limited"
  | "cannot_send"
  | "too_large"
  | (string & {});

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    /** Extra fields sent next to `error`, e.g. `{ reason: "blocked" }` for `cannot_send`. */
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(code);
    this.name = "AppError";
  }
}

export const notFound = (): AppError => new AppError(404, "not_found");

/**
 * Fastify's `frameworkErrors`: failures the router meets before any route or hook (a path that is not
 * valid percent-encoding, a path parameter over the length limit). Answered in our error shape, keeping
 * the router's 4xx status.
 */
export function frameworkErrors(err: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
  const status = err.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    void reply.code(status).send({ error: "invalid_request" });
    return;
  }
  req.log.error({ err }, "router error");
  void reply.code(500).send({ error: "internal" });
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, ...err.details });
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const status = (err as FastifyError).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      // Framework-level client errors: malformed JSON, bad content type, oversized body...
      if (status === 429) return reply.code(429).send({ error: "rate_limited" });
      if (status === 413) return reply.code(413).send({ error: "too_large" });
      if (status === 404) return reply.code(404).send({ error: "not_found" });
      return reply.code(status).send({ error: "invalid_request" });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal" });
  });
}
