import { z } from "zod";
import type { Queryable } from "../db.ts";
import type { WireMessage } from "./model.ts";

/**
 * What a principal of kind `agent` carries besides its name, handle and avatar, for whoever already sees it (its owner,
 * and the members of a conversation it is in): its owner and its public profile. Never anything else of the Agent —
 * not its persona, model, reasoning level, reply mode, group setting, provider, pause or proposals. `intro` and `field`
 * are strings, "" when not set. A person has none of the three keys.
 */
export interface AgentProfile {
  ownerId: string;
  intro: string;
  field: string;
}

/** The three `AgentProfile` keys of a response schema: optional, as people lack them. */
export const agentProfileShape = {
  ownerId: z.string().optional(),
  intro: z.string().optional(),
  field: z.string().optional(),
};

/**
 * The columns behind `agentProfile`, for a query over `principals p` that has `AGENT_PROFILE_JOIN`. A left join: an
 * Agent principal without an `agents` row (only test fixtures) still lists, with an empty intro and field.
 */
export const AGENT_PROFILE_COLUMNS = "p.owner_id, ag.intro as agent_intro, ag.field as agent_field";
export const AGENT_PROFILE_JOIN = "left join agents ag on ag.principal_id = p.id";

export interface AgentProfileRow {
  kind: "human" | "agent";
  owner_id: string | null;
  agent_intro: string | null;
  agent_field: string | null;
}

/** The `AgentProfile` keys of one row read with `AGENT_PROFILE_COLUMNS`: none for a person. */
export function agentProfile(r: AgentProfileRow): Partial<AgentProfile> {
  if (r.kind !== "agent" || r.owner_id === null) return {};
  return { ownerId: r.owner_id, intro: r.agent_intro ?? "", field: r.agent_field ?? "" };
}

/** A principal as `GET /api/sync` lists it (and as message reads list the ones their messages name). */
export interface SyncPrincipal extends Partial<AgentProfile> {
  id: string;
  handle: string;
  displayName: string;
  avatarVersion: number;
  kind: "human" | "agent";
}

export const syncPrincipalSchema = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  avatarVersion: z.number(),
  kind: z.enum(["human", "agent"]),
  ...agentProfileShape,
});

/** `principals` of a message read: every principal its messages name, by id. */
export const principalMapSchema = z.record(z.string(), syncPrincipalSchema);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Principal ids a rendered message names: its sender, a visible quote's sender, a notice's participants. */
export function mentionedIn(m: WireMessage): string[] {
  const ids: unknown[] = [m.senderId];
  if (m.replyTo?.visible) ids.push(m.replyTo.senderId);
  if (m.system) {
    const { actorId, principalId, newCreatorId, memberIds } = m.system as Record<string, unknown>;
    ids.push(actorId, principalId, newCreatorId, ...(Array.isArray(memberIds) ? memberIds : []));
  }
  return ids.filter((id): id is string => typeof id === "string" && UUID.test(id)).map((id) => id.toLowerCase());
}

/**
 * The principals with these ids (unknown ids are skipped), by handle: the one reader behind `/api/sync` and message reads.
 * It decides nothing about who may be seen: callers pass only ids their reader already sees (members of the reader's
 * conversations, and whoever the messages rendered for that reader name). An Agent comes with its `AgentProfile`.
 */
export async function readPrincipals(q: Queryable, ids: Iterable<string>): Promise<SyncPrincipal[]> {
  const { rows } = await q.query<{ id: string; handle: string; display_name: string; avatar_version: number } & AgentProfileRow>(
    `select p.id, p.handle::text as handle, p.display_name, p.avatar_version, p.kind, ${AGENT_PROFILE_COLUMNS}
       from principals p ${AGENT_PROFILE_JOIN}
      where p.id = any($1::uuid[]) order by p.handle::text`,
    [[...ids]],
  );
  return rows.map((p) => ({
    id: p.id,
    handle: p.handle,
    displayName: p.display_name,
    avatarVersion: p.avatar_version,
    kind: p.kind,
    ...agentProfile(p),
  }));
}

/**
 * Who `messages` name, by id. Pass only messages already rendered for one reader (`toWireFor`): what is
 * named is exactly what that reader's copies show, so nothing about hidden messages or quotes leaks.
 */
export async function principalsOf(q: Queryable, messages: WireMessage[]): Promise<Record<string, SyncPrincipal>> {
  const mentioned = new Set(messages.flatMap(mentionedIn));
  if (mentioned.size === 0) return {};
  return Object.fromEntries((await readPrincipals(q, mentioned)).map((p) => [p.id, p]));
}
