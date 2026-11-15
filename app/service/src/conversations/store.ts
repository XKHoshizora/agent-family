import type { Tx } from "../db.ts";
import { lockPair, orderedPair } from "../social/pair.ts";

/**
 * The direct conversation for the unordered pair, created on first use. Idempotent and race-safe
 * (serialised on the pair lock). `creatorId` (the accepter, when called from accept) is recorded as
 * creator. Both parties are speakers from seq 0 and stay members for good, so re-befriending after
 * unfriending reuses the same conversation.
 */
export async function ensureDirect(t: Tx, a: string, b: string, creatorId: string = b): Promise<string> {
  await lockPair(t, a, b);
  const [lo, hi] = orderedPair(a, b);
  const existing = await t.query<{ conversation_id: string }>(
    "select conversation_id from direct_pairs where a_id = $1 and b_id = $2",
    [lo, hi],
  );
  if (existing.rows[0]) return existing.rows[0].conversation_id;

  const created = await t.query<{ id: string }>(
    "insert into conversations (type, creator_id) values ('direct', $1) returning id",
    [creatorId],
  );
  const id = created.rows[0]!.id;
  await t.query("insert into direct_pairs (conversation_id, a_id, b_id) values ($1, $2, $3)", [id, lo, hi]);
  await t.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq)
     values ($1, $2, 'speaker', 0), ($1, $3, 'speaker', 0)`,
    [id, lo, hi],
  );
  return id;
}
