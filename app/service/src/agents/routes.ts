import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { REASONING_LEVELS } from "../config.ts";
import { AppError, notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { wireMessageSchema } from "../messages/model.ts";
import { toWireFor } from "../messages/read.ts";
import { avatarBudget, registerAvatarPut, storeAvatar } from "../principals/avatar-upload.ts";
import { swapAvatarKey } from "../principals/store.ts";
import { agentName, uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { createAgent, resetTopic } from "./conversation.ts";
import { agentField, agentIntro, agentPersona, confirmProposal, discardProposal, draftPersona, proposedPersona } from "./persona.ts";
import { interruptRuns } from "./runs.ts";
import {
  assertModelChoice,
  listOwnedAgents,
  lockOwnedAgent,
  readOwnedAgent,
  setAgentState,
  updateAgent,
  type AgentRow,
} from "./store.ts";

const empty = z.object({});
const idParams = z.object({ id: uuidParam });

/** A model as a request names it (`providerId` is normalised to lower case), and as a response shows it. */
const chosenModel = (providerId: z.ZodType<string>) =>
  z.union([
    z.strictObject({ source: z.literal("site"), id: z.string().min(1).max(64) }),
    z.strictObject({ source: z.literal("provider"), providerId, model: z.string().min(1).max(200) }),
  ]);
/** An Agent's model, `null` until one is chosen. */
const modelChoice = (providerId: z.ZodType<string>) => chosenModel(providerId).nullable();
const model = modelChoice(uuidParam);
const replyMode = z.enum(["always", "mention"]);
const reasoning = z.enum(REASONING_LEVELS);
const intro = agentIntro;
const field = agentField;
const persona = agentPersona;
const proposalParams = z.object({ id: uuidParam, proposalId: uuidParam });

const agentView = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  avatarVersion: z.number(),
  intro: z.string(),
  field: z.string(),
  persona: z.string(),
  personaVersion: z.number(),
  replyMode,
  reasoning,
  model: modelChoice(z.string()),
  paused: z.boolean(),
  deleted: z.boolean(),
  conversationId: z.string(),
  createdAt: z.string(),
});

/** An Agent as its owner sees it. */
const toView = (a: AgentRow): z.infer<typeof agentView> => ({
  id: a.id,
  handle: a.handle,
  name: a.name,
  avatarVersion: a.avatarVersion,
  intro: a.intro,
  field: a.field,
  persona: a.persona,
  personaVersion: a.personaVersion,
  replyMode: a.replyMode,
  reasoning: a.reasoning,
  model: a.model,
  paused: a.paused,
  deleted: a.deleted,
  conversationId: a.conversationId,
  createdAt: a.createdAt.toISOString(),
});

const deletedError = () => new AppError(409, "agent_deleted");

