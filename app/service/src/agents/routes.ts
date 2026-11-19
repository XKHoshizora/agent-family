import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { formatPoints, MICRO_PER_POINT, parsePoints } from "../accounts/store.ts";
import { PROACTIVE_LEVELS, REASONING_LEVELS } from "../config.ts";
import type { Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { perPrincipalLimit, type PrincipalLimit } from "../limits.ts";
import { wireMessageSchema } from "../messages/model.ts";
import { toWireFor } from "../messages/read.ts";
import { avatarBudget, registerAvatarPut, storeAvatar } from "../principals/avatar-upload.ts";
import { swapAvatarKey } from "../principals/store.ts";
import { agentName, userText, uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { createAgent, resetTopic } from "./conversation.ts";
import { leaveGroupsOfDeleted } from "./group-leave.ts";
import { agentField, agentIntro, agentPersona, confirmProposal, discardProposal, draftPersona, proposedPersona } from "./persona.ts";
import { endWhatPauseMissed, interruptRuns, siteToday, spentTodayOf } from "./runs.ts";
import { hasVerticalSpace } from "./runtime/prompt.ts";
import {
  appellationEntriesOf,
  assertModelChoice,
  GROUP_MENTIONS,
  listOwnedAgents,
  lockOwnedAgent,
  readOwnedAgent,
  removeAppellation,
  setAgentState,
  setAppellation,
  updateAgent,
  type AgentPatch,
  type AgentRow,
  type AppellationEntry,
} from "./store.ts";

const empty = z.object({});
const idParams = z.object({ id: uuidParam });
/**
 * The target is any text here (as long as the router takes a path segment): one that is no id is 404 (`editAppellations`),
 * never 400, which would tell it apart from an id the Agent's owner may not name.
 */
const appellationParams = z.object({ id: uuidParam, principalId: z.string() });

/** A model as a request names it (`providerId` is normalised to lower case), and as a response shows it. */
export const chosenModel = (providerId: z.ZodType<string>) =>
  z.union([
    z.strictObject({ source: z.literal("site"), id: z.string().min(1).max(64) }),
    z.strictObject({ source: z.literal("provider"), providerId, model: z.string().min(1).max(200) }),
  ]);
/** An Agent's model, `null` until one is chosen. */
const modelChoice = (providerId: z.ZodType<string>) => chosenModel(providerId).nullable();
const model = modelChoice(uuidParam);
const replyMode = z.enum(["always", "mention"]);
const groupMentions = z.enum(GROUP_MENTIONS);
const reasoning = z.enum(REASONING_LEVELS);
const intro = agentIntro;
const field = agentField;
const persona = agentPersona;
const proposalParams = z.object({ id: uuidParam, proposalId: uuidParam });

/** `chainBudget`'s bounds and default, in micro-points: 1 to 100 000 points, 50 unless its owner says otherwise. */
const CHAIN_BUDGET_MIN = MICRO_PER_POINT;
const CHAIN_BUDGET_MAX = 100_000n * MICRO_PER_POINT;
const DEFAULT_CHAIN_BUDGET = 50n * MICRO_PER_POINT;
/**
 * `chainBudget` as a request gives it: a decimal string of points (no sign, no exponent, at most 6 fraction digits, as
 * money is on the wire) from 1 to 100 000; micro-points once parsed.
 */
const chainBudget = z
  .string()
  .regex(/^[0-9]{1,6}(?:\.[0-9]{1,6})?$/)
  .transform((s) => parsePoints(s)!)
  .refine((micro) => micro >= CHAIN_BUDGET_MIN && micro <= CHAIN_BUDGET_MAX);
/**
 * `othersBudget`, the most its owner pays in a site day for the Agent's replies other people called for (runs.ts
 * `othersBudgetSpent`): as `chainBudget` (1 to 100 000 points), or `null` for no limit; 20 points unless its owner says
 * otherwise.
 */
const othersBudget = chainBudget.nullable();
/** The others' daily budget's default (the limits design); the proactive budget's below is a setting of its own. */
const DEFAULT_OTHERS_BUDGET = 20n * MICRO_PER_POINT;

/**
 * The owner's settings for proactive replies (an Agent answering in a group nobody called it in): `proactive`, how
 * readily (`proactiveLevel`), and the most it pays in a site day for them (`proactiveBudget`: as `chainBudget`, never
 * `null`: there is no unlimited setting; 20 points unless its owner says otherwise).
 */
const proactiveLevel = z.enum(PROACTIVE_LEVELS);
const proactiveBudget = chainBudget;
/** The proactive budget's default (batch 2D design rule 11): the same number as the others' budget's, not tied to it. */
const DEFAULT_PROACTIVE_BUDGET = 20n * MICRO_PER_POINT;

/** What an Agent has spent today in the two lanes with a daily budget when nothing is (a new Agent). */
const NO_SPEND = { others: 0n, proactive: 0n } as const;

/**
 * 409 `proactive_unavailable` when `proactive` turns on (`on`) while the judgement model is not configured. An Agent
 * that already is proactive stays so when the configuration goes away (it is inert); edits of its other fields, and
 * turning it off, are never refused.
 */
function assertProactiveAvailable(config: { judge: unknown }, on: boolean | undefined): void {
  if (on === true && config.judge === null) throw new AppError(409, "proactive_unavailable");
}

/**
 * What an Agent calls its owner or someone else (`ownerAppellation`, the body of `PUT …/appellations/:principalId`):
 * one-line user text (`userText`: trimmed, 1 to 20 characters, no control character, NUL included, and no lone
 * surrogate), and no other vertical space either (`hasVerticalSpace`: the line and paragraph separators). An empty one
 * is not a way to clear `ownerAppellation`: `null` is.
 */
const appellationSchema = userText(1, 20, { singleLine: true }).refine((s) => !hasVerticalSpace(s), "one line");
const ownerAppellation = appellationSchema.nullable();

/** What an owner may say of an Agent when creating it, and change later (`PATCH`): each optional in both. */
const agentSettings = {
  intro: intro.optional(),
  field: field.optional(),
  persona: persona.optional(),
  replyMode: replyMode.optional(),
  groupMentions: groupMentions.optional(),
  chainBudget: chainBudget.optional(),
  othersBudget: othersBudget.optional(),
  proactive: z.boolean().optional(),
  proactiveLevel: proactiveLevel.optional(),
  proactiveBudget: proactiveBudget.optional(),
  memory: z.boolean().optional(),
  memoryAsk: z.boolean().optional(),
  sharedNotes: z.boolean().optional(),
  ownerAppellation: ownerAppellation.optional(),
  reasoning: reasoning.optional(),
  model: model.optional(),
};

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
  groupMentions,
  chainBudget: z.string(),
  othersBudget: z.string().nullable(),
  proactive: z.boolean(),
  proactiveLevel,
  proactiveBudget: z.string(),
  memory: z.boolean(),
  memoryAsk: z.boolean(),
  sharedNotes: z.boolean(),
  ownerAppellation: z.string().nullable(),
  appellations: z.array(
    z.object({
      principalId: z.string(),
      kind: z.enum(["human", "agent"]),
      handle: z.string().nullable(),
      name: z.string().nullable(),
      appellation: z.string(),
    }),
  ),
  othersSpentToday: z.string(),
  proactiveSpentToday: z.string(),
  reasoning,
  model: modelChoice(z.string()),
  paused: z.boolean(),
  deleted: z.boolean(),
  conversationId: z.string(),
  createdAt: z.string(),
});

