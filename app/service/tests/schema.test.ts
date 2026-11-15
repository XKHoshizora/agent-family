import { describe, expect, test } from "vitest";
import { useApp } from "./helpers/harness.ts";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

describe("schema guarantees enforced by the database", () => {
  const { db } = useApp();

  async function human(handle: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into principals (kind, handle, display_name, auth_user_id)
       values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`,
      [handle],
    );
    return rows[0]!.id;
  }

  async function conversation(creatorId: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into conversations (type, creator_id) values ('group', $1) returning id`,
      [creatorId],
    );
    return rows[0]!.id;
  }

  async function rejectedWith(code: string, sql: string, params: unknown[] = []): Promise<void> {
    await expect(db.query(sql, params)).rejects.toMatchObject({ code });
  }

  test("an agent with no owner is rejected", async () => {
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into principals (kind, handle, display_name) values ('agent', 'lonely_bot', 'Lonely')`,
    );
  });

  test("a human with an owner is rejected", async () => {
    const owner = await human("owner_one");
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into principals (kind, handle, display_name, owner_id, auth_user_id)
       values ('human', 'owned_human', 'Owned', $1, 'auth-owned')`,
      [owner],
    );
  });

  test("a human without an auth user is rejected", async () => {
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into principals (kind, handle, display_name) values ('human', 'no_auth', 'No Auth')`,
    );
  });

  test("an agent with an owner is accepted", async () => {
    const owner = await human("owner_two");
    const { rowCount } = await db.query(
      `insert into principals (kind, handle, display_name, owner_id) values ('agent', 'good_bot', 'Good', $1)`,
      [owner],
    );
    expect(rowCount).toBe(1);
  });

  test("a second current membership for the same conversation and principal is rejected", async () => {
    const p = await human("member_one");
    const c = await conversation(p);
    await db.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', 0)`,
      [c, p],
    );
    await rejectedWith(
      UNIQUE_VIOLATION,
      `insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', 0)`,
      [c, p],
    );
  });

  test("a new membership is allowed after the previous one has left", async () => {
    const p = await human("member_two");
    const c = await conversation(p);
    await db.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq, left_seq)
       values ($1, $2, 'speaker', 0, 3)`,
      [c, p],
    );
    const { rowCount } = await db.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'speaker', 3)`,
      [c, p],
    );
    expect(rowCount).toBe(1);
  });

  test("a second pending friend request for the same pair is rejected in either direction", async () => {
    const a = await human("friend_a");
    const b = await human("friend_b");
    await db.query(
      `insert into friend_requests (from_id, to_id, expires_at) values ($1, $2, now() + interval '24 hours')`,
      [a, b],
    );
    await rejectedWith(
      UNIQUE_VIOLATION,
      `insert into friend_requests (from_id, to_id, expires_at) values ($1, $2, now() + interval '24 hours')`,
      [a, b],
    );
    await rejectedWith(
      UNIQUE_VIOLATION,
      `insert into friend_requests (from_id, to_id, expires_at) values ($1, $2, now() + interval '24 hours')`,
      [b, a],
    );
  });

  test("a new friend request is allowed once the earlier one is no longer pending", async () => {
    const a = await human("friend_c");
    const b = await human("friend_d");
    await db.query(
      `insert into friend_requests (from_id, to_id, status, expires_at, resolved_at)
       values ($1, $2, 'rejected', now() + interval '24 hours', now())`,
      [a, b],
    );
    const { rowCount } = await db.query(
      `insert into friend_requests (from_id, to_id, expires_at) values ($2, $1, now() + interval '24 hours')`,
      [a, b],
    );
    expect(rowCount).toBe(1);
  });

  test("a duplicate (conversation_id, seq) is rejected", async () => {
    const p = await human("sender_one");
    const c = await conversation(p);
    const insert = `insert into messages (conversation_id, seq, sender_id, kind, body)
                    values ($1, 1, $2, 'text', '{"text":"hi"}')`;
    await db.query(insert, [c, p]);
    await rejectedWith(UNIQUE_VIOLATION, insert, [c, p]);
  });

  test.each(["Upper", "has space", "ab", "x".repeat(25), "dash-ed"])("handle %j is rejected", async (handle) => {
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1, 'X', 'auth-x')`,
      [handle],
    );
  });

  test("handles are unique case-insensitively", async () => {
    await human("same_name");
    await rejectedWith(
      UNIQUE_VIOLATION,
      `insert into principals (kind, handle, display_name, auth_user_id) values ('human', 'same_name', 'X', 'auth-y')`,
    );
  });

  test("friendships must be stored with the smaller id first", async () => {
    const a = await human("order_a");
    const b = await human("order_b");
    const [lo, hi] = a < b ? [a, b] : [b, a];
    await rejectedWith(CHECK_VIOLATION, `insert into friendships (a_id, b_id) values ($1, $2)`, [hi, lo]);
    const { rowCount } = await db.query(`insert into friendships (a_id, b_id) values ($1, $2)`, [lo, hi]);
    expect(rowCount).toBe(1);
  });
});
