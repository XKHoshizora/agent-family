import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { REASONING_LEVELS } from "../config.ts";
import { AppError, notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { registerAvatarPut, storeAvatar } from "../principals/avatar-upload.ts";
import { swapAvatarKey } from "../principals/store.ts";
import { agentName, uuidParam, userText } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { createAgent } from "./conversation.ts";
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

/** The model as a request names it (`providerId` is normalised to lower case), and as a response shows it. */
const modelChoice = (providerId: z.ZodType<string>) =>
  z
    .union([
      z.strictObject({ source: z.literal("site"), id: z.string().min(1).max(64) }),
      z.strictObject({ source: z.literal("provider"), providerId, model: z.string().min(1).max(200) }),
    ])
    .nullable();
const model = modelChoice(uuidParam);
const replyMode = z.enum(["always", "mention"]);
const reasoning = z.enum(REASONING_LEVELS);
const intro = userText(0, 40, { singleLine: true });
const field = userText(0, 20, { singleLine: true });
const persona = userText(0, 20_000);

const agentView = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
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

  // Create, edit, pause, resume, delete and avatar share one budget.
  const writeLimit = perPrincipalLimit(app, 30);

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
      return toView(agent);
    },
  );

  /** Pause, resume and delete: under `lockAgent`, idempotent, announced to the owner's other tabs when they change something. */
  const stateRoute = (method: "post" | "delete", url: string, change: { paused: boolean } | { deleted: true }) =>
    api[method](
      url,
      { schema: { params: idParams, querystring: empty, response: { 200: agentView } } },
      async (req) => {
        const me = await requirePrincipal(req);
        await writeLimit(req, me.id);
        const { agent, changed } = await db.tx(async (t) => {
          const current = await lockOwnedAgent(t, me.id, req.params.id);
          // A deleted Agent stays deleted: deleting again is a no-op, anything else is refused.
          if (current.deleted && !("deleted" in change)) throw deletedError();
          const changed = await setAgentState(t, current, change);
          return { agent: { ...current, ...("deleted" in change ? { deleted: true } : change) }, changed };
        });
        if (changed) conversations.publish({ messages: [], conversations: [{ conversationId: agent.conversationId, principalIds: [me.id] }] }, req.log);
        return toView(agent);
      },
    );
  stateRoute("post", "/api/agents/:id/pause", { paused: true });
  stateRoute("post", "/api/agents/:id/resume", { paused: false });
  stateRoute("delete", "/api/agents/:id", { deleted: true });

  // The rules and limits of `PUT /api/me/avatar`, for the Agent's avatar.
  registerAvatarPut(app, "/api/agents/:id/avatar", idParams, async (req, body) => {
    const me = await requirePrincipal(req);
    await writeLimit(req, me.id);
    const id = (req.params as { id: string }).id;
    const seen = await readOwnedAgent(db, me.id, id);
    if (!seen) throw notFound();
    if (seen.deleted) throw deletedError();
    await storeAvatar(app, req.log, body, async (t, key) => {
      const current = await lockOwnedAgent(t, me.id, id);
      if (current.deleted) throw deletedError();
      return swapAvatarKey(t, id, key);
    });
  });
}
