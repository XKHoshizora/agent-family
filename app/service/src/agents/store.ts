import type { Config } from "../config.ts";
import { REASONING_LEVELS, type ReasoningLevel } from "../config.ts";
import { lockConversation } from "../conversations/store.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";

export type ReplyMode = "always" | "mention";

/** What the Agent answers with; `null` until the owner has chosen. */
export type AgentModel = { source: "site"; id: string } | { source: "provider"; providerId: string; model: string } | null;

export interface AgentRow {
  id: string;
  ownerId: string;
  handle: string;
  /** `principals.display_name`. */
  name: string;
  intro: string;
  field: string;
  persona: string;
  personaVersion: number;
  replyMode: ReplyMode;
  reasoning: ReasoningLevel;
  model: AgentModel;
  paused: boolean;
  deleted: boolean;
  conversationId: string;
  createdAt: Date;
}

interface AgentDbRow {
  id: string;
  owner_id: string;
  handle: string;
  name: string;
  intro: string;
  field: string;
  persona: string;
  persona_version: number;
  reply_mode: ReplyMode;
  reasoning: ReasoningLevel;
  model_source: "site" | "provider" | null;
  site_model_id: string | null;
  provider_id: string | null;
  provider_model: string | null;
  paused: boolean;
  deleted: boolean;
  conversation_id: string;
  created_at: Date;
}

const SELECT = `select p.id, p.owner_id, p.handle::text as handle, p.display_name as name, a.intro, a.field, a.persona,
       a.persona_version, a.reply_mode, a.reasoning, a.model_source, a.site_model_id, a.provider_id, a.provider_model,
       a.paused, a.deleted_at is not null as deleted, ac.conversation_id, a.created_at
  from agents a
  join principals p on p.id = a.principal_id
  join agent_conversations ac on ac.agent_id = a.principal_id`;

function toAgent(r: AgentDbRow): AgentRow {
  const model: AgentModel =
    r.model_source === "site"
      ? { source: "site", id: r.site_model_id! }
      : r.model_source === "provider"
        ? { source: "provider", providerId: r.provider_id!, model: r.provider_model! }
        : null;
  return {
    id: r.id,
    ownerId: r.owner_id,
    handle: r.handle,
    name: r.name,
    intro: r.intro,
    field: r.field,
    persona: r.persona,
    personaVersion: r.persona_version,
    replyMode: r.reply_mode,
    reasoning: r.reasoning,
    model,
    paused: r.paused,
    deleted: r.deleted,
    conversationId: r.conversation_id,
    createdAt: r.created_at,
  };
}

/** The `agents` columns that say which model, in the order of `modelParams`. */
export function modelParams(model: AgentModel): [string | null, string | null, string | null, string | null] {
  if (model === null) return [null, null, null, null];
  return model.source === "site" ? ["site", model.id, null, null] : ["provider", null, model.providerId, model.model];
}

/**
 * Locks the Agent's conversation row, then its `agents` row (`for update`): the order every writer uses
 * (pair lock → conversation → agents → accounts). Pause, resume, delete and `postAsAgent` go through it, so
 * the row it returns cannot change until the transaction ends. 404 for an unknown Agent. Whose Agent it is
 * is not checked here: `lockOwnedAgent` does that for the owner's routes.
 */
export async function lockAgent(t: Tx, agentId: string): Promise<AgentRow> {
  const found = await t.query<{ conversation_id: string }>("select conversation_id from agent_conversations where agent_id = $1", [agentId]);
  if (!found.rows[0]) throw notFound();
  await lockConversation(t, found.rows[0].conversation_id);
  const { rows } = await t.query<AgentDbRow>(`${SELECT} where a.principal_id = $1 for update of a`, [agentId]);
  if (!rows[0]) throw notFound();
  return toAgent(rows[0]);
}

/** `lockAgent` for its owner's routes: 404, exactly as for an unknown id, when it is anybody else's. */
export async function lockOwnedAgent(t: Tx, ownerId: string, agentId: string): Promise<AgentRow> {
  const owned = await readOwnedAgent(t, ownerId, agentId);
  if (!owned) throw notFound();
  return lockAgent(t, agentId);
}

