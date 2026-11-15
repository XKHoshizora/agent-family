import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { onSessionEnded } from "../auth/auth.ts";
import { AppError } from "../errors.ts";
import { wireMessageSchema } from "../messages/model.ts";
import { requirePrincipal } from "../session.ts";
import { Hub } from "./hub.ts";
import { CATCHUP_MAX_POSITIONS, catchUp, syncView } from "./read.ts";
import { createTicketStore, type TicketStore } from "./tickets.ts";
import { registerWebSocketRoute } from "./ws.ts";

const empty = z.object({});
const role = z.enum(["speaker", "observer"]);

const syncResponse = z.object({
  me: z.object({ id: z.string(), handle: z.string(), displayName: z.string(), email: z.string() }),
  conversations: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["direct", "group"]),
      title: z.string().nullable(),
      creatorId: z.string(),
      myRole: role,
      closed: z.boolean(),
      peerId: z.string().optional(),
      canSend: z.object({ ok: z.boolean(), reason: z.enum(["blocked", "not_friends", "closed"]).optional() }),
      members: z.array(z.object({ id: z.string(), role, isCreator: z.boolean() })),
      lastSeq: z.number(),
      readSeq: z.number(),
      unread: z.number(),
      peerReadSeq: z.number().optional(),
    }),
  ),
  principals: z.array(
    z.object({ id: z.string(), handle: z.string(), displayName: z.string(), kind: z.enum(["human", "agent"]) }),
  ),
  messages: z.array(wireMessageSchema),
});

/** `{conversationId: lastSeqTheClientHas}`: ≤ 500 uuid keys (case-insensitive, lower-cased), bounded non-negative integers. */
const positions = z
  .record(z.uuid(), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
  .refine((r) => Object.keys(r).length <= CATCHUP_MAX_POSITIONS, "too many positions")
  .refine((r) => new Set(Object.keys(r).map((k) => k.toLowerCase())).size === Object.keys(r).length, "duplicate id")
  .transform((r) => new Map(Object.entries(r).map(([id, seq]) => [id.toLowerCase(), seq])));

const catchUpResponse = z.object({ messages: z.array(wireMessageSchema), gone: z.array(z.string()), more: z.boolean() });

/** A per-principal limiter of `perMinute × RATE_LIMIT_SCALE` requests; throws 429 `rate_limited`. */
function perPrincipalLimit(app: FastifyInstance, perMinute: number): (req: FastifyRequest, principalId: string) => Promise<void> {
  const actors = new WeakMap<FastifyRequest, string>();
  const limit = app.createRateLimit({
    max: Math.max(1, Math.round(perMinute * app.deps.config.rateLimitScale)),
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => actors.get(req) ?? req.ip,
  });
  return async (req, principalId) => {
    actors.set(req, principalId);
    const result = await limit(req);
    if ("isExceeded" in result && result.isExceeded) throw new AppError(429, "rate_limited");
  };
}

function registerSyncRoutes(app: FastifyInstance, tickets: TicketStore): void {
  const { db } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const ticketLimit = perPrincipalLimit(app, 30);
  const syncLimit = perPrincipalLimit(app, 60);
  const catchUpLimit = perPrincipalLimit(app, 60);

  api.get(
    "/api/sync",
    { schema: { params: empty, querystring: empty, response: { 200: syncResponse } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await syncLimit(req, me.id);
      const view = await syncView(db, me.id);
      return { me: { id: me.id, handle: me.handle, displayName: me.displayName, email: me.email }, ...view };
    },
  );

  api.post(
    "/api/sync/catchup",
    {
      schema: { params: empty, querystring: empty, body: z.object({ positions }), response: { 200: catchUpResponse } },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await catchUpLimit(req, me.id);
      return catchUp(db, me.id, req.body.positions);
    },
  );

  api.post(
    "/api/ws-ticket",
    {
      // No body (Fastify passes null) or an empty JSON object.
      schema: { params: empty, querystring: empty, body: empty.nullish(), response: { 200: z.object({ ticket: z.string() }) } },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await ticketLimit(req, me.id);
      return { ticket: tickets.issue({ principalId: me.id, sessionId: me.sessionId }) };
    },
  );
}

/**
 * Sync, catch-up and pushes: `GET /api/sync`, `POST /api/sync/catchup`, `POST /api/ws-ticket`,
 * `GET /api/ws`. The ticket store and the hub live in this process (single instance; see README).
 */
export async function registerSync(app: FastifyInstance): Promise<void> {
  const { db, conversations, social, reads } = app.deps;
  const tickets = createTicketStore();
  const hub = new Hub({ db, conversations, social, reads, log: app.log });
  hub.start();
  const offSessionEnded = onSessionEnded(app, (_principalId, sessionId) => {
    tickets.revokeSession(sessionId);
    hub.endSession(sessionId);
  });
  app.addHook("onClose", async () => {
    offSessionEnded();
    hub.stop();
  });
  app.decorate("realtime", hub);

  // The WebSocket plugin first: it wraps (through an onRoute hook) only routes registered after it, and
  // refusing an upgrade to any other route relies on that.
  await registerWebSocketRoute(app, hub, tickets);
  registerSyncRoutes(app, tickets);
}
