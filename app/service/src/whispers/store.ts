import { cleanText } from "../agents/runtime/prompt.ts";
import { lockConversation } from "../conversations/store.ts";
import type { Queryable, Tx } from "../db.ts";
import { weight } from "../metering/tokens.ts";

/**
 * Whispers (悄悄话, design rules 16 and 19): a small note in a conversation that only the owner of one of its Agents ever
 * sees, with the buttons it offers (`告诉他们` → accepted, `不用` → declined). It is never a message: it takes no seq —
 * message seqs are gapless, and every other member would see a gap — and sits after the message that was the
 * conversation's last when it was made (`afterSeq`). So nothing that reads messages (history, sync's messages, catch-up's
 * messages, search, unread, `lastSeq`, the Agent's model context) can ever meet one; the owner alone reads them, through
 * the functions here, by their own id (`owner_id = <reader>` in every statement).
 *
 * A whisper is open until its owner answers it (`resolveWhisper`, once), it is 7 days old (`expireWhispers`, the periodic
 * sweep), its owner or its Agent leaves the conversation (`expireOnLeave`), or its Agent is deleted (`expireOfAgent`); it
 * goes with the conversation's, the owner's or the Agent's row. Lock order: the conversation's row, then whisper rows.
 * Nothing here reads, logs or returns a whisper's text to anyone but its owner.
 */

export const WHISPER_KINDS = ["found_elsewhere", "tools_off", "memory"] as const;
export type WhisperKind = (typeof WHISPER_KINDS)[number];
export const WHISPER_STATUSES = ["open", "accepted", "declined", "expired"] as const;
export type WhisperStatus = (typeof WHISPER_STATUSES)[number];
/** The buttons a whisper may offer: `tell` (告诉他们) answers it `accepted`, `dismiss` (不用) `declined`. */
export const WHISPER_ACTIONS = ["tell", "dismiss"] as const;
export type WhisperAction = (typeof WHISPER_ACTIONS)[number];
export type WhisperAnswer = "accepted" | "declined";
const BUTTON_OF: Record<WhisperAnswer, WhisperAction> = { accepted: "tell", declined: "dismiss" };

/** The longest whisper text, in weight (metering/tokens.ts `weight`), once cleaned. */
export const WHISPER_TEXT_MAX = 2000;
/** An open whisper this many days old is expired by the sweep. */
export const WHISPER_OPEN_DAYS = 7;
/** A sweep works through at most `WHISPER_SWEEP_BATCHES` batches of `WHISPER_SWEEP_BATCH` rows; what is left waits for the next run. */
export const WHISPER_SWEEP_BATCH = 500;
export const WHISPER_SWEEP_BATCHES = 20;
/** At most this many whispers (the newest) go with one sync or catch-up answer. */
export const WHISPERS_PER_ANSWER = 500;

/** What a whisper says: its text, its buttons and what a later task keeps with it (`detail`, given back to the owner as it is). */
export interface WhisperBody {
  text: string;
  actions: WhisperAction[];
  detail?: unknown;
}

export interface Whisper {
  id: string;
  conversationId: string;
  ownerId: string;
  agentId: string;
  /** The conversation's last seq when it was made: it shows after that message. */
  afterSeq: number;
  kind: WhisperKind;
  body: WhisperBody;
  status: WhisperStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}

interface WhisperRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  agent_id: string;
  after_seq: string;
  kind: WhisperKind;
  body: WhisperBody;
  status: WhisperStatus;
  created_at: Date;
  resolved_at: Date | null;
}

const columns = (alias: string): string =>
  ["id", "conversation_id", "owner_id", "agent_id", "after_seq", "kind", "body", "status", "created_at", "resolved_at"].map((c) => `${alias}.${c}`).join(", ");
const COLUMNS = columns("whispers");

