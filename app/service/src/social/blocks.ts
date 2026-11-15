import { appendDirectNotice } from "../conversations/store.ts";
import type { Tx } from "../db.ts";
import type { StoredMessage } from "../messages/model.ts";
import { lockPair } from "./pair.ts";

// The read-only pair questions live in relations.ts (a leaf module conversations can import).
export { areFriends, blockBetween, canDirectSend } from "./relations.ts";

export interface BlockResult {
  /** False when the block already existed. */
  created: boolean;
  /** Pending requests this block cancelled (withdrawn if the blocker sent it, rejected if received). */
  cancelledRequestIds: string[];
  /** The "blocked" notice in the pair's direct conversation, when the block is new and they have one. */
  notices: StoredMessage[];
}

/** Blocking is one-directional, leaves any friendship alone, and cancels pending requests between the pair. */
export async function blockPrincipal(t: Tx, blocker: string, blocked: string): Promise<BlockResult> {
  await lockPair(t, blocker, blocked);
  const ins = await t.query(
    "insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing",
    [blocker, blocked],
  );
  const cancelled = await t.query<{ id: string }>(
    `update friend_requests
        set status = case when from_id = $1 then 'withdrawn' else 'rejected' end, resolved_at = now()
      where status = 'pending'
        and least(from_id, to_id) = least($1::uuid, $2::uuid) and greatest(from_id, to_id) = greatest($1::uuid, $2::uuid)
      returning id`,
    [blocker, blocked],
  );
  const created = (ins.rowCount ?? 0) > 0;
  const notice = created ? await appendDirectNotice(t, { event: "blocked", actorId: blocker, principalId: blocked }) : null;
  return { created, cancelledRequestIds: cancelled.rows.map((r) => r.id), notices: notice ? [notice] : [] };
}

/** Restores nothing but the ability to interact. Returns whether a block was removed, and its notice. */
export async function unblockPrincipal(
  t: Tx,
  blocker: string,
  blocked: string,
): Promise<{ removed: boolean; notices: StoredMessage[] }> {
  await lockPair(t, blocker, blocked);
  const del = await t.query("delete from blocks where blocker_id = $1 and blocked_id = $2", [blocker, blocked]);
  const removed = (del.rowCount ?? 0) > 0;
  const notice = removed ? await appendDirectNotice(t, { event: "unblocked", actorId: blocker, principalId: blocked }) : null;
  return { removed, notices: notice ? [notice] : [] };
}
