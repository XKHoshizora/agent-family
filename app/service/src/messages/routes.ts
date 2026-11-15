import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError, notFound } from "../errors.ts";
import { positiveInt, positiveIntString, userText, uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { wireMessageSchema } from "./model.ts";
import { getMessage, listMessages, markRead, toWireFor } from "./read.ts";
import { decodeSearchCursor, searchAll, searchConversation } from "./search.ts";
import { sendMessage } from "./send.ts";

const empty = z.object({});
const idParams = z.object({ id: uuidParam });
const sendResult = z.object({ message: wireMessageSchema, duplicate: z.boolean() });

const sendBody = z
  .object({
    // A caption may be empty; a text message may not (the refinement below).
    text: userText(0, 8000).optional(),
    attachmentId: uuidParam.optional(),
    replyToSeq: positiveInt.optional(),
    clientTxn: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .refine((b) => b.attachmentId !== undefined || (b.text !== undefined && b.text.length > 0), "text or attachmentId is required");

/** 1-100 characters after trimming, one line: `%`, `_` and `\` are ordinary characters (see search.ts). */
const searchTerm = userText(1, 100, { singleLine: true });
const searchLimit = positiveIntString(50);
const searchCursor = z
  .string()
  .transform((s, ctx) => {
    const cursor = decodeSearchCursor(s);
    if (!cursor) ctx.addIssue({ code: "custom", message: "malformed cursor" });
    return cursor ?? z.NEVER;
  });

export function registerMessageRoutes(app: FastifyInstance): void {
  const { db, config, conversations, reads } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  const actors = new WeakMap<FastifyRequest, string>();
  const sendLimit = app.createRateLimit({
    max: Math.max(1, Math.round(120 * config.rateLimitScale)),
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => actors.get(req) ?? req.ip,
  });

  api.post(
    "/api/conversations/:id/messages",
    {
      schema: { params: idParams, querystring: empty, body: sendBody, response: { 200: sendResult, 201: sendResult } },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      actors.set(req, me.id);
      const limited = await sendLimit(req);
      if ("isExceeded" in limited && limited.isExceeded) throw new AppError(429, "rate_limited");

      // Rendered inside the transaction, under the locks that just proved the sender may read it.
      const { message, duplicate, wire } = await db.tx(async (t) => {
        const sent = await sendMessage(t, req.params.id, me.id, req.body);
        const [rendered] = await toWireFor(t, me.id, [sent.message]);
        if (!rendered) throw new Error("sendMessage: sender cannot read the message it just stored");
        return { ...sent, wire: rendered };
      });
      if (!duplicate) conversations.publish({ messages: [message], conversations: [] }, req.log);
      return reply.code(duplicate ? 200 : 201).send({ message: wire, duplicate });
    },
  );

  api.get(
    "/api/conversations/:id/messages",
    {
      schema: {
        params: idParams,
        querystring: z.object({ before: positiveIntString().optional(), limit: positiveIntString(100).optional() }),
        response: { 200: z.object({ messages: z.array(wireMessageSchema), nextBefore: z.number().nullable() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const { before, limit = 50 } = req.query;
      const page = await listMessages(db, me.id, req.params.id, { before, limit });
      if (!page) throw notFound();
      return page;
    },
  );

  api.get(
    "/api/conversations/:id/messages/:seq",
    {
      schema: {
        params: z.object({ id: uuidParam, seq: positiveIntString() }),
        querystring: empty,
        response: { 200: z.object({ message: wireMessageSchema }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const message = await getMessage(db, me.id, req.params.id, req.params.seq);
      if (!message) throw notFound();
      return { message };
    },
  );

  // One budget for both search routes: they are the same expensive read.
  const searchLimiter = app.createRateLimit({
    max: Math.max(1, Math.round(30 * config.rateLimitScale)),
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => actors.get(req) ?? req.ip,
  });
  const searcher = async (req: FastifyRequest): Promise<string> => {
    const me = await requirePrincipal(req);
    actors.set(req, me.id);
    const limited = await searchLimiter(req);
    if ("isExceeded" in limited && limited.isExceeded) throw new AppError(429, "rate_limited");
    return me.id;
  };

  api.get(
    "/api/conversations/:id/search",
    {
      schema: {
        params: idParams,
        querystring: z.object({ q: searchTerm, before: positiveIntString().optional(), limit: searchLimit.optional() }),
        response: { 200: z.object({ messages: z.array(wireMessageSchema), nextBefore: z.number().nullable() }) },
      },
    },
    async (req) => {
      const me = await searcher(req);
      const { q, before, limit = 20 } = req.query;
      const page = await searchConversation(db, me, req.params.id, { q, before, limit });
      if (!page) throw notFound();
      return page;
    },
  );

  api.get(
    "/api/search",
    {
      schema: {
        params: empty,
        querystring: z.object({ q: searchTerm, before: searchCursor.optional(), limit: searchLimit.optional() }),
        response: { 200: z.object({ messages: z.array(wireMessageSchema), nextBefore: z.string().nullable() }) },
      },
    },
    async (req) => {
      const me = await searcher(req);
      const { q, before, limit = 20 } = req.query;
      return searchAll(db, me, { q, before, limit });
    },
  );

  api.post(
    "/api/conversations/:id/read",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: z.object({ seq: positiveInt }),
        response: { 200: z.object({ readSeq: z.number() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const marked = await markRead(db, me.id, req.params.id, req.body.seq);
      if (!marked) throw notFound();
      // Only a direct chat shows the other side's read position, and only when it actually moved.
      if (marked.type === "direct" && marked.readSeq > marked.previous) {
        reads.publish({ conversationId: req.params.id, principalId: me.id, seq: marked.readSeq }, req.log);
      }
      return { readSeq: marked.readSeq };
    },
  );
}
