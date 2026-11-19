import type { Queryable, Tx } from "../db.ts";
import { listAgentNotes, listOwnerNotes, NOTE_COLUMNS, toNote, type Note, type NoteRow, type Rooms } from "./store.ts";

/**
 * Changing notes and hearsay: what the owner's routes need on top of the reads of store.ts. A room is the owner's
 * shared one or one Agent's own; every change to a room happens under `lockRoom`, so its limit holds when two requests
 * race. The vault only fills by itself: nothing here takes a note out of it unless the caller says so (`vault: false`
 * in a patch, which only an owner-authenticated route sends).
 */

export type Room = { kind: "owner"; ownerId: string } | { kind: "self"; agentId: string };

const TABLE = { owner: "owner_notes", self: "agent_notes" } as const;
const COLUMN = { owner: "owner_id", self: "agent_id" } as const;
/** What `room` holds at most, in code points. */
export const roomLimit = (rooms: Rooms, kind: Room["kind"]): number => (kind === "owner" ? rooms.owner : rooms.self);

/** Whether `growth` more code points fit a room that holds `usedNow` of `limit` (a change that shrinks it always fits). */
export const fits = (usedNow: number, growth: number, limit: number): boolean => growth <= 0 || usedNow + growth <= limit;

const keyOf = (room: Room): string => (room.kind === "owner" ? room.ownerId : room.agentId);

/** The notes of `room`, oldest first. */
export const listRoom = (q: Queryable, room: Room): Promise<Note[]> => (room.kind === "owner" ? listOwnerNotes(q, room.ownerId) : listAgentNotes(q, room.agentId));

/**
 * A timestamp column as text in one explicit, session-independent format (UTC, microseconds): what a change records and
 * compares (a JS Date keeps milliseconds only, and the session's time zone must not matter). `$n::timestamptz` reads it back.
 */
export const exactTs = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ExactNote {
  note: Note;
  /** `created_at`, `updated_at` and `seen_at` as `exactTs` prints them. */
  createdAt: string;
  updatedAt: string;
  seenAt: string;
}

/** The notes of `room`, oldest first, with their exact timestamps from the same read. */
export async function listRoomExact(q: Queryable, room: Room): Promise<ExactNote[]> {
  const { rows } = await q.query<NoteRow & { created_x: string; updated_x: string; seen_x: string }>(
    `select ${NOTE_COLUMNS}, ${exactTs("created_at")} as created_x, ${exactTs("updated_at")} as updated_x, ${exactTs("seen_at")} as seen_x
       from ${TABLE[room.kind]} where ${COLUMN[room.kind]} = $1 order by created_at, id`,
    [keyOf(room)],
  );
  return rows.map((r) => ({ note: toNote(room.kind, r), createdAt: r.created_x, updatedAt: r.updated_x, seenAt: r.seen_x }));
}

/** The exact `updated_at` of the notes `ids` of `room`, by id. */
export async function updatedAtOf(q: Queryable, room: Room, ids: ReadonlyArray<string>): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await q.query<{ id: string; updated: string }>(
    `select id, ${exactTs("updated_at")} as updated from ${TABLE[room.kind]} where ${COLUMN[room.kind]} = $1 and id = any($2::uuid[])`,
    [keyOf(room), ids],
  );
  return new Map(rows.map((r) => [r.id, r.updated]));
}

/** One note of `room`, or null when it has none such. */
export async function readNote(q: Queryable, room: Room, id: string): Promise<Note | null> {
  const { rows } = await q.query<NoteRow>(`select ${NOTE_COLUMNS} from ${TABLE[room.kind]} where id = $1 and ${COLUMN[room.kind]} = $2`, [id, keyOf(room)]);
  return rows[0] ? toNote(room.kind, rows[0]) : null;
}

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
  /** A part split off another note keeps its strength, last-mentioned time and (`createdAt`, a microsecond later by `createdOffsetUs` each) the creation time; else 0, now, now. */
  strength?: number;
  seenAt?: string;
  createdAt?: string;
  createdOffsetUs?: number;
}

