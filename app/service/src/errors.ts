import type { FastifyError, FastifyInstance } from "fastify";
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
  ) {
    super(code);
    this.name = "AppError";
  }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code });
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const status = (err as FastifyError).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      // Framework-level client errors: malformed JSON, bad content type, oversized body...
      if (status === 413) return reply.code(413).send({ error: "too_large" });
      if (status === 404) return reply.code(404).send({ error: "not_found" });
      return reply.code(status).send({ error: "invalid_request" });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal" });
  });
}