const toWhisper = (r: WhisperRow): Whisper => ({
  id: r.id,
  conversationId: r.conversation_id,
  ownerId: r.owner_id,
  agentId: r.agent_id,
  afterSeq: Number(r.after_seq),
  kind: r.kind,
  body: r.body,
  status: r.status,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

/**
 * A whisper's body as it is stored, or null when it is none: the text cleaned as notices and notes are (`cleanText`: one
 * line, no invisible format or control characters, trimmed), not empty and at most `WHISPER_TEXT_MAX` weight; the
 * buttons a subset of `tell` and `dismiss`, each once; `detail` kept as its JSON says it (absent when it has none). Nothing
 * else of what is given is kept.
 */
export function whisperBody(raw: unknown): WhisperBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { text, actions, detail } = raw as Record<string, unknown>;
  if (typeof text !== "string" || !Array.isArray(actions)) return null;
  const clean = cleanText(text);
  if (clean === "" || weight(clean) > WHISPER_TEXT_MAX) return null;
  if (!actions.every((a): a is WhisperAction => (WHISPER_ACTIONS as readonly unknown[]).includes(a)) || new Set(actions).size !== actions.length) return null;
  const json = detail === undefined ? undefined : JSON.stringify(detail);
  return { text: clean, actions: [...actions], ...(json === undefined ? {} : { detail: JSON.parse(json) as unknown }) };
}

/**
 * A new open whisper of `ownerId` about their Agent `agentId` in `conversationId`, after the conversation's last seq —
 * under the conversation's row (taken here, `lockConversation`), so no message, leaving or answer comes between that seq,
 * the checks and the insert. Null, and nothing stored, unless the conversation exists, `ownerId` is a current member of it,
 * and `agentId` is their Agent (not deleted) and a current member of it too. A body that is not one (`whisperBody`) or an
 * unknown kind is the caller's mistake: it throws. The caller pushes it to the owner once committed (`Hub.pushWhisper`).
 */
export async function createWhisper(
  t: Tx,
  w: { conversationId: string; ownerId: string; agentId: string; kind: WhisperKind; body: WhisperBody },
): Promise<Whisper | null> {
  const body = whisperBody(w.body);
  if (!body) throw new Error("createWhisper: the whisper body is not one (a text of 1 to 2000 weight once cleaned, buttons among tell and dismiss, each once)");
  if (!(WHISPER_KINDS as readonly string[]).includes(w.kind)) throw new Error("createWhisper: not a whisper kind");
  const conversation = await lockConversation(t, w.conversationId);
  if (!conversation) return null;
  const { rows } = await t.query<WhisperRow>(
    `insert into whispers (conversation_id, owner_id, agent_id, after_seq, kind, body)
     select $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::jsonb
      where exists (select 1 from memberships me where me.conversation_id = $1 and me.principal_id = $2 and me.left_seq is null)
        and exists (
          select 1 from memberships am
            join agents a on a.principal_id = am.principal_id
            join principals p on p.id = am.principal_id
           where am.conversation_id = $1 and am.principal_id = $3 and am.left_seq is null and a.deleted_at is null and p.owner_id = $2)
     returning ${COLUMNS}`,
    [conversation.id, w.ownerId, w.agentId, conversation.seq, w.kind, JSON.stringify(body)],
  );
  return rows[0] ? toWhisper(rows[0]) : null;
}

/**
 * The owner's answer to their whisper `id`: `accepted` (its `tell` button) or `declined` (its `dismiss`). Changes its status
 * and nothing else (what an answer does for a kind is the caller's, whispers/routes.ts `ANSWER_HOOKS`). "gone" when there is
 * no whisper `id` of `ownerId`'s — anyone else's and none are found by the same single read —; "stale" when it is not open
 * any more, or does not offer that answer's button. Takes the conversation's row, then the whisper's.
 */
export async function resolveWhisper(t: Tx, ownerId: string, id: string, to: WhisperAnswer): Promise<Whisper | "gone" | "stale"> {
  const found = await t.query<{ conversation_id: string }>("select conversation_id from whispers where id = $1 and owner_id = $2", [id, ownerId]);
  if (!found.rows[0]) return "gone";
  await lockConversation(t, found.rows[0].conversation_id);
  const { rows } = await t.query<WhisperRow>(`select ${COLUMNS} from whispers where id = $1 and owner_id = $2 for update`, [id, ownerId]);
  const row = rows[0];
  if (!row) return "gone";
  if (row.status !== "open" || !Array.isArray(row.body.actions) || !row.body.actions.includes(BUTTON_OF[to])) return "stale";
  const updated = await t.query<WhisperRow>(`update whispers set status = $2, resolved_at = now() where id = $1 returning ${COLUMNS}`, [id, to]);
  return toWhisper(updated.rows[0]!);
}

export interface WhisperPage {
  /** Newest first: by `afterSeq`, then `createdAt`. */
  whispers: Whisper[];
  /** The `before` of the next page (an `afterSeq`), or null when none is older. */
  nextBefore: number | null;
}

/**
 * A page of `ownerId`'s whispers in `conversationId`, every status, below `before` (an `afterSeq`; none: from the newest):
 * the newest `limit`, and with them the rest of the whispers at the same place as the last of them (a page never splits
 * one place, so `nextBefore` is that place). Null — the route's 404, the same as for a conversation that is none — unless
 * `ownerId` is a current member of it and owns an Agent that is one too, or has a whisper there: decided in one statement,
 * which for anyone not in the conversation stops at the membership, as for an id that is none.
 */
export async function listWhispers(
  q: Queryable,
  ownerId: string,
  conversationId: string,
  { before, limit }: { before?: number | undefined; limit: number },
): Promise<WhisperPage | null> {
  const allowed = await q.query<{ ok: boolean }>(
    `select exists (
       select 1 from memberships me
        where me.conversation_id = $1 and me.principal_id = $2 and me.left_seq is null
          and (exists (select 1 from memberships am join principals p on p.id = am.principal_id
                        where am.conversation_id = $1 and am.left_seq is null and p.owner_id = $2)
               or exists (select 1 from whispers w where w.owner_id = $2 and w.conversation_id = $1))
     ) as ok`,
    [conversationId, ownerId],
  );
  if (!allowed.rows[0]?.ok) return null;
  const page = await q.query<WhisperRow>(
    `select ${COLUMNS} from whispers
      where owner_id = $1 and conversation_id = $2 and ($3::bigint is null or after_seq < $3::bigint)
      order by after_seq desc, created_at desc, id desc limit $4`,
    [ownerId, conversationId, before ?? null, limit],
  );
  if (page.rows.length < limit) return { whispers: page.rows.map(toWhisper), nextBefore: null };
  const place = page.rows.at(-1)!.after_seq;
  const rest = await q.query<WhisperRow>(
    `select ${COLUMNS} from whispers where owner_id = $1 and conversation_id = $2 and after_seq = $3 order by created_at desc, id desc`,
    [ownerId, conversationId, place],
  );
  const older = await q.query<{ more: boolean }>(
    "select exists (select 1 from whispers where owner_id = $1 and conversation_id = $2 and after_seq < $3) as more",
    [ownerId, conversationId, place],
  );
  const rows = [...page.rows.filter((r) => r.after_seq !== place), ...rest.rows];
  return { whispers: rows.map(toWhisper), nextBefore: older.rows[0]?.more ? Number(place) : null };
}

/**
 * `ownerId`'s whispers in each conversation of `from` they are a current member of: the open ones, and those at or after
 * the seq given for it (sync: the oldest message it returns of that conversation, 0 when it returns all; catch-up: the
 * position) — ascending by `afterSeq`, then `createdAt`, conversations in the order of `from`. At most
 * `WHISPERS_PER_ANSWER`, the newest. What `GET /api/sync` and catch-up carry for the owner alone.
 */
export async function whispersFrom(q: Queryable, ownerId: string, from: ReadonlyArray<{ conversationId: string; seq: number }>): Promise<Whisper[]> {
  if (from.length === 0) return [];
  const { rows } = await q.query<WhisperRow & { ord: string }>(
    `select x.* from (
       select ${columns("w")}, f.ord
         from unnest($2::uuid[], $3::bigint[]) with ordinality as f (id, from_seq, ord)
         join memberships me on me.conversation_id = f.id and me.principal_id = $1 and me.left_seq is null
         join whispers w on w.owner_id = $1 and w.conversation_id = f.id and (w.status = 'open' or w.after_seq >= f.from_seq)
        order by w.created_at desc, w.id desc limit $4
     ) x order by x.ord, x.after_seq, x.created_at, x.id`,
    [ownerId, from.map((f) => f.conversationId), from.map((f) => f.seq), WHISPERS_PER_ANSWER],
  );
  return rows.map(toWhisper);
}

/**
 * In the transaction that takes `leaving` (people and Agents) out of `conversationId`, under its row: the open whispers
 * there whose owner or Agent is among them are expired. Returns them, for their owners' sockets once committed.
 */
export async function expireOnLeave(t: Tx, conversationId: string, leaving: readonly string[]): Promise<Whisper[]> {
  if (leaving.length === 0) return [];
  const { rows } = await t.query<WhisperRow>(
    `update whispers set status = 'expired', resolved_at = now()
      where conversation_id = $1 and status = 'open'
        and owner_id in (select coalesce(p.owner_id, p.id) from principals p where p.id = any($2::uuid[]))
        and (owner_id = any($2::uuid[]) or agent_id = any($2::uuid[]))
      returning ${COLUMNS}`,
    [conversationId, leaving],
  );
  return rows.map(toWhisper);
}

/** In the transaction that deletes Agent `agentId`: its open whispers, everywhere, are expired. Returns them, for its owner's sockets. */
export async function expireOfAgent(t: Tx, agentId: string): Promise<Whisper[]> {
  const { rows } = await t.query<WhisperRow>(
    `update whispers set status = 'expired', resolved_at = now()
      where owner_id = (select owner_id from principals where id = $1) and agent_id = $1 and status = 'open'
      returning ${COLUMNS}`,
    [agentId],
  );
  return rows.map(toWhisper);
}

/**
 * The periodic sweep (app.ts runs it with the memory changes' clean-up, on that timer; `attachments:sweep` by hand): an
 * open whisper `WHISPER_OPEN_DAYS` days old (`now` is the clock) is expired. Bounded work: at most `batches` batches of
 * `batch` rows (by default `WHISPER_SWEEP_BATCHES` × `WHISPER_SWEEP_BATCH`), found by the index `(status, created_at)`; the
 * status is asked again in the update itself, so an answer that got there first stands. Returns what it expired, for the
 * owners' sockets. Never logs a whisper.
 */
export async function expireWhispers(q: Queryable, now: Date = new Date(), limits: { batch?: number; batches?: number } = {}): Promise<Whisper[]> {
  const batch = limits.batch ?? WHISPER_SWEEP_BATCH;
  const batches = limits.batches ?? WHISPER_SWEEP_BATCHES;
  const expired: Whisper[] = [];
  for (let i = 0; i < batches; i++) {
    const { rows } = await q.query<WhisperRow>(
      `update whispers set status = 'expired', resolved_at = $1::timestamptz
        where id in (
          select id from whispers where status = 'open' and created_at < $1::timestamptz - $2::int * interval '1 day' order by created_at limit $3)
          and status = 'open'
        returning ${COLUMNS}`,
      [now, WHISPER_OPEN_DAYS, batch],
    );
    expired.push(...rows.map(toWhisper));
    if (rows.length < batch) break;
  }
  return expired;
}
