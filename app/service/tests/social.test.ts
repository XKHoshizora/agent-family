import { describe, expect, it, vi } from "vitest";
import { onMembershipChanged, onMessages } from "../src/conversations/events.ts";
import { canDirectSend } from "../src/social/blocks.ts";
import { onSocialChanged } from "../src/social/routes.ts";
import { api, befriend, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

const { app, db } = useApp();

const send = (from: Actor, to: Actor) => api(app, from, "POST", "/api/friend-requests", { handle: to.handle });
const decide = (who: Actor, id: string, what: "accept" | "reject" | "withdraw") =>
  api(app, who, "POST", `/api/friend-requests/${id}/${what}`);
const social = (who: Actor) => api(app, who, "GET", "/api/social");
const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
const NOT_FOUND = { error: "not_found" };
const NO_SUCH_ID = "00000000-0000-4000-8000-000000000000";

describe("friend requests", () => {
  it("request then accept makes both friends and returns a direct conversation", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const sent = await send(a, b);
    expect(sent.status).toBe(201);

    expect((await social(b)).json.incoming).toMatchObject([{ id: sent.json.id, principal: { id: a.id, handle: a.handle } }]);
    expect((await social(a)).json.outgoing).toMatchObject([{ id: sent.json.id, principal: { id: b.id } }]);

    const accepted = await decide(b, sent.json.id, "accept");
    expect(accepted.status).toBe(200);
    expect(accepted.json.conversationId).toEqual(expect.any(String));
    expect((await social(a)).json.friends.map((f: any) => f.id)).toEqual([b.id]);
    expect((await social(b)).json.friends.map((f: any) => f.id)).toEqual([a.id]);
    expect((await social(b)).json.incoming).toEqual([]);

    // Both are speakers of the direct conversation, from seq 0.
    const { rows } = await db.query("select principal_id, role, joined_seq from memberships where conversation_id = $1", [
      accepted.json.conversationId,
    ]);
    expect(rows.map((r) => r.principal_id).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((r) => r.role === "speaker" && Number(r.joined_seq) === 0)).toBe(true);
  });

  it("unfriending keeps the conversation; re-befriending returns the same one, in either direction", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId } = await befriend(app, a, b);

    expect((await api(app, a, "DELETE", `/api/friends/${b.id}`)).status).toBe(200);
    expect((await social(a)).json.friends).toEqual([]);
    expect((await social(b)).json.friends).toEqual([]);
    expect(await count("select count(*) n from conversations where id = $1", [conversationId])).toBe(1);
    expect(await count("select count(*) n from memberships where conversation_id = $1 and left_seq is null", [conversationId])).toBe(2);
    expect(await canDirectSend(db, a.id, b.id)).toBe("not_friends");
    // Not friends any more: a second unfriend is a 404.
    expect((await api(app, a, "DELETE", `/api/friends/${b.id}`)).json).toEqual(NOT_FOUND);

    const again = await befriend(app, b, a);
    expect(again.conversationId).toBe(conversationId);
    expect(await count("select count(*) n from conversations")).toBe(1);
    expect(await count("select count(*) n from direct_pairs")).toBe(1);
    expect(await canDirectSend(db, a.id, b.id)).toBeNull();
  });

  it("reject and withdraw end the request; only the right party may act, others get 404", async () => {
    const [a, b, c] = [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];

    const r1 = (await send(a, b)).json.id;
    expect((await decide(a, r1, "accept")).json).toEqual(NOT_FOUND); // sender cannot accept
    expect((await decide(a, r1, "reject")).json).toEqual(NOT_FOUND); // nor reject
    expect((await decide(b, r1, "withdraw")).json).toEqual(NOT_FOUND); // recipient cannot withdraw
    expect((await decide(c, r1, "accept")).json).toEqual(NOT_FOUND);
    expect((await decide(b, r1, "reject")).status).toBe(200);
    expect((await api(app, a, "GET", `/api/friend-requests/${r1}`)).json.status).toBe("rejected");
    expect((await decide(b, r1, "accept")).status).toBe(409); // already resolved

    const r2 = (await send(a, b)).json.id; // a new request is fine once the old one is resolved
    expect((await decide(a, r2, "withdraw")).status).toBe(200);
    expect((await api(app, b, "GET", `/api/friend-requests/${r2}`)).json.status).toBe("withdrawn");
    expect((await decide(b, r2, "accept")).status).toBe(409);
    expect((await social(b)).json.friends).toEqual([]);
  });

  it("a request older than 24h cannot be accepted and reads as expired", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const id = (await send(a, b)).json.id;
    const { rows } = await db.query<{ hours: string }>(
      "select extract(epoch from expires_at - created_at) / 3600 as hours from friend_requests where id = $1",
      [id],
    );
    expect(Number(rows[0]!.hours)).toBe(24);

    await db.query("update friend_requests set expires_at = now() - interval '1 minute' where id = $1", [id]);
    expect((await api(app, b, "GET", `/api/friend-requests/${id}`)).json.status).toBe("expired");
    expect((await social(b)).json.incoming).toEqual([]);
    expect((await social(a)).json.outgoing).toEqual([]);

    const res = await decide(b, id, "accept");
    expect(res).toMatchObject({ status: 409, json: { error: "request_expired" } });
    expect((await social(b)).json.friends).toEqual([]);
    expect(await count("select count(*) n from friendships")).toBe(0);
    expect(await count("select count(*) n from friend_requests where id = $1 and status = 'expired'", [id])).toBe(1);

    // An expired request does not hold the pair's pending slot.
    expect((await send(b, a)).status).toBe(201);
  });

  it("a lapsed pending request is persisted as expired when a new request touches the pair", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const old = (await send(a, b)).json.id;
    await db.query("update friend_requests set expires_at = now() - interval '1 second' where id = $1", [old]);
    expect((await send(a, b)).status).toBe(201);
    expect(await count("select count(*) n from friend_requests where id = $1 and status = 'expired'", [old])).toBe(1);
    expect(await count("select count(*) n from friend_requests where status = 'pending'")).toBe(1);
  });

  it("refuses self, duplicates in either direction, friends, and unknown handles", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    expect(await send(a, a)).toMatchObject({ status: 400, json: { error: "invalid_request" } });
    expect(await api(app, a, "POST", "/api/friend-requests", { handle: "nobody_here" })).toMatchObject({ status: 404, json: NOT_FOUND });
    expect((await api(app, a, "POST", "/api/friend-requests", { handle: "x" })).status).toBe(400);
    expect((await api(app, a, "POST", "/api/friend-requests", {})).status).toBe(400);
    expect((await api(app, null, "POST", "/api/friend-requests", { handle: b.handle })).status).toBe(401);

    expect((await send(a, b)).status).toBe(201);
    expect(await send(a, b)).toMatchObject({ status: 409, json: { error: "request_pending" } });
    expect(await send(b, a)).toMatchObject({ status: 409, json: { error: "request_pending" } });
    expect(await count("select count(*) n from friend_requests")).toBe(1);

    const [c, d] = [await signUp(app, "carol"), await signUp(app, "dave")];
    await befriend(app, c, d);
    expect(await send(c, d)).toMatchObject({ status: 409, json: { error: "already_friends" } });
    expect(await send(d, c)).toMatchObject({ status: 409, json: { error: "already_friends" } });
  });

  it("rejects malformed ids with 400 before any handler logic", async () => {
    const a = await signUp(app, "alice");
    expect((await decide(a, "not-a-uuid", "accept")).status).toBe(400);
    expect((await api(app, a, "DELETE", "/api/friends/nope")).status).toBe(400);
    expect((await api(app, a, "PUT", "/api/blocks/nope")).status).toBe(400);
    expect((await decide(a, NO_SUCH_ID, "accept")).json).toEqual(NOT_FOUND);
  });
});