/**
 * An Agent as its owner sees it, with its configuration (persona, model, `groupMentions`, …), which nobody else is shown,
 * what other people's calls on it and its proactive replies have spent today of the owner's points (`spent`, runs.ts
 * `spentTodayOf`), and
 * what it calls its owner and the people and Agents the owner named (`ownerAppellation`, `appellations`).
 */
const toView = (a: AgentRow, spent: { others: bigint; proactive: bigint }, appellations: AppellationEntry[]): z.infer<typeof agentView> => ({
  id: a.id,
  handle: a.handle,
  name: a.name,
  avatarVersion: a.avatarVersion,
  intro: a.intro,
  field: a.field,
  persona: a.persona,
  personaVersion: a.personaVersion,
  replyMode: a.replyMode,
  groupMentions: a.groupMentions,
  chainBudget: formatPoints(a.chainBudgetMicro),
  othersBudget: a.othersBudgetMicro === null ? null : formatPoints(a.othersBudgetMicro),
  proactive: a.proactive,
  proactiveLevel: a.proactiveLevel,
  proactiveBudget: formatPoints(a.proactiveBudgetMicro),
  memory: a.memory,
  memoryAsk: a.memoryAsk,
  sharedNotes: a.sharedNotes,
  ownerAppellation: a.ownerAppellation,
  appellations,
  othersSpentToday: formatPoints(spent.others),
  proactiveSpentToday: formatPoints(spent.proactive),
  reasoning: a.reasoning,
  model: a.model,
  paused: a.paused,
  deleted: a.deleted,
  conversationId: a.conversationId,
  createdAt: a.createdAt.toISOString(),
});