/** Adds a note to `room` (under `lockRoom`); returns its id. Notes added one after another list in that order (`clock_timestamp`, not the transaction's time). */
export async function insertNote(t: Tx, room: Room, n: NewNote): Promise<string> {
  const { rows } = await t.query<{ id: string }>(
    `insert into ${TABLE[room.kind]} (${COLUMN[room.kind]}, text, vault, vault_by, unsure, origin, origin_conversation_id, strength, seen_at, created_at, updated_at)
     select $1, $2, $3, $4, $5, $6, $7, coalesce($8::int, 0), coalesce($9::timestamptz, c.ts), coalesce($10::timestamptz + $11::int * interval '1 microsecond', c.ts), c.ts
       from (select clock_timestamp() as ts) c returning id`,
    [keyOf(room), n.text, n.vault, n.vaultBy, n.unsure, n.origin, n.originConversationId, n.strength ?? null, n.seenAt ?? null, n.createdAt ?? null, n.createdOffsetUs ?? 0],
  );
  return rows[0]!.id;
}

/** Puts back a note that was deleted (under `lockRoom`), as it was: same id, creation time and state. Its conversation may be gone by now: the column then goes null, as it would have. */
export async function restoreNote(
  t: Tx,
  room: Room,
  n: Pick<Note, "id" | "text" | "vault" | "vaultBy" | "unsure" | "origin" | "originConversationId"> & { createdAt: Date | string; updatedAt: Date | string; strength?: number; seenAt?: Date | string },
): Promise<void> {
  await t.query(
    `insert into ${TABLE[room.kind]} (${COLUMN[room.kind]}, id, text, vault, vault_by, unsure, origin, origin_conversation_id, created_at, updated_at, strength, seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, (select id from conversations where id = $8), $9::timestamptz, $10::timestamptz, coalesce($11::int, 0), coalesce($12::timestamptz, now()))`,
    [keyOf(room), n.id, n.text, n.vault, n.vaultBy, n.unsure, n.origin, n.originConversationId, n.createdAt, n.updatedAt, n.strength ?? null, n.seenAt ?? null],
  );
}

export interface NotePatch {
  text?: string;
  vault?: boolean;
  vaultBy?: "auto" | "owner";
  unsure?: boolean;
  /** Writes this exact `updated_at` (an undo putting a note back as it was) instead of a new clock value. */
  updatedAt?: string;
  /** Writes this exact strength / last-mentioned time (an undo, a merge), or `"now"` for the seen time (a review that wrote the note). Neither touches `updated_at`. */
  strength?: number;
  seenAt?: string;
  /** The conversation the note began in: `null` clears it, left out keeps it (what to write is origin.ts's rule; an undo writes what was recorded). */
  originConversationId?: string | null;
}

/** Changes the fields given of a note of `room` (under `lockRoom`); false when `room` has no such note. Every call bumps `updated_at`, even when no value changes: it is how a change knows the owner touched a note since. */
export async function updateNote(t: Tx, room: Room, id: string, patch: NotePatch): Promise<boolean> {
  const { rowCount } = await t.query(
    `update ${TABLE[room.kind]}
        set text = coalesce($3, text), vault = coalesce($4, vault), vault_by = coalesce($5, vault_by),
            unsure = coalesce($6, unsure), updated_at = coalesce($7::timestamptz, clock_timestamp()),
            strength = coalesce($8::int, strength),
            seen_at = case when $9::text = 'now' then clock_timestamp() when $9::text is not null then $9::timestamptz else seen_at end,
            origin_conversation_id = case when $10::boolean then (select id from conversations where id = $11::uuid) else origin_conversation_id end
      where id = $1 and ${COLUMN[room.kind]} = $2`,
    [
      id,
      keyOf(room),
      patch.text ?? null,
      patch.vault ?? null,
      patch.vaultBy ?? null,
      patch.unsure ?? null,
      patch.updatedAt ?? null,
      patch.strength ?? null,
      patch.seenAt ?? null,
      patch.originConversationId !== undefined,
      patch.originConversationId ?? null,
    ],
  );
  return rowCount === 1;
}

