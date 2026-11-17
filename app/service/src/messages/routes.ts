import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { maybeTrigger } from "../agents/runs.ts";
import { notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { hasVisibleText, messageText, positiveInt, positiveIntString, searchTerm, uuidParam } from "../schemas.ts";
import type { Tx } from "../db.ts";
import { requirePrincipal } from "../session.ts";
import { withSlot } from "../slots.ts";
import { wireMessageSchema } from "./model.ts";
import { principalMapSchema, principalsOf } from "./principals.ts";
import { getMessage, listMessages, markRead, toWireFor } from "./read.ts";
import { decodeSearchCursor, inSearchBudget, searchAll, searchConversation } from "./search.ts";
import { MESSAGE_TEXT_MAX, sendMessage } from "./send.ts";

const empty = z.object({});
const idParams = z.object({ id: uuidParam });
const sendResult = z.object({ message: wireMessageSchema, duplicate: z.boolean() });

const sendBody = z
  .object({
    // A caption may be empty or invisible; a text message must show something (the refinement below).
    text: messageText(0, MESSAGE_TEXT_MAX).optional(),
    attachmentId: uuidParam.optional(),
    replyToSeq: positiveInt.optional(),
    clientTxn: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .refine(
    (b) => b.attachmentId !== undefined || (b.text !== undefined && hasVisibleText(b.text)),
    "a text message needs a visible character; a file message an attachmentId",
  );

// Search terms (schemas.ts `searchTerm`): `%`, `_` and `\` are ordinary characters (see search.ts).
const searchLimit = positiveIntString(50);
const searchCursor = z
  .string()
  .transform((s, ctx) => {
    const cursor = decodeSearchCursor(s);
    if (!cursor) ctx.addIssue({ code: "custom", message: "malformed cursor" });
    return cursor ?? z.NEVER;
  });

export function registerMessageRoutes(app: FastifyInstance): void {
  const { db, config, conversations, reads, searches } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  const sendLimit = perPrincipalLimit(app, 120);

  api.post(
    "/api/conversations/:id/messages",
    {
      schema: { params: idParams, querystring: empty, body: sendBody, response: { 200: sendResult, 201: sendResult } },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await sendLimit(req, me.id);

      // Rendered inside the transaction, under the locks that just proved the sender may read it. An owner's
      // message to their Agent, and a message in a group naming Agent members by @handle, queue their replies in the
      // same transaction (agents/runs.ts `maybeTrigger`; over an owner's replies a minute, a failed `rate_limited` run
      // instead). Each is announced to its own Agent's owner.
      const { message, duplicate, wire, triggered } = await db.tx(async (t) => {
        const sent = await sendMessage(t, req.params.id, me.id, req.body);
        const [rendered] = await toWireFor(t, me.id, [sent.message]);
        if (!rendered) throw new Error("sendMessage: sender cannot read the message it just stored");
        const triggered = sent.duplicate ? [] : await maybeTrigger(t, sent.lock, sent.message, config);
        return { ...sent, wire: rendered, triggered };
      });
      if (!duplicate) conversations.publish({ messages: [message], conversations: [] }, req.log);
      for (const run of triggered) app.agentPort.announce(run);
      return reply.code(duplicate ? 200 : 201).send({ message: wire, duplicate });
    },
  );

  api.get(
    "/api/conversations/:id/messages",
    {
      schema: {
        params: idParams,
        querystring: z.object({ before: positiveIntString().optional(), limit: positiveIntString(100).optional() }),
        response: { 200: z.object({ messages: z.array(wireMessageSchema), nextBefore: z.number().nullable(), principals: principalMapSchema }) },
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
        response: { 200: z.object({ message: wireMessageSchema, principals: principalMapSchema }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const message = await getMessage(db, me.id, req.params.id, req.params.seq);
      if (!message) throw notFound();
      return { message, principals: await principalsOf(db, [message]) };
    },
  );

  // One budget for both search routes: they are the same expensive read.
  const searchRate = perPrincipalLimit(app, 30);
  const searcher = async (req: FastifyRequest): Promise<string> => {
    const me = await requirePrincipal(req);
    await searchRate(req, me.id);
    return me.id;
  };
  /**
   * One search under both bounds: a slot of the caller's (at most 2 in progress; the slot is held until
   * the search's own transaction ends, even if the client has gone, because the work goes on) and the
   * search statement timeout.
   */
  const search = <T>(me: string, run: (t: Tx) => Promise<T>): Promise<T> =>
    withSlot(searches, me, () => inSearchBudget(db, config.searchStatementTimeoutMs, run));

  api.get(
    "/api/conversations/:id/search",
    {
      schema: {
        params: idParams,
        querystring: z.object({ q: searchTerm, before: positiveIntString().optional(), limit: searchLimit.optional() }),
        response: { 200: z.object({ messages: z.array(wireMessageSchema), nextBefore: z.number().nullable(), principals: principalMapSchema }) },
      },
    },
    async (req) => {
      const me = await searcher(req);
      const { q, before, limit = 20 } = req.query;
      const page = await search(me, (t) => searchConversation(t, me, req.params.id, { q, before, limit }));
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
        response: { 200: z.object({ messages: z.array(wireMessageSchema), nextBefore: z.string().nullable(), principals: principalMapSchema }) },
      },
    },
    async (req) => {
      const me = await searcher(req);
      const { q, before, limit = 20 } = req.query;
      return search(me, (t) => searchAll(t, me, { q, before, limit }));
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
