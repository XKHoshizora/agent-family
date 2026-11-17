import type { Queryable } from "../db.ts";

export interface PublicPrincipal {
  id: string;
  handle: string;
  displayName: string;
  /** Changes with every avatar change; clients put it in the avatar URL (`?v=`). */
  avatarVersion: number;
}

/**
 * A person by exact handle. An Agent's handle finds nothing, for everyone including its owner: Agents are
 * reached through the owner's Agent routes only, and cannot be looked up or befriended.
 */
export async function findByHandle(db: Queryable, handle: string): Promise<PublicPrincipal | null> {
  const { rows } = await db.query<{ id: string; handle: string; display_name: string; avatar_version: number }>(
    "select id, handle::text as handle, display_name, avatar_version from principals where handle = $1 and kind = 'human'",
    [handle],
  );
  const r = rows[0];
  return r ? { id: r.id, handle: r.handle, displayName: r.display_name, avatarVersion: r.avatar_version } : null;
}

export async function findAvatarSubject(
  db: Queryable,
  id: string,
): Promise<{ id: string; displayName: string; avatarKey: string | null } | null> {
  const { rows } = await db.query<{ id: string; display_name: string; avatar_key: string | null }>(
    "select id, display_name, avatar_key from principals where id = $1",
    [id],
  );
  const r = rows[0];
  return r ? { id: r.id, displayName: r.display_name, avatarKey: r.avatar_key } : null;
}

export async function updateDisplayName(db: Queryable, id: string, displayName: string): Promise<void> {
  await db.query("update principals set display_name = $2 where id = $1", [id, displayName]);
}

/**
 * Locks the row, swaps the key (every change counts in `avatar_version`), and returns the previous key
 * (to hold in the same transaction and delete after commit).
 */
export async function swapAvatarKey(db: Queryable, id: string, newKey: string): Promise<string | null> {
  const { rows } = await db.query<{ avatar_key: string | null }>(
    "select avatar_key from principals where id = $1 for update",
    [id],
  );
  await db.query("update principals set avatar_key = $2, avatar_version = avatar_version + 1 where id = $1", [id, newKey]);
  return rows[0]?.avatar_key ?? null;
}