export async function readOwnedAgent(q: Queryable, ownerId: string, agentId: string): Promise<AgentRow | null> {
  const { rows } = await q.query<AgentDbRow>(`${SELECT} where a.principal_id = $2 and p.owner_id = $1`, [ownerId, agentId]);
  return rows[0] ? toAgent(rows[0]) : null;
}

/** The owner's Agents, deleted ones included (flagged), oldest first. */
export async function listOwnedAgents(q: Queryable, ownerId: string): Promise<AgentRow[]> {
  const { rows } = await q.query<AgentDbRow>(`${SELECT} where p.owner_id = $1 order by a.created_at, p.id`, [ownerId]);
  return rows.map(toAgent);
}

/** How many Agents the owner has that are not deleted: what counts against the tier's limit. */
export async function countLiveAgents(t: Tx, ownerId: string): Promise<number> {
  const { rows } = await t.query<{ n: number }>(
    `select count(*)::int as n from agents a join principals p on p.id = a.principal_id where p.owner_id = $1 and a.deleted_at is null`,
    [ownerId],
  );
  return rows[0]!.n;
}

/**
 * 400 `invalid_request` unless the model exists for this owner and the reasoning level suits it: a site model
 * must be in `config.siteModels` and allows `none` plus its own `reasoning` levels; a provider model must be
 * listed by a provider of this owner and allows `none` only, unless its `reasoning` flag is set. With no model
 * chosen yet any level is accepted (it is checked when a model is chosen).
 */
export async function assertModelChoice(
  q: Queryable,
  ownerId: string,
  model: AgentModel,
  reasoning: ReasoningLevel,
  config: Pick<Config, "siteModels">,
): Promise<void> {
  if (model === null) return;
  let allowed: readonly ReasoningLevel[];
  if (model.source === "site") {
    const site = config.siteModels.find((m) => m.id === model.id);
    if (!site) throw new AppError(400, "invalid_request");
    allowed = site.reasoning;
  } else {
    const { rows } = await q.query<{ models: Array<{ name?: unknown; reasoning?: unknown }> }>(
      "select models from providers where id = $1 and owner_id = $2",
      [model.providerId, ownerId],
    );
    const listed = rows[0]?.models.find((m) => m.name === model.model);
    if (!listed) throw new AppError(400, "invalid_request");
    allowed = listed.reasoning === true ? REASONING_LEVELS : [];
  }
  if (reasoning !== "none" && !allowed.includes(reasoning)) throw new AppError(400, "invalid_request");
}

export interface AgentPatch {
  name?: string;
  intro?: string;
  field?: string;
  persona?: string;
  replyMode?: ReplyMode;
  reasoning?: ReasoningLevel;
  model?: AgentModel;
}

/** Applies an edit to a locked, undeleted Agent; a persona that differs from the stored one is a new version. */
export async function updateAgent(t: Tx, current: AgentRow, patch: AgentPatch): Promise<AgentRow> {
  const next = { ...current, ...patch };
  const personaVersion = next.persona === current.persona ? current.personaVersion : current.personaVersion + 1;
  await t.query(
    `update agents set intro = $2, field = $3, persona = $4, persona_version = $5, reply_mode = $6, reasoning = $7,
            model_source = $8, site_model_id = $9, provider_id = $10, provider_model = $11
      where principal_id = $1`,
    [current.id, next.intro, next.field, next.persona, personaVersion, next.replyMode, next.reasoning, ...modelParams(next.model)],
  );
  if (next.name !== current.name) await t.query("update principals set display_name = $2 where id = $1", [current.id, next.name]);
  return { ...next, personaVersion };
}

/** Sets `paused` or deletes (`deleted_at`, irreversible) on a locked Agent; true when something changed. */
export async function setAgentState(t: Tx, agent: AgentRow, change: { paused: boolean } | { deleted: true }): Promise<boolean> {
  if ("deleted" in change) {
    if (agent.deleted) return false;
    await t.query("update agents set deleted_at = now() where principal_id = $1", [agent.id]);
    return true;
  }
  if (agent.paused === change.paused) return false;
  await t.query("update agents set paused = $2 where principal_id = $1", [agent.id, change.paused]);
  return true;
}