/**
 * The owner mentioned these notes of `room` again: each is one stronger and seen now. `updated_at` is not touched (this is
 * not a change anybody is told of, and it must never make an undo stale). Notes that are gone are skipped.
 */
export async function bumpNotes(q: Queryable, room: Room, ids: ReadonlyArray<string>): Promise<void> {
  if (ids.length === 0) return;
  await q.query(
    `update ${TABLE[room.kind]} set strength = strength + 1, seen_at = clock_timestamp() where ${COLUMN[room.kind]} = $1 and id = any($2::uuid[])`,
    [keyOf(room), ids],
  );
}

/** Deletes a note of `room`; false when `room` has no such note. */
export async function deleteNote(q: Queryable, room: Room, id: string): Promise<boolean> {
  const { rowCount } = await q.query(`delete from ${TABLE[room.kind]} where id = $1 and ${COLUMN[room.kind]} = $2`, [id, keyOf(room)]);
  return rowCount === 1;
}

/** One entry of the Agent's hearsay with its timestamps exactly as stored (`exactTs`: what a change records to put it back). */
export interface HearsayExact {
  id: string;
  conversationId: string;
  speakerId: string | null;
  speakerName: string;
  text: string;
  saidAt: string;
  createdAt: string;
}

/** Holds the Agent's hearsay room until the transaction ends (the account lock is taken first): reading how much it holds and changing it are one step. */
export async function lockHearsay(t: Tx, agentId: string): Promise<void> {
  await t.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`memory-hearsay:${agentId}`]);
}

/** Every hearsay entry of the Agent (all its groups), oldest first, with exact timestamps. */
export async function listHearsayExact(q: Queryable, agentId: string): Promise<HearsayExact[]> {
  const { rows } = await q.query<{ id: string; conversation_id: string; speaker_id: string | null; speaker_name: string; text: string; said: string; created: string }>(
    `select id, conversation_id, speaker_id, speaker_name, text, ${exactTs("said_at")} as said, ${exactTs("created_at")} as created
       from agent_hearsay where agent_id = $1 order by created_at, id`,
    [agentId],
  );
  return rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, speakerId: r.speaker_id, speakerName: r.speaker_name, text: r.text, saidAt: r.said, createdAt: r.created }));
}

/** Adds an entry to the Agent's hearsay (under `lockHearsay`); returns its id. Entries added one after another list in that order. */
export async function insertHearsay(
  t: Tx,
  agentId: string,
  h: { conversationId: string; speakerId: string; speakerName: string; text: string; saidAt: Date },
): Promise<string> {
  const { rows } = await t.query<{ id: string }>(
    `insert into agent_hearsay (agent_id, conversation_id, speaker_id, speaker_name, text, said_at, created_at)
     select $1, $2, $3, $4, $5, $6, c.ts from (select clock_timestamp() as ts) c returning id`,
    [agentId, h.conversationId, h.speakerId, h.speakerName, h.text, h.saidAt],
  );
  return rows[0]!.id;
}

/** Puts back an entry that was deleted, as it was (same id and times). False when its group is gone (the entry went with it); a speaker who is gone leaves the entry with no speaker id. */
export async function restoreHearsay(t: Tx, agentId: string, h: HearsayExact): Promise<boolean> {
  const { rowCount } = await t.query(
    `insert into agent_hearsay (agent_id, id, conversation_id, speaker_id, speaker_name, text, said_at, created_at)
     select $1, $2, c.id, (select id from principals where id = $4), $5, $6, $7::timestamptz, $8::timestamptz from conversations c where c.id = $3`,
    [agentId, h.id, h.conversationId, h.speakerId, h.speakerName, h.text, h.saidAt, h.createdAt],
  );
  return rowCount === 1;
}

/** Deletes entries of the Agent's hearsay by id; the ids of those it really deleted. */
export async function deleteHearsay(q: Queryable, agentId: string, ids: ReadonlyArray<string>): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await q.query<{ id: string }>("delete from agent_hearsay where agent_id = $1 and id = any($2::uuid[]) returning id", [agentId, ids]);
  return rows.map((r) => r.id);
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
