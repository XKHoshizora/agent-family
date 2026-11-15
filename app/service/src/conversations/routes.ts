import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError, notFound } from "../errors.ts";
import { userText, uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { addMember, createGroup, removeMember, renameGroup } from "./groups.ts";
import { listMembers } from "./store.ts";

const empty = z.object({});
const ok = z.object({ ok: z.literal(true) });
const title = userText(1, 60, { singleLine: true });
const idParams = z.object({ id: uuidParam });

export function registerConversationRoutes(app: FastifyInstance): void {
  const { db, config, conversations } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  const actors = new WeakMap<FastifyRequest, string>();
  const createLimit = app.createRateLimit({
    max: Math.max(1, Math.round(10 * config.rateLimitScale)),
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => actors.get(req) ?? req.ip,
  });

  api.post(
    "/api/conversations",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.object({
          title,
          // Bounded only to keep input small; the 500-member rule is a 403 in createGroup.
          memberIds: z.array(uuidParam).min(2).max(1000),
        }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      actors.set(req, me.id);
      const limited = await createLimit(req);
      if ("isExceeded" in limited && limited.isExceeded) throw new AppError(429, "rate_limited");

      const { conversationId, change } = await db.tx((t) => createGroup(t, me.id, req.body.title, req.body.memberIds));
      conversations.publish(change, req.log);
      return reply.code(201).send({ id: conversationId });
    },
  );

  api.patch(
    "/api/conversations/:id",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: z.object({ title }),
        response: { 200: z.object({ id: z.string(), title: z.string() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const change = await db.tx((t) => renameGroup(t, req.params.id, me.id, req.body.title));
      conversations.publish(change, req.log);
      return { id: req.params.id, title: req.body.title };
    },
  );

  api.get(
    "/api/conversations/:id/members",
    {
      schema: {
        params: idParams,
        querystring: empty,
        response: {
          200: z.object({
            members: z.array(
              z.object({
                id: z.string(),
                handle: z.string(),
                displayName: z.string(),
                kind: z.enum(["human", "agent"]),
                role: z.enum(["speaker", "observer"]),
                isCreator: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const members = await listMembers(db, me.id, req.params.id);
      if (!members) throw notFound();
      return { members };
    },
  );

  api.post(
    "/api/conversations/:id/members",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: z.object({ principalId: uuidParam }),
        response: { 201: ok },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      const change = await db.tx((t) => addMember(t, req.params.id, me.id, req.body.principalId));
      conversations.publish(change, req.log);
      return reply.code(201).send({ ok: true as const });
    },
  );

  api.delete(
    "/api/conversations/:id/members/:principalId",
    {
      schema: {
        params: z.object({ id: uuidParam, principalId: uuidParam }),
        querystring: empty,
        response: { 200: ok },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const change = await db.tx((t) => removeMember(t, req.params.id, me.id, req.params.principalId));
      conversations.publish(change, req.log);
      return { ok: true as const };
    },
  );
}