describe("blocks", () => {
  it("a block stops requests both ways with 403 blocked until unblocked", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    expect((await api(app, a, "PUT", `/api/blocks/${b.id}`)).status).toBe(200);
    expect(await send(b, a)).toMatchObject({ status: 403, json: { error: "blocked" } });
    expect(await send(a, b)).toMatchObject({ status: 403, json: { error: "blocked" } });
    expect(await canDirectSend(db, a.id, b.id)).toBe("blocked");
    expect(await canDirectSend(db, b.id, a.id)).toBe("blocked");

    expect((await social(a)).json).toMatchObject({ blocked: [{ id: b.id }], blockedBy: [] });
    expect((await social(b)).json).toMatchObject({ blocked: [], blockedBy: [{ id: a.id, handle: a.handle }] });

    expect((await api(app, a, "DELETE", `/api/blocks/${b.id}`)).status).toBe(200);
    expect((await social(b)).json.blockedBy).toEqual([]);
    expect((await send(b, a)).status).toBe(201);
  });

  it("blocking is idempotent and rejects self and unknown principals", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    expect((await api(app, a, "PUT", `/api/blocks/${b.id}`)).status).toBe(200);
    expect((await api(app, a, "PUT", `/api/blocks/${b.id}`)).status).toBe(200);
    expect(await count("select count(*) n from blocks")).toBe(1);
    expect((await api(app, a, "PUT", `/api/blocks/${a.id}`)).status).toBe(400);
    expect((await api(app, a, "PUT", `/api/blocks/${NO_SUCH_ID}`)).json).toEqual(NOT_FOUND);
    expect((await api(app, a, "DELETE", `/api/blocks/${b.id}`)).status).toBe(200);
    expect((await api(app, a, "DELETE", `/api/blocks/${b.id}`)).status).toBe(200);
  });

  it("blocking cancels a pending request: withdrawn if the blocker sent it, rejected if received", async () => {
    const [a, b, c] = [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const sentByBlocker = (await send(a, b)).json.id;
    const receivedByBlocker = (await send(c, a)).json.id;
    await api(app, a, "PUT", `/api/blocks/${b.id}`);
    await api(app, a, "PUT", `/api/blocks/${c.id}`);
    expect((await api(app, a, "GET", `/api/friend-requests/${sentByBlocker}`)).json.status).toBe("withdrawn");
    expect((await api(app, a, "GET", `/api/friend-requests/${receivedByBlocker}`)).json.status).toBe("rejected");
    expect((await decide(b, sentByBlocker, "accept")).status).toBe(409);
    expect((await social(a)).json).toMatchObject({ incoming: [], outgoing: [] });
    expect((await social(b)).json.incoming).toEqual([]);
  });

  it("blocking records a lapsed pending request as expired, not withdrawn or rejected", async () => {
    const [a, b, c] = [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const lapsedSent = (await send(a, b)).json.id;
    const lapsedReceived = (await send(c, a)).json.id;
    await db.query("update friend_requests set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'");
    expect((await api(app, a, "PUT", `/api/blocks/${b.id}`)).status).toBe(200);
    expect((await api(app, a, "PUT", `/api/blocks/${c.id}`)).status).toBe(200);
    // Stored, not only read: the lapsed requests were never withdrawn or rejected by anyone.
    const stored = await db.query<{ id: string; status: string }>("select id, status from friend_requests order by id");
    expect(Object.fromEntries(stored.rows.map((r) => [r.id, r.status]))).toEqual({ [lapsedSent]: "expired", [lapsedReceived]: "expired" });
  });

  it("blocking someone already blocked changes nothing and announces nothing", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    const social: string[][] = [];
    const notices: number[] = [];
    const changed: string[] = [];
    const offs = [
      onSocialChanged(app, (ids) => void social.push(ids)),
      onMessages(app, (ms) => void notices.push(...ms.map((m) => m.seq))),
      onMembershipChanged(app, (id) => void changed.push(id)),
    ];
    try {
      expect((await api(app, a, "PUT", `/api/blocks/${b.id}`)).status).toBe(200);
      await vi.waitFor(() => expect(social).toHaveLength(1));
      expect(notices).toHaveLength(1);
      expect(changed).toEqual([dm]);
      for (let i = 0; i < 3; i++) expect(await api(app, a, "PUT", `/api/blocks/${b.id.toUpperCase()}`)).toEqual({ status: 200, json: { ok: true } });
      await new Promise((r) => setTimeout(r, 50));
      expect([social.length, notices.length, changed.length]).toEqual([1, 1, 1]);
      expect(await count("select count(*) n from messages where conversation_id = $1 and kind = 'system' and body->>'event' = 'blocked'", [dm])).toBe(1);
    } finally {
      for (const off of offs) off();
    }
  });

  it("blocking leaves the friendship and conversation intact, and unblocking restores sending", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId } = await befriend(app, a, b);
    await api(app, b, "PUT", `/api/blocks/${a.id}`);
    expect((await social(a)).json.friends.map((f: any) => f.id)).toEqual([b.id]);
    expect(await canDirectSend(db, a.id, b.id)).toBe("blocked");
    await api(app, b, "DELETE", `/api/blocks/${a.id}`);
    expect(await canDirectSend(db, a.id, b.id)).toBeNull();
    expect(await count("select count(*) n from conversations where id = $1", [conversationId])).toBe(1);
  });
});

