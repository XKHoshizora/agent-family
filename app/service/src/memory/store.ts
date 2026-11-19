import type { Config } from "../config.ts";
import type { Queryable } from "../db.ts";

/**
 * The notes of an Agent's memory as stored, and the one function that decides which of them a conversation may show
 * (`notesFor`). Three rooms: notes about the owner (`owner_notes`, shared by all their Agents), an Agent's own notes
 * (`agent_notes`), and what an Agent heard said in a group (`agent_hearsay`). A note is in the vault unless it was
 * sorted out; the vault is never shown in a group, except a note that began in that very group.
 */

export type NoteKind = "owner" | "self";

export interface Note {
  id: string;
  kind: NoteKind;
  text: string;
  /** In the vault: a group never gets it (unless it began there). */
  vault: boolean;
  /** Who put it in or out of the vault: the sorting code ('auto') or the owner, whose choice is never re-sorted. */
  vaultBy: "auto" | "owner";
  /** The sorting was not sure: it went into the vault until the owner looks. */
  unsure: boolean;
  /** The conversation it was learned in (null once that is gone, or when typed in the notes page). */
  originConversationId: string | null;
  origin: "review" | "owner" | "hearsay";
  createdAt: Date;
  updatedAt: Date;
}

export interface Hearsay {
  id: string;
  agentId: string;
  conversationId: string;
  speakerId: string | null;
  speakerName: string;
  text: string;
  saidAt: Date;
}

/** What each room holds at most, in code points (`MEMORY.roomOwner`, `roomSelf`, `roomHearsay`). */
export interface Rooms {
  owner: number;
  self: number;
  hearsay: number;
}

export const roomOf = (config: Pick<Config, "memory">): Rooms => ({
  owner: config.memory.roomOwner,
  self: config.memory.roomSelf,
  hearsay: config.memory.roomHearsay,
});

/** How much of a room `notes` fill: the sum of their code points. */
export const used = (notes: ReadonlyArray<{ text: string }>): number => notes.reduce((sum, n) => sum + [...n.text].length, 0);

interface NoteRow {
  id: string;
  text: string;
  vault: boolean;
  vault_by: "auto" | "owner";
  unsure: boolean;
  origin_conversation_id: string | null;
  origin: "review" | "owner" | "hearsay";
  created_at: Date;
  updated_at: Date;
}

const NOTE_COLUMNS = "id, text, vault, vault_by, unsure, origin_conversation_id, origin, created_at, updated_at";

const toNote = (kind: NoteKind, r: NoteRow): Note => ({
  id: r.id,
  kind,
  text: r.text,
  vault: r.vault,
  vaultBy: r.vault_by,
  unsure: r.unsure,
  originConversationId: r.origin_conversation_id,
  origin: r.origin,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Every note about the owner, oldest first. */
export async function listOwnerNotes(q: Queryable, ownerId: string): Promise<Note[]> {
  const { rows } = await q.query<NoteRow>(`select ${NOTE_COLUMNS} from owner_notes where owner_id = $1 order by created_at, id`, [ownerId]);
  return rows.map((r) => toNote("owner", r));
}

/** Every note of the Agent's own, oldest first. */
export async function listAgentNotes(q: Queryable, agentId: string): Promise<Note[]> {
  const { rows } = await q.query<NoteRow>(`select ${NOTE_COLUMNS} from agent_notes where agent_id = $1 order by created_at, id`, [agentId]);
  return rows.map((r) => toNote("self", r));
}

/** What the Agent heard, oldest first: in one group, or in all of them. */
export async function listHearsay(q: Queryable, agentId: string, conversationId?: string): Promise<Hearsay[]> {
  const { rows } = await q.query<{
    id: string;
    agent_id: string;
    conversation_id: string;
    speaker_id: string | null;
    speaker_name: string;
    text: string;
    said_at: Date;
  }>(
    `select id, agent_id, conversation_id, speaker_id, speaker_name, text, said_at
       from agent_hearsay
      where agent_id = $1 and ($2::uuid is null or conversation_id = $2)
      order by created_at, id`,
    [agentId, conversationId ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    conversationId: r.conversation_id,
    speakerId: r.speaker_id,
    speakerName: r.speaker_name,
    text: r.text,
    saidAt: r.said_at,
  }));
}

/**
 * The notes `agent` may be shown in a conversation: the usage rules, the only place they are written.
 * Nothing when its memory is off; no notes about the owner when it does not use the shared ones. In the owner's own
 * conversation with it everything is shown. In a group: the notes of either kind that are not in the vault, those that
 * began in that very group, and the hearsay of that group only; nothing else, ever.
 */
export async function notesFor(
  q: Queryable,
  agent: { id: string; ownerId: string; memory: boolean; sharedNotes: boolean },
  where: { conversationId: string; group: boolean },
): Promise<{ owner: Note[]; self: Note[]; hearsay: Hearsay[] }> {
  if (!agent.memory) return { owner: [], self: [], hearsay: [] };
  // In sequence: `q` may be one transaction client, which runs one query at a time.
  const owner = agent.sharedNotes ? await listOwnerNotes(q, agent.ownerId) : [];
  const self = await listAgentNotes(q, agent.id);
  const hearsay = await listHearsay(q, agent.id, where.group ? where.conversationId : undefined);
  if (!where.group) return { owner, self, hearsay };
  const shown = (n: Note): boolean => !n.vault || n.originConversationId === where.conversationId;
  return { owner: owner.filter(shown), self: self.filter(shown), hearsay };
}

export type NewNotes = "auto" | "vault" | "open";

/** The owner's setting for what newly written notes do about the vault (`accounts.new_notes`); `auto` before they chose. */
export async function getNewNotes(q: Queryable, ownerId: string): Promise<NewNotes> {
  const { rows } = await q.query<{ new_notes: NewNotes }>("select new_notes from accounts where principal_id = $1", [ownerId]);
  return rows[0]?.new_notes ?? "auto";
}

/** Sets it, creating the owner's account as `ensureAccount` does. */
export async function setNewNotes(q: Queryable, ownerId: string, value: NewNotes): Promise<void> {
  await q.query(
    `insert into accounts (principal_id, new_notes) values ($1, $2)
     on conflict (principal_id) do update set new_notes = excluded.new_notes`,
    [ownerId, value],
  );
}