const deletedError = () => new AppError(409, "agent_deleted");

/**
 * Every route here is the owner's. Anyone else, and an id that is no Agent, gets the same 404. `draftRuns` holds the run
 * ids of the persona drafts this process is working on (the stale-run sweep leaves them alone); `readLimit` the budget
 * the reads of Agents share with the owner's other reads of their providers and replies. Returns `endDrafts`, for
 * the service's stop: the drafts under way are abandoned, each run ended as recovery would end it (`draftPersona`);
 * resolves once their requests have ended.
 */
export function registerAgentRoutes(
  app: FastifyInstance,
  { draftRuns, readLimit }: { draftRuns: Set<string>; readLimit: PrincipalLimit },
): { endDrafts(): Promise<void> } {
  const { db, config, conversations } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  /** The owner's view of `agent`, with what other people's calls and its proactive replies have spent today, read now (runs.ts `spentTodayOf`). */
  const viewOf = async (agent: AgentRow) =>
    toView(agent, (await spentTodayOf(db, [agent.id], siteToday(config))).get(agent.id) ?? NO_SPEND, (await appellationEntriesOf(db, [agent.id])).get(agent.id)!);

  // Create, edit, pause, resume, delete, avatar, new topics and confirming or discarding a proposal share one budget.
  const writeLimit = perPrincipalLimit(app, 30);
  // Persona drafts (each a model call) have a budget of their own.
  const draftLimit = perPrincipalLimit(app, 5);
  // An Agent's avatar also counts against the avatar budget its owner's own avatar uses (10 a minute).
  const avatarLimit = avatarBudget(app);
  /**
   * The drafts under way, each with what settles once its request has ended: abandoned when the service starts closing
   * (persona.ts `draftPersona`).
   */
  const drafts = new Map<AbortController, Promise<unknown>>();

  api.post(
    "/api/agents",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.strictObject({ handle: z.string().regex(/^[a-z0-9_]{3,24}$/), name: agentName, ...agentSettings }),
        response: { 201: agentView },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const b = req.body;
      assertProactiveAvailable(config, b.proactive);
      const input = {
        handle: b.handle,
        name: b.name,
        intro: b.intro ?? "",
        field: b.field ?? "",
        persona: b.persona ?? "",
        replyMode: b.replyMode ?? "always",
        groupMentions: b.groupMentions ?? "members",
        chainBudgetMicro: b.chainBudget ?? DEFAULT_CHAIN_BUDGET,
        // `null` is no limit: only an absent key takes the default.
        othersBudgetMicro: b.othersBudget === undefined ? DEFAULT_OTHERS_BUDGET : b.othersBudget,
        proactive: b.proactive ?? false,
        proactiveLevel: b.proactiveLevel ?? "normal",
        proactiveBudgetMicro: b.proactiveBudget ?? DEFAULT_PROACTIVE_BUDGET,
        memory: b.memory ?? true,
        memoryAsk: b.memoryAsk ?? false,
        sharedNotes: b.sharedNotes ?? true,
        ownerAppellation: b.ownerAppellation ?? null,
        reasoning: b.reasoning ?? "none",
        model: b.model ?? null,
      };
      const { agent, change } = await db.tx((t) => createAgent(t, me.id, input, config));
      conversations.publish(change, req.log);
      // A new Agent has had no reply yet (nothing spent) and its owner has named nobody.
      return reply.code(201).send(toView(agent, NO_SPEND, []));
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
      const drafting = draftPersona(
        { db, config, models: app.deps.models, log: req.log, inFlight: draftRuns, release: (runId) => app.agentPort.releaseRun(runId) },
        me.id,
        { name, intro: givenIntro ?? "", field: givenField ?? "", model: chosen },
        closing.signal,
      );
      drafts.set(closing, drafting.catch(() => {}));
      try {
        return { persona: await drafting };
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
      await readLimit(req, me.id);
      const agents = await listOwnedAgents(db, me.id);
      const ids = agents.map((a) => a.id);
      const spent = await spentTodayOf(db, ids, siteToday(config));
      const named = await appellationEntriesOf(db, ids);
      return { agents: agents.map((a) => toView(a, spent.get(a.id) ?? NO_SPEND, named.get(a.id)!)) };
    },
  );

  api.get(
    "/api/agents/:id",
    { schema: { params: idParams, querystring: empty, response: { 200: agentView } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      const agent = await readOwnedAgent(db, me.id, req.params.id);
      if (!agent) throw notFound();
      return viewOf(agent);
    },
  );

  api.patch(
    "/api/agents/:id",
    {
      schema: {
        params: idParams,
        querystring: empty,
        // Strict: the handle and the owner are not keys, so naming them is a 400.
        body: z.strictObject({ name: agentName.optional(), ...agentSettings }),
        response: { 200: agentView },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const agent = await db.tx(async (t) => {
        const current = await lockOwnedAgent(t, me.id, req.params.id);
        if (current.deleted) throw deletedError();
        assertProactiveAvailable(config, req.body.proactive);
        const { chainBudget: budget, othersBudget: others, proactiveBudget: proactiveBudgetPoints, ...fields } = req.body;
        const patch: AgentPatch = {
          ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
          ...(budget === undefined ? {} : { chainBudgetMicro: budget }),
          // `null` is no limit, and changes it like any value.
          ...(others === undefined ? {} : { othersBudgetMicro: others }),
          ...(proactiveBudgetPoints === undefined ? {} : { proactiveBudgetMicro: proactiveBudgetPoints }),
        };
        const next = { ...current, ...patch };
        if ("model" in patch || "reasoning" in patch) await assertModelChoice(t, me.id, next.model, next.reasoning, config);
        return updateAgent(t, current, patch);
      });
      conversations.publish({ messages: [], conversations: [{ conversationId: agent.conversationId, principalIds: [me.id] }] }, req.log);
      app.realtime.pushAgentChanged(me.id, agent.id);
      return viewOf(agent);
    },
  );

  /**
   * Pause, resume and delete: under `lockAgent` (the lock `postAsAgent` takes, so no reply is posted once a pause or
   * delete has committed), idempotent, announced to the owner's other tabs when they change something. A resume that
   * changes something ends, before the Agent answers again, the runs its pause could not see (runs.ts
   * `endWhatPauseMissed`), announced and stopped after commit as the pause's are. Once a delete has
   * committed, the Agent leaves every group it is in, a transaction per group (group-leave.ts `leaveGroupsOfDeleted`;
   * also on a repeated delete, which so finishes a leaving that failed), before the answer; a group it could not leave
   * is left by the start-up sweep.
   */
  const stateRoute = (method: "post" | "delete", url: string, change: { paused: boolean } | { deleted: true }) =>
    api[method](
      url,
      // No fields: none, `{}`, or `null`; anything else (an array, a string, text) is a 400.
      { schema: { params: idParams, querystring: empty, body: empty.nullish(), response: { 200: agentView } } },
      async (req) => {
        const me = await requirePrincipal(req);
        await writeLimit(req, me.id);
        const { agent, changed, interrupted } = await db.tx(async (t) => {
          const current = await lockOwnedAgent(t, me.id, req.params.id);
          // A deleted Agent stays deleted: deleting again is a no-op, anything else is refused.
          if (current.deleted && !("deleted" in change)) throw deletedError();
          const changed = await setAgentState(t, current, change);
          // Pausing or deleting ends the Agent's active reply for good, in this transaction (runs.ts); resuming a paused
          // Agent first ends what its pause could not see (`endWhatPauseMissed`).
          const stopping = "deleted" in change || change.paused;
          const interrupted = stopping
            ? await interruptRuns(t, current, "deleted" in change ? "agent_deleted" : "agent_paused")
            : changed
              ? await endWhatPauseMissed(t, current)
              : null;
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
        if ("deleted" in change) {
          // The delete has committed: a failure of the leaving (even of its first query) is not the client's; the start-up sweep finishes it.
          await leaveGroupsOfDeleted({ db, conversations, log: req.log }, agent.id).catch((err: unknown) =>
            req.log.error({ err, agentId: agent.id }, "a deleted Agent's leaving of its groups failed; the next start finishes it"),
          );
        }
        return viewOf(agent);
      },
    );
  stateRoute("post", "/api/agents/:id/pause", { paused: true });
  stateRoute("post", "/api/agents/:id/resume", { paused: false });
  stateRoute("delete", "/api/agents/:id", { deleted: true });

  /**
   * An edit of the owner's appellations for the Agent, under `lockOwnedAgent` (so the count that caps them cannot be
   * outrun): refused for a deleted Agent; a target that is no id at all, whatever its length, is 404 `not_found` — as
   * an id that is nobody's is for a `PUT`, never a 400, which would tell them apart; when `apply` says it changed
   * something, the owner's sockets are told after commit (`agent`) and nobody else is — the people named are not.
   */
  const editAppellations = async (
    ownerId: string,
    params: { id: string; principalId: string },
    apply: (t: Tx, agent: AgentRow, target: string) => Promise<boolean>,
  ) => {
    const target = uuidParam.safeParse(params.principalId);
    const { agent, changed } = await db.tx(async (t) => {
      const current = await lockOwnedAgent(t, ownerId, params.id);
      if (current.deleted) throw deletedError();
      if (!target.success) throw notFound();
      return { agent: current, changed: await apply(t, current, target.data) };
    });
    if (changed) app.realtime.pushAgentChanged(ownerId, agent.id);
    return viewOf(agent);
  };

  // What the Agent calls someone (store.ts `setAppellation` says who may be named): insert or replace.
  api.put(
    "/api/agents/:id/appellations/:principalId",
    {
      schema: {
        params: appellationParams,
        querystring: empty,
        body: z.strictObject({ appellation: appellationSchema }),
        response: { 200: agentView },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      return editAppellations(me.id, req.params, (t, agent, target) => setAppellation(t, agent, target, req.body.appellation));
    },
  );

  // Takes a name back: 404 when the Agent called them nothing (as an Agent route answers any path that names nothing).
  api.delete(
    "/api/agents/:id/appellations/:principalId",
    { schema: { params: appellationParams, querystring: empty, response: { 200: agentView } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      return editAppellations(me.id, req.params, async (t, agent, target) => {
        if (!(await removeAppellation(t, agent.id, target))) throw notFound();
        return true;
      });
    },
  );

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
      return viewOf(confirmed);
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
      const { notice, wire, agentId } = await db.tx(async (t) => {
        const { notice, agentId } = await resetTopic(t, me.id, req.params.id);
        const [wire] = await toWireFor(t, me.id, [notice], config);
        if (!wire) throw new Error("resetTopic: the owner cannot read the notice just written");
        return { notice, wire, agentId };
      });
      conversations.publish({ messages: [notice], conversations: [] }, req.log);
      // What was said before the new topic is reviewed now, while it is still shown to the reviewer.
      app.deps.memory?.topicReset(agentId, req.params.id);
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

  return {
    async endDrafts() {
      for (const closing of drafts.keys()) closing.abort(new Error("the service is closing"));
      await Promise.all(drafts.values());
    },
  };
}