/** Every route here is the owner's. Anyone else, and an id that is no Agent, gets the same 404. */
export function registerAgentRoutes(app: FastifyInstance): void {
  const { db, config, conversations } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  // Create, edit, pause, resume, delete, avatar, new topics and confirming or discarding a proposal share one budget.
  const writeLimit = perPrincipalLimit(app, 30);
  // Persona drafts (each a model call) have a budget of their own.
  const draftLimit = perPrincipalLimit(app, 5);
  // An Agent's avatar also counts against the avatar budget its owner's own avatar uses (10 a minute).
  const avatarLimit = avatarBudget(app);
  /** The drafts whose model call is under way: abandoned when the service starts closing (persona.ts `draftPersona`). */
  const drafts = new Set<AbortController>();
  app.addHook("preClose", async () => {
    for (const closing of drafts) closing.abort(new Error("the service is closing"));
  });

  api.post(
    "/api/agents",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.strictObject({
          handle: z.string().regex(/^[a-z0-9_]{3,24}$/),
          name: agentName,
          intro: intro.optional(),
          field: field.optional(),
          persona: persona.optional(),
          replyMode: replyMode.optional(),
          reasoning: reasoning.optional(),
          model: model.optional(),
        }),
        response: { 201: agentView },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const b = req.body;
      const input = {
        handle: b.handle,
        name: b.name,
        intro: b.intro ?? "",
        field: b.field ?? "",
        persona: b.persona ?? "",
        replyMode: b.replyMode ?? "always",
        reasoning: b.reasoning ?? "none",
        model: b.model ?? null,
      };
      const { agent, change } = await db.tx((t) => createAgent(t, me.id, input, config));
      conversations.publish(change, req.log);
      return reply.code(201).send(toView(agent));
    },
  );

  // A persona written by the model from a name and a line or two (spec 6.7, 2): returned, never stored (persona.ts).
  api.post(
    "/api/agents/draft-persona",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.strictObject({ name: agentName, intro: intro.optional(), field: field.optional(), model: chosenModel(uuidParam) }),
        response: { 200: z.object({ persona: z.string() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await draftLimit(req, me.id);
      const { name, intro: givenIntro, field: givenField, model: chosen } = req.body;
      const closing = new AbortController();
      drafts.add(closing);
      try {
        const written = await draftPersona(
          { db, config, models: app.deps.models, log: req.log },
          me.id,
          { name, intro: givenIntro ?? "", field: givenField ?? "", model: chosen },
          closing.signal,
        );
        return { persona: written };
      } finally {
        drafts.delete(closing);
      }
    },
  );

  api.get(
    "/api/agents",
    { schema: { params: empty, querystring: empty, response: { 200: z.object({ agents: z.array(agentView) }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      return { agents: (await listOwnedAgents(db, me.id)).map(toView) };
    },
  );

  api.get(
    "/api/agents/:id",
    { schema: { params: idParams, querystring: empty, response: { 200: agentView } } },
    async (req) => {
      const me = await requirePrincipal(req);
      const agent = await readOwnedAgent(db, me.id, req.params.id);
      if (!agent) throw notFound();
      return toView(agent);
    },
  );

  api.patch(
    "/api/agents/:id",
    {
      schema: {
        params: idParams,
        querystring: empty,
        // Strict: the handle and the owner are not keys, so naming them is a 400.
        body: z.strictObject({
          name: agentName.optional(),
          intro: intro.optional(),
          field: field.optional(),
          persona: persona.optional(),
          replyMode: replyMode.optional(),
          reasoning: reasoning.optional(),
          model: model.optional(),
        }),
        response: { 200: agentView },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const agent = await db.tx(async (t) => {
        const current = await lockOwnedAgent(t, me.id, req.params.id);
        if (current.deleted) throw deletedError();
        const patch = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
        const next = { ...current, ...patch };
        if ("model" in patch || "reasoning" in patch) await assertModelChoice(t, me.id, next.model, next.reasoning, config);
        return updateAgent(t, current, patch);
      });
      conversations.publish({ messages: [], conversations: [{ conversationId: agent.conversationId, principalIds: [me.id] }] }, req.log);
      app.realtime.pushAgentChanged(me.id, agent.id);
      return toView(agent);
    },
  );

  /**
   * Pause, resume and delete: under `lockAgent` (the lock `postAsAgent` takes, so no reply is posted once a pause or
   * delete has committed), idempotent, announced to the owner's other tabs when they change something.
   */
  const stateRoute = (method: "post" | "delete", url: string, change: { paused: boolean } | { deleted: true }) =>
    api[method](
      url,
      { schema: { params: idParams, querystring: empty, response: { 200: agentView } } },
      async (req) => {
        const me = await requirePrincipal(req);
        await writeLimit(req, me.id);
        const { agent, changed, interrupted } = await db.tx(async (t) => {
          const current = await lockOwnedAgent(t, me.id, req.params.id);
          // A deleted Agent stays deleted: deleting again is a no-op, anything else is refused.
          if (current.deleted && !("deleted" in change)) throw deletedError();
          const changed = await setAgentState(t, current, change);
          // Pausing or deleting ends the Agent's active reply for good, in this transaction (runs.ts).
          const stopping = "deleted" in change || change.paused;
          const interrupted = stopping ? await interruptRuns(t, current, "deleted" in change ? "agent_deleted" : "agent_paused") : null;
          return { agent: { ...current, ...("deleted" in change ? { deleted: true } : change) }, changed, interrupted };
        });
        if (interrupted) {
          // Before answering: from now on nothing of those runs reaches the owner, and their calls are abandoned.
          app.agentPort.interruptRuns(interrupted.running);
          for (const cancelled of interrupted.cancelled) app.agentPort.announce(cancelled);
        }
        if (changed) {
          conversations.publish({ messages: [], conversations: [{ conversationId: agent.conversationId, principalIds: [me.id] }] }, req.log);
          app.realtime.pushAgentChanged(me.id, agent.id);
        }
        return toView(agent);
      },
    );
  stateRoute("post", "/api/agents/:id/pause", { paused: true });
  stateRoute("post", "/api/agents/:id/resume", { paused: false });
  stateRoute("delete", "/api/agents/:id", { deleted: true });

  const staleProposal = () => new AppError(409, "stale_proposal");

  /**
   * The one way a proposal changes an Agent (persona.ts `confirmProposal`): the owner's session, under `lockOwnedAgent`.
   * The body may hold the owner's edits of the persona, intro and field, and nothing else (strict: any other key is a
   * 400). A proposal that can no longer be confirmed is 409 `stale_proposal`, answered after its `stale` mark commits.
   * The owner's sockets are told (`agent`) to fetch the Agent, and the proposal cards they show, again.
   */
  api.post(
    "/api/agents/:id/proposals/:proposalId/confirm",
    {
      schema: {
        params: proposalParams,
        querystring: empty,
        body: z.strictObject({ persona: proposedPersona.optional(), intro: intro.optional(), field: field.optional() }).nullish(),
        response: { 200: agentView },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const confirmed = await db.tx((t) => confirmProposal(t, me.id, req.params.id, req.params.proposalId, req.body ?? {}));
      if (!confirmed) throw staleProposal();
      app.realtime.pushAgentChanged(me.id, confirmed.id);
      return toView(confirmed);
    },
  );

  // The owner turns a proposal down (persona.ts `discardProposal`): the Agent does not change.
  api.post(
    "/api/agents/:id/proposals/:proposalId/discard",
    { schema: { params: proposalParams, querystring: empty, body: empty.nullish(), response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const outcome = await db.tx((t) => discardProposal(t, me.id, req.params.id, req.params.proposalId));
      if (outcome === "stale") throw staleProposal();
      if (outcome === "discarded") app.realtime.pushAgentChanged(me.id, req.params.id);
      return { ok: true as const };
    },
  );

  // A new topic in the Agent's conversation (agents/conversation.ts `resetTopic`): the notice, as a send answers.
  api.post(
    "/api/conversations/:id/topic",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: empty.nullish(),
        response: { 201: z.object({ message: wireMessageSchema }) },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const { notice, wire } = await db.tx(async (t) => {
        const notice = await resetTopic(t, me.id, req.params.id);
        const [wire] = await toWireFor(t, me.id, [notice]);
        if (!wire) throw new Error("resetTopic: the owner cannot read the notice just written");
        return { notice, wire };
      });
      conversations.publish({ messages: [notice], conversations: [] }, req.log);
      return reply.code(201).send({ message: wire });
    },
  );

  // The rules and limits of `PUT /api/me/avatar`, for the Agent's avatar: the avatar budget, and the Agent writes'.
  registerAvatarPut(app, "/api/agents/:id/avatar", idParams, async (req, body) => {
    const me = await requirePrincipal(req);
    await writeLimit(req, me.id);
    await avatarLimit(req, me.id);
    const id = (req.params as { id: string }).id;
    const seen = await readOwnedAgent(db, me.id, id);
    if (!seen) throw notFound();
    if (seen.deleted) throw deletedError();
    await storeAvatar(app, req.log, body, async (t, key) => {
      const current = await lockOwnedAgent(t, me.id, id);
      if (current.deleted) throw deletedError();
      return swapAvatarKey(t, id, key);
    });
    app.realtime.pushAgentChanged(me.id, id);
    await app.realtime.pushPrincipalChanged(id);
  });
}
