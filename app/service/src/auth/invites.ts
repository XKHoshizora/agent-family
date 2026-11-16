import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db.ts";

const CODE_LENGTH = 20;

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Creates a single-use invite and returns the plaintext code (only its SHA-256 is stored). */
export async function createInvite(db: Queryable, opts: { ttlHours: number }): Promise<string> {
  const code = randomBytes(CODE_LENGTH).toString("base64url").slice(0, CODE_LENGTH);
  await db.query("insert into invites (code_hash, expires_at) values ($1, now() + make_interval(secs => $2))", [
    hashInviteCode(code),
    opts.ttlHours * 3600,
  ]);
  return code;
}

/** Locks the invite row; true when it exists, is unused and has not expired. */
export async function lockUsableInvite(q: Queryable, code: string): Promise<boolean> {
  const { rowCount } = await q.query(
    "select 1 from invites where code_hash = $1 and used_at is null and expires_at > now() for update",
    [hashInviteCode(code)],
  );
  return rowCount === 1;
}

/**
 * Uses the invite up (`used_at`). `principalId` is the account it made; null when the registration made none (the
 * e-mail already had a verified account). An invite stays used up when that account is later removed.
 */
export async function markInviteUsed(q: Queryable, code: string, principalId: string | null): Promise<void> {
  await q.query("update invites set used_by = $2, used_at = now() where code_hash = $1", [
    hashInviteCode(code),
    principalId,
  ]);
}
