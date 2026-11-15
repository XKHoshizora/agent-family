import type { FastifyInstance, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { AppError } from "./errors.ts";

/**
 * The client's address: what every address-keyed rate limit counts (and what the request log shows).
 *
 * With `CLIENT_IP_HEADER` set (behind a proxy that writes that header, replacing whatever the client sent;
 * Railway: `x-real-ip`) it is that header's value when it is exactly one address. Otherwise — no header, an
 * empty one, several values, anything that is not an address, or no header configured — it is Fastify's
 * `req.ip`: the socket's address, or, when the connection comes from a proxy listed in `TRUST_PROXY`, the
 * right-most X-Forwarded-For entry no listed proxy wrote. A header nobody configured is never read, so a
 * client cannot choose its own key.
 */
export function clientIp(req: FastifyRequest): string {
  const header = req.server.deps.config.clientIpHeader;
  if (header !== undefined) {
    const value = req.headers[header];
    if (typeof value === "string") {
      const address = value.trim();
      if (isIP(address) !== 0) return address.toLowerCase();
    }
  }
  return req.ip;
}

/** Counts one request of `principalId`; throws 429 `rate_limited` when it is over the budget. */
export type PrincipalLimit = (req: FastifyRequest, principalId: string) => Promise<void>;

/**
 * A budget of `max × RATE_LIMIT_SCALE` requests per principal per `timeWindow`, shared by every route that
 * calls the returned function (each call of `perPrincipalLimit` is a budget of its own). Refused requests
 * count too.
 */
export function perPrincipalLimit(app: FastifyInstance, max: number, timeWindow = "1 minute"): PrincipalLimit {
  const principals = new WeakMap<FastifyRequest, string>();
  const limit = app.createRateLimit({
    max: Math.max(1, Math.round(max * app.deps.config.rateLimitScale)),
    timeWindow,
    keyGenerator: (req: FastifyRequest) => principals.get(req) ?? clientIp(req),
  });
  return async (req, principalId) => {
    principals.set(req, principalId);
    const result = await limit(req);
    if ("isExceeded" in result && result.isExceeded) throw new AppError(429, "rate_limited");
  };
}