describe("id canonicalisation", () => {
  const upper = (s: string) => s.toUpperCase();
  // Mixed case: alternate letters so neither pure form matches the stored lower-case id.
  const mixed = (s: string) => [...s].map((ch, i) => (i % 2 ? ch.toUpperCase() : ch)).join("");

  it("self-block via an upper-case own id is 400, never 5xx", async () => {
    const a = await signUp(app, "alice");
    for (const f of [upper, mixed]) {
      expect(await api(app, a, "PUT", `/api/blocks/${f(a.id)}`)).toMatchObject({ status: 400, json: { error: "invalid_request" } });
    }
    expect(await count("select count(*) n from blocks")).toBe(0);
  });

  it("block, unblock and unfriend behave identically for upper and mixed-case ids", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    await befriend(app, a, b);
    expect((await api(app, a, "PUT", `/api/blocks/${upper(b.id)}`)).status).toBe(200);
    expect(await canDirectSend(db, a.id, b.id)).toBe("blocked");
    expect((await social(b)).json.blockedBy.map((x: any) => x.id)).toEqual([a.id]);
    expect((await api(app, a, "DELETE", `/api/blocks/${mixed(b.id)}`)).status).toBe(200);
    expect(await count("select count(*) n from blocks")).toBe(0);
    expect((await api(app, b, "DELETE", `/api/friends/${upper(a.id)}`)).status).toBe(200);
    expect((await social(a)).json.friends).toEqual([]);
    expect((await api(app, b, "DELETE", `/api/friends/${mixed(a.id)}`)).json).toEqual(NOT_FOUND);
  });

  it("accept, reject and withdraw work with upper-case request ids; listeners get lower-case principal ids", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const seen: string[][] = [];
    const off = onSocialChanged(app, (ids) => void seen.push(ids));
    try {
      const r1 = (await send(a, b)).json.id;
      expect((await decide(b, upper(r1), "reject")).status).toBe(200);
      const r2 = (await send(a, b)).json.id;
      expect((await decide(a, mixed(r2), "withdraw")).status).toBe(200);
      const r3 = (await send(a, b)).json.id;
      expect((await decide(b, upper(r3), "accept")).status).toBe(200);
      expect((await api(app, a, "GET", `/api/friend-requests/${upper(r3)}`)).json.status).toBe("accepted");
      await api(app, a, "PUT", `/api/blocks/${upper(b.id)}`);
    } finally {
      off();
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const ids of seen) for (const id of ids) expect(id).toBe(id.toLowerCase());
  });

  it("an upper-case block still serialises with a simultaneous accept", async () => {
    // Invariant, whichever order wins: the block exists; no request is left pending; the request is
    // accepted with a friendship iff accept returned 200, otherwise it was rejected with no friendship.
    for (let i = 0; i < 8; i++) {
      const [a, b] = [await signUp(app, `alice${i}`), await signUp(app, `bob${i}`)];
      const id = (await send(a, b)).json.id;
      const [acc, blk] = await Promise.all([decide(b, id, "accept"), api(app, b, "PUT", `/api/blocks/${upper(a.id)}`)]);
      expect(blk.status).toBe(200);
      const status = (await api(app, a, "GET", `/api/friend-requests/${id}`)).json.status;
      const friends = await count("select count(*) n from friendships where a_id = least($1::uuid, $2::uuid)", [a.id, b.id]);
      expect(await count("select count(*) n from blocks where blocker_id = $1 and blocked_id = $2", [b.id, a.id])).toBe(1);
      if (acc.status === 200) expect([status, friends]).toEqual(["accepted", 1]);
      else {
        expect(acc.status).toBe(409);
        expect([status, friends]).toEqual(["rejected", 0]);
      }
    }
  });
});

