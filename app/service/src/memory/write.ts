import type { Queryable, Tx } from "../db.ts";
import { listAgentNotes, listOwnerNotes, type Note } from "./store.ts";

/**
 * Changing notes and hearsay: what the owner's routes need on top of the reads of store.ts. A room is the owner's
 * shared one or one Agent's own; every change to a room happens under `lockRoom`, so its limit holds when two requests
 * race. The vault only fills by itself: nothing here takes a note out of it unless the caller says so (`vault: false`
 * in a patch, which only an owner-authenticated route sends).
 */

export type Room = { kind: "owner"; ownerId: string } | { kind: "self"; agentId: string };

const TABLE = { owner: "owner_notes", self: "agent_notes" } as const;
const COLUMN = { owner: "owner_id", self: "agent_id" } as const;
const keyOf = (room: Room): string => (room.kind === "owner" ? room.ownerId : room.agentId);

/** The notes of `room`, oldest first. */
export const listRoom = (q: Queryable, room: Room): Promise<Note[]> => (room.kind === "owner" ? listOwnerNotes(q, room.ownerId) : listAgentNotes(q, room.agentId));

/** Holds `room` until the transaction ends: reading how much it holds and then adding are one step. */
export async function lockRoom(t: Tx, room: Room): Promise<void> {
  await t.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`memory-room:${room.kind}:${keyOf(room)}`]);
}

export interface NewNote {
  text: string;
  vault: boolean;
  vaultBy: "auto" | "owner";
  unsure: boolean;
  origin: "review" | "owner" | "hearsay";
  originConversationId: string | null;
}

/** Adds a note to `room` (under `lockRoom`); returns its id. */
export async function insertNote(t: Tx, room: Room, n: NewNote): Promise<string> {
  const { rows } = await t.query<{ id: string }>(
    `insert into ${TABLE[room.kind]} (${COLUMN[room.kind]}, text, vault, vault_by, unsure, origin, origin_conversation_id)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [keyOf(room), n.text, n.vault, n.vaultBy, n.unsure, n.origin, n.originConversationId],
  );
  return rows[0]!.id;
}

export interface NotePatch {
  text?: string;
  vault?: boolean;
  vaultBy?: "auto" | "owner";
  unsure?: boolean;
}

/** Changes the fields given of a note of `room` (under `lockRoom`); false when `room` has no such note. */
export async function updateNote(t: Tx, room: Room, id: string, patch: NotePatch): Promise<boolean> {
  const { rowCount } = await t.query(
    `update ${TABLE[room.kind]}
        set text = coalesce($3, text), vault = coalesce($4, vault), vault_by = coalesce($5, vault_by),
            unsure = coalesce($6, unsure), updated_at = now()
      where id = $1 and ${COLUMN[room.kind]} = $2`,
    [id, keyOf(room), patch.text ?? null, patch.vault ?? null, patch.vaultBy ?? null, patch.unsure ?? null],
  );
  return rowCount === 1;
}

/** Deletes a note of `room`; false when `room` has no such note. */
export async function deleteNote(q: Queryable, room: Room, id: string): Promise<boolean> {
  const { rowCount } = await q.query(`delete from ${TABLE[room.kind]} where id = $1 and ${COLUMN[room.kind]} = $2`, [id, keyOf(room)]);
  return rowCount === 1;
}

/** Deletes one of the Agent's hearsay entries and returns it; null when the Agent has no such one. */
export async function takeHearsay(
  q: Queryable,
  agentId: string,
  id: string,
): Promise<{ text: string; conversationId: string } | null> {
  const { rows } = await q.query<{ text: string; conversation_id: string }>(
    "delete from agent_hearsay where id = $1 and agent_id = $2 returning text, conversation_id",
    [id, agentId],
  );
  return rows[0] ? { text: rows[0].text, conversationId: rows[0].conversation_id } : null;
}
