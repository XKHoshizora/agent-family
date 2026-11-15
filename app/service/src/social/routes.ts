import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { findByHandle } from "../principals/store.ts";
import { requirePrincipal } from "../session.ts";
import { blockPrincipal, unblockPrincipal, type BlockResult } from "./blocks.ts";
import type { SocialListener } from "./events.ts";
import {
  decideRequest,
  readRequest,
  sendRequest,
  socialView,
  unfriend,
  type Outcome,
  type Refusal,
} from "./friends.ts";

const STATUS: Record<Refusal, number> = {
  not_found: 404,
  blocked: 403,
  already_friends: 409,
  request_pending: 409,
  request_expired: 409,
  request_not_pending: 409,
};

/** Subscribe to "these principals' friends/blocks/requests changed" (fires after commit). Returns unsubscribe. */
export function onSocialChanged(app: FastifyInstance, fn: SocialListener): () => void {
  return app.deps.social.on(fn);
}

const publicPrincipal = z.object({ id: z.string(), handle: z.string(), displayName: z.string() });
const requestEntry = z.object({
  id: z.string(),
  principal: publicPrincipal,
  createdAt: z.string(),
  expiresAt: z.string(),
});
const ok = z.object({ ok: z.literal(true) });
const empty = z.object({});

export function registerSocialRoutes(app: FastifyInstance): void {
  const { db, config, social } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  const actors = new WeakMap<FastifyRequest, string>();
  const createLimit = app.createRateLimit({
    max: Math.max(1, Math.round(20 * config.rateLimitScale)),
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => actors.get(req) ?? req.ip,
  });

  /**
   * Runs a mutation in one transaction. A refusal commits whatever the mutation wrote (e.g. a lazily
   * persisted expiry) and then becomes an error response; success is announced only after commit.
   */
  async function run<T>(
    req: FastifyRequest,
    fn: (t: Tx) => Promise<Outcome<T>>,
    affected: (r: T) => string[],
  ): Promise<T> {
    const result = await db.tx(fn);
    if (!result.ok) throw new AppError(STATUS[result.code], result.code);
    social.emit(affected(result), req.log);
    return result;
  }

  api.post(
    "/api/friend-requests",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.object({
          handle: z
            .string()
            .max(100)
            .transform((s) => s.toLowerCase())
            .pipe(z.string().regex(/^[a-z0-9_]{3,24}$/)),
        }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      actors.set(req, me.id);
      const limited = await createLimit(req);
      if ("isExceeded" in limited && limited.isExceeded) throw new AppError(429, "rate_limited");

      const target = await findByHandle(db, req.body.handle);
      if (!target) throw new AppError(404, "not_found");
      if (target.id === me.id) throw new AppError(400, "invalid_request");
      const r = await run(req, (t) => sendRequest(t, me.id, target.id), () => [me.id, target.id]);
      return reply.code(201).send({ id: r.id });
    },
  );

  api.get(
    "/api/friend-requests/:id",
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        querystring: empty,
        response: {
          200: z.object({
            id: z.string(),
            status: z.enum(["pending", "accepted", "rejected", "withdrawn", "expired"]),
            fromId: z.string(),
            toId: z.string(),
            createdAt: z.string(),
            expiresAt: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const r = await readRequest(db, me.id, req.params.id);
      if (!r) throw new AppError(404, "not_found");
      return {
        id: r.id,
        status: r.status,
        fromId: r.fromId,
        toId: r.toId,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      };
    },
  );

  for (const decision of ["accept", "reject", "withdraw"] as const) {
    api.post(
      `/api/friend-requests/:id/${decision}`,
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          querystring: empty,
          response: { 200: z.object({ ok: z.literal(true), conversationId: z.string().nullable() }) },
        },
      },
      async (req) => {
        const me = await requirePrincipal(req);
        const r = await run(req, (t) => decideRequest(t, me.id, req.params.id, decision), (x) => [x.fromId, x.toId]);
        return { ok: true as const, conversationId: r.conversationId };
      },
    );
  }

  api.delete(
    "/api/friends/:principalId",
    { schema: { params: z.object({ principalId: z.uuid() }), querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      const other = req.params.principalId;
      await run(req, (t) => unfriend(t, me.id, other), () => [me.id, other]);
      return { ok: true as const };
    },
  );

  api.put(
    "/api/blocks/:principalId",
    { schema: { params: z.object({ principalId: z.uuid() }), querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      const other = req.params.principalId;
      if (other === me.id) throw new AppError(400, "invalid_request");
      await run<BlockResult>(
        req,
        async (t): Promise<Outcome<BlockResult>> => {
          const exists = await t.query("select 1 from principals where id = $1", [other]);
          if (exists.rowCount === 0) return { ok: false, code: "not_found" };
          return { ok: true, ...(await blockPrincipal(t, me.id, other)) };
        },
        () => [me.id, other],
      );
      return { ok: true as const };
    },
  );

  api.delete(
    "/api/blocks/:principalId",
    { schema: { params: z.object({ principalId: z.uuid() }), querystring: empty, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      const other = req.params.principalId;
      const r = await db.tx((t) => unblockPrincipal(t, me.id, other));
      if (r.removed) social.emit([me.id, other], req.log);
      return { ok: true as const };
    },
  );

  api.get(
    "/api/social",
    {
      schema: {
        params: empty,
        querystring: empty,
        response: {
          200: z.object({
            friends: z.array(publicPrincipal),
            incoming: z.array(requestEntry),
            outgoing: z.array(requestEntry),
            blocked: z.array(publicPrincipal),
            blockedBy: z.array(publicPrincipal),
          }),
        },
      },
    },
    async (req) => socialView(db, (await requirePrincipal(req)).id),
  );
}