describe("accept re-checks blocks", () => {
  it("a block row present while a request is pending makes accept 403 blocked, with no friendship", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const id = (await send(a, b)).json.id;
    await db.query("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [a.id, b.id]);
    expect(await decide(b, id, "accept")).toMatchObject({ status: 403, json: { error: "blocked" } });
    expect(await count("select count(*) n from friendships")).toBe(0);
    expect(await count("select count(*) n from conversations")).toBe(0);
  });
});

describe("privacy", () => {
  it("a third party can neither read nor act on a request, and never sees other people's rows", async () => {
    const [a, b, c] = [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const id = (await send(a, b)).json.id;

    for (const what of ["accept", "reject", "withdraw"] as const) {
      expect(await decide(c, id, what)).toMatchObject({ status: 404, json: NOT_FOUND });
    }
    expect(await api(app, c, "GET", `/api/friend-requests/${id}`)).toMatchObject({ status: 404, json: NOT_FOUND });
    // Same body as a request that does not exist at all.
    expect((await api(app, c, "GET", `/api/friend-requests/${NO_SUCH_ID}`)).json).toEqual(NOT_FOUND);
    expect(await count("select count(*) n from friend_requests where status = 'pending'")).toBe(1);

    await decide(b, id, "accept");
    await api(app, a, "PUT", `/api/blocks/${c.id}`);

    // C sees only that A blocks C; nothing about A and B's friendship.
    expect((await social(c)).json).toEqual({
      friends: [],
      incoming: [],
      outgoing: [],
      blocked: [],
      blockedBy: [{ id: a.id, handle: a.handle, displayName: "alice" }],
    });
    expect((await api(app, c, "DELETE", `/api/friends/${a.id}`)).json).toEqual(NOT_FOUND);
  });
});

describe("concurrency", () => {
  it("simultaneous requests A->B and B->A leave exactly one pending row", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const results = await Promise.all([send(a, b), send(b, a), send(a, b), send(b, a)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.json.error === "request_pending")).toBe(true);
    expect(await count("select count(*) n from friend_requests where status = 'pending'")).toBe(1);
    expect(await count("select count(*) n from friend_requests")).toBe(1);
  });

  it("simultaneous accept and withdraw leave exactly one outcome", async () => {
    for (let i = 0; i < 5; i++) {
      const [a, b] = [await signUp(app, `alice${i}`), await signUp(app, `bob${i}`)];
      const id = (await send(a, b)).json.id;
      const [acc, wd] = await Promise.all([decide(b, id, "accept"), decide(a, id, "withdraw")]);
      expect([acc.status, wd.status].sort()).toEqual([200, 409]);
      const status = (await api(app, a, "GET", `/api/friend-requests/${id}`)).json.status;
      const friends = await count("select count(*) n from friendships where a_id = least($1::uuid, $2::uuid)", [a.id, b.id]);
      if (acc.status === 200) expect([status, friends]).toEqual(["accepted", 1]);
      else expect([status, friends]).toEqual(["withdrawn", 0]);
    }
  });

  it("simultaneous accepts create one friendship and one direct conversation", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const id = (await send(a, b)).json.id;
    const results = await Promise.all([decide(b, id, "accept"), decide(b, id, "accept"), decide(b, id, "accept")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await count("select count(*) n from friendships")).toBe(1);
    expect(await count("select count(*) n from conversations")).toBe(1);
    expect(await count("select count(*) n from direct_pairs")).toBe(1);
    expect(await count("select count(*) n from memberships")).toBe(2);
  });

  it("simultaneous block and accept never leave a pending request behind", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const id = (await send(a, b)).json.id;
    const [acc, blk] = await Promise.all([decide(b, id, "accept"), api(app, b, "PUT", `/api/blocks/${a.id}`)]);
    expect(blk.status).toBe(200);
    expect([200, 409]).toContain(acc.status);
    expect(await count("select count(*) n from friend_requests where status = 'pending'")).toBe(0);
  });
});

describe("onSocialChanged", () => {
  it("fires after commit with both principals and survives failing listeners", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const seen: string[][] = [];
    const visible: number[] = [];
    const off = onSocialChanged(app, async (ids) => {
      seen.push(ids);
      // After commit: the new row is visible from a separate connection.
      visible.push(await count("select count(*) n from friend_requests where status = 'pending'"));
    });
    const offSync = onSocialChanged(app, () => {
      throw new Error("boom");
    });
    const offAsync = onSocialChanged(app, async () => {
      throw new Error("async boom");
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect((await send(a, b)).status).toBe(201);
      await new Promise((r) => setTimeout(r, 100));
      // A refused mutation announces nothing.
      expect((await send(a, b)).status).toBe(409);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      off();
      offSync();
      offAsync();
    }

    expect(unhandled).toEqual([]);
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].sort()).toEqual([a.id, b.id].sort());
    expect(visible).toEqual([1]);
  });
});
