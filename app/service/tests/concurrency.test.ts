import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadSlots } from "../src/attachments/slots.ts";
import { befriend, signUp, type Actor } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { closeAllSockets, connect, listen } from "./helpers/ws.ts";

/**
 * Concurrency: real parallel HTTP requests (fetch over a listening socket, one TCP connection each)
 * against the real Postgres pool (10 connections). Each scenario states its invariant, runs several
 * rounds, and checks the invariant against the database, not only against the answers.
 */

const QUOTA = 10_000;
const { blobs, files: blobFiles } = useProbeBlobs("af-conc-");
const { app, db } = useApp({
  blobs,
  // Enough upload slots that the quota, not the 3-at-once cap, decides the quota race.
  uploads: createUploadSlots(100),
  // Set past `loadConfig`'s rules: a quota under the smallest per-file size they allow.
  config: { attachmentQuotaBytes: QUOTA, attachmentMaxBytes: QUOTA },
});
afterEach(closeAllSockets);

const ROUNDS = 4;

interface Answer {
  status: number;
  json: any;
}

/** One real HTTP request, as a non-browser client (no Origin). */
async function call(who: Actor | null, method: string, path: string, body?: unknown): Promise<Answer> {
  const { http } = await listen(app);
  const res = await fetch(http + path, {
    method,
    headers: { ...(who ? { cookie: who.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let txn = 0;
const say = (who: Actor, conv: string, text: string) => call(who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `k${++txn}` });
const addMember = (who: Actor, conv: string, target: Actor) => call(who, "POST", `/api/conversations/${conv}/members`, { principalId: target.id });
const removeMember = (who: Actor, conv: string, target: Actor) => call(who, "DELETE", `/api/conversations/${conv}/members/${target.id}`);
const request = (from: Actor, to: Actor) => call(from, "POST", "/api/friend-requests", { handle: to.handle });
const block = (who: Actor, target: Actor) => call(who, "PUT", `/api/blocks/${target.id}`);
const unblock = (who: Actor, target: Actor) => call(who, "DELETE", `/api/blocks/${target.id}`);

async function rows<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}
const one = async (sql: string, params: unknown[] = []) => Number((await rows(sql, params))[0]!.n);

async function newGroup(creator: Actor, members: Actor[], title = "g"): Promise<string> {
  const res = await call(creator, "POST", "/api/conversations", { title, memberIds: members.map((m) => m.id) });
  if (res.status !== 201) throw new Error(`group ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.id;
}

/** Every seq of the conversation is used exactly once, from 1 to `conversations.seq`. */
async function expectGapless(conv: string): Promise<void> {
  const seqs = (await rows<{ seq: string }>("select seq from messages where conversation_id = $1 order by seq", [conv])).map((r) => Number(r.seq));
  const last = await one("select seq n from conversations where id = $1", [conv]);
  expect(seqs).toEqual(Array.from({ length: last }, (_, i) => i + 1));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const after = <T>(ms: number, f: () => Promise<T>) => sleep(ms).then(f);
/**
 * Runs `x` and `y` together, giving one of them a small head start (0-4 ms, alternating sides by
 * round), so both orders of a one-against-one race actually occur over the rounds.
 */
function oneOnOne<A, B>(round: number, x: () => Promise<A>, y: () => Promise<B>): Promise<[A, B]> {
  const lead = [0, 1, 2, 4][Math.floor(round / 2) % 4]!;
  return Promise.all([round % 2 ? after(lead, x) : x(), round % 2 ? y() : after(lead, y)]);
}

/**
 * Starts `n / 2` requests at once; once `n / 8` of them have been answered (the race is under way),
 * starts the other `n / 2` one millisecond apart with `change` in their middle, so requests keep
 * arriving before, with and after it. Resolves with every answer.
 */
async function race(n: number, send: (i: number) => Promise<Answer>, change: () => Promise<Answer>) {
  let answered = 0;
  let underWay!: () => void;
  const started = new Promise<void>((resolve) => (underWay = resolve));
  const first = Array.from({ length: n / 2 }, (_, i) =>
    send(i).then((r) => {
      if (++answered === n / 8) underWay();
      return r;
    }),
  );
  await started;
  const second = Array.from({ length: n / 2 }, (_, i) => after(i, () => send(n / 2 + i)));
  const changed = after(n / 4, change);
  return { sends: await Promise.all([...first, ...second]), changed: await changed };
}

it("runs against a real pool of at least 10 connections", () => {
  expect(db.pool.options.max).toBeGreaterThanOrEqual(10);
});

describe("sends racing a loss of the right to send", () => {
  // Invariant (Review Focus 1): every send is either stored and answered 201, or refused with the
  // answer the change implies; the number answered 201 equals the number of rows stored; nothing is
  // stored after the change's notice (every accepted seq is below it); and a send issued after the
  // change's response came back is refused.
  const scenarios = [
    {
      name: "an unfriend",
      setup: async (a: Actor, b: Actor) => (await befriend(app, a, b)).conversationId,
      change: (a: Actor, b: Actor) => call(b, "DELETE", `/api/friends/${a.id}`),
      restore: async (a: Actor, b: Actor) => void (await befriend(app, a, b)),
      notice: "friendship_ended",
      refused: { status: 403, json: { error: "cannot_send", reason: "not_friends" } },
    },
    {
      name: "a block",
      setup: async (a: Actor, b: Actor) => (await befriend(app, a, b)).conversationId,
      change: (a: Actor, b: Actor) => block(b, a),
      restore: async (a: Actor, b: Actor) => void (await unblock(b, a)),
      notice: "blocked",
      refused: { status: 403, json: { error: "cannot_send", reason: "blocked" } },
    },
  ];
  for (const s of scenarios) {
    it(`40 concurrent sends racing ${s.name}`, { timeout: 60_000 }, async () => {
      const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
      const dm = await s.setup(a, b);
      for (let round = 0; round < ROUNDS; round++) {
        const before = await one("select seq n from conversations where id = $1", [dm]);
        const { sends, changed } = await race(40, (i) => say(i % 2 ? a : b, dm, `r${round}-${i}`), () => s.change(a, b));
        expect(changed.status).toBe(200);
        const late = await say(a, dm, "after the change");
        expect(late).toEqual(s.refused);

        const accepted = sends.filter((r) => r.status === 201);
        expect(sends.filter((r) => r.status !== 201).every((r) => JSON.stringify(r) === JSON.stringify(s.refused))).toBe(true);
        const stored = await one("select count(*) n from messages where conversation_id = $1 and kind = 'text' and seq > $2", [dm, before]);
        expect(stored).toBe(accepted.length);
        const notice = await one(
          "select seq n from messages where conversation_id = $1 and kind = 'system' and body->>'event' = $2 and seq > $3",
          [dm, s.notice, before],
        );
        expect(accepted.every((r) => r.json.message.seq < notice)).toBe(true);
        expect(await one("select seq n from conversations where id = $1", [dm])).toBe(notice);
        await expectGapless(dm);
        await s.restore(a, b);
      }
    });
  }

  it("40 concurrent sends racing removal of the sender from a group", { timeout: 60_000 }, async () => {
    const [c, a, x] = [await signUp(app, "carol"), await signUp(app, "alice"), await signUp(app, "xavier")];
    await befriend(app, c, a);
    await befriend(app, c, x);
    const g = await newGroup(c, [a, x]);
    for (let round = 0; round < ROUNDS; round++) {
      const before = await one("select seq n from conversations where id = $1", [g]);
      const { sends, changed } = await race(40, (i) => say(a, g, `r${round}-${i}`), () => removeMember(c, g, a));
      expect(changed.status).toBe(200);
      expect(await say(a, g, "after removal")).toEqual({ status: 404, json: { error: "not_found" } });

      const accepted = sends.filter((r) => r.status === 201);
      expect(sends.filter((r) => r.status !== 201).every((r) => r.status === 404 && r.json.error === "not_found")).toBe(true);
      expect(await one("select count(*) n from messages where conversation_id = $1 and kind = 'text' and seq > $2", [g, before])).toBe(accepted.length);
      const notice = await one(
        "select seq n from messages where conversation_id = $1 and body->>'event' = 'member_removed' and seq > $2",
        [g, before],
      );
      expect(accepted.every((r) => r.json.message.seq < notice)).toBe(true);
      // Her membership ended exactly at the notice: she can read none of what follows.
      expect(await one("select left_seq n from memberships where conversation_id = $1 and principal_id = $2 and left_seq > $3", [g, a.id, before])).toBe(notice);
      await expectGapless(g);
      expect((await addMember(c, g, a)).status).toBe(201);
    }
  });
});

describe("membership races", () => {
  it("20 concurrent adds of the same person: one current membership, one join notice", { timeout: 60_000 }, async () => {
    // Invariant: however many adds race (from two different members), the person ends with exactly
    // one current membership and exactly one member_joined notice per time they were added.
    const [c, m, x, t] = [await signUp(app, "carol"), await signUp(app, "mike"), await signUp(app, "xavier"), await signUp(app, "target")];
    await befriend(app, c, m);
    await befriend(app, c, x);
    await befriend(app, c, t);
    await befriend(app, m, t);
    const g = await newGroup(c, [m, x]);
    for (let round = 0; round < ROUNDS; round++) {
      const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => addMember(i % 2 ? m : c, g, t)));
      expect(answers.filter((r) => r.status === 201)).toHaveLength(1);
      expect(answers.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.json.error === "already_member")).toBe(true);
      expect(await one("select count(*) n from memberships where conversation_id = $1 and principal_id = $2 and left_seq is null", [g, t.id])).toBe(1);
      expect(
        await one("select count(*) n from messages where conversation_id = $1 and body->>'event' = 'member_joined' and body->>'principalId' = $2", [g, t.id]),
      ).toBe(round + 1);
      await expectGapless(g);
      expect((await removeMember(c, g, t)).status).toBe(200);
    }
  });

  it("a block racing a group add of the blocked person: the add is consistent with one order, and later adds are refused", { timeout: 60_000 }, async () => {
    // Invariant: the add either happened before the block (201: a member with one join notice) or after
    // it (403 forbidden: not a member, no notice) — never a member without a notice or the reverse; and an
    // add issued after the block's response came back is refused.
    const [c, p, m1, m2] = [await signUp(app, "carol"), await signUp(app, "pat"), await signUp(app, "m1"), await signUp(app, "m2")];
    for (const f of [p, m1, m2]) await befriend(app, c, f);
    const groups = [await newGroup(c, [m1, m2], "g1"), await newGroup(c, [m1, m2], "g2"), await newGroup(c, [m1, m2], "g3")];
    for (let round = 0; round < ROUNDS * 2; round++) {
      const blocker = round % 2 ? c : p; // either side's block forbids the add
      const other = blocker === c ? p : c;
      const [adds, blocked] = await oneOnOne(round, () => Promise.all(groups.map((g) => addMember(c, g, p))), () => block(blocker, other));
      expect(blocked.status).toBe(200);
      for (const [i, g] of groups.entries()) {
        const add = adds[i]!;
        expect([201, 403]).toContain(add.status);
        const member = await one("select count(*) n from memberships where conversation_id = $1 and principal_id = $2 and left_seq is null", [g, p.id]);
        const joins = await one(
          "select count(*) n from messages where conversation_id = $1 and body->>'event' = 'member_joined' and body->>'principalId' = $2",
          [g, p.id],
        );
        const joinsBefore = await one("select count(*) n from memberships where conversation_id = $1 and principal_id = $2 and left_seq is not null", [g, p.id]);
        expect([add.status, member, joins - joinsBefore]).toEqual(add.status === 201 ? [201, 1, 1] : [403, 0, 0]);
        expect((await addMember(c, g, p)).status).toBe(add.status === 201 ? 409 : 403);
        if (member) expect((await removeMember(c, g, p)).status).toBe(200);
      }
      expect((await unblock(blocker, other)).status).toBe(200);
    }
  });

  it("two concurrent leaves by the last two members: both succeed, the second closes, the creator handover is consistent", { timeout: 60_000 }, async () => {
    // Invariant: the two leaves serialise. The first keeps the group open (and, if it was the creator's,
    // hands over to the other); the second closes it with nobody left. Exactly one member_left notice
    // each, consecutive seqs; the stored creator is the one the notices name; nothing can be sent after.
    const [c, a, b] = [await signUp(app, "carol"), await signUp(app, "alice"), await signUp(app, "bob")];
    await befriend(app, c, a);
    await befriend(app, c, b);
    for (let round = 0; round < ROUNDS * 2; round++) {
      const g = await newGroup(c, [a, b]);
      // Odd rounds: the creator is one of the last two; even rounds: the creator left first and handed over.
      const firstOut = round % 2 ? a : c;
      expect((await removeMember(firstOut, g, firstOut)).status).toBe(200);
      const [x, y] = firstOut === c ? [a, b] : [c, b];
      const creatorBefore = (await rows<{ creator_id: string }>("select creator_id from conversations where id = $1", [g]))[0]!.creator_id;
      const [lx, ly] = await oneOnOne(round, () => removeMember(x, g, x), () => removeMember(y, g, y));
      expect([lx.status, ly.status]).toEqual([200, 200]);

      const notices = await rows<{ seq: string; actor: string; new_creator: string | null }>(
        `select seq, body->>'actorId' as actor, body->>'newCreatorId' as new_creator from messages
          where conversation_id = $1 and body->>'event' = 'member_left' order by seq`,
        [g],
      );
      expect(notices).toHaveLength(3);
      const [, first, second] = notices as [unknown, (typeof notices)[0], (typeof notices)[0]];
      expect(Number(second.seq)).toBe(Number(first.seq) + 1);
      expect(new Set([first.actor, second.actor])).toEqual(new Set([x.id, y.id]));
      // The first leaver hands over only if it was the creator, and then to the other one.
      expect(first.new_creator).toBe(first.actor === creatorBefore ? second.actor : null);
      expect(second.new_creator).toBeNull();
      const conv = (await rows<{ creator_id: string; closed: boolean }>("select creator_id, closed_at is not null as closed from conversations where id = $1", [g]))[0]!;
      expect(conv.closed).toBe(true);
      expect(conv.creator_id).toBe(first.new_creator ?? creatorBefore);
      expect(await one("select count(*) n from memberships where conversation_id = $1 and left_seq is null", [g])).toBe(0);
      expect(await say(x, g, "anyone?")).toEqual({ status: 404, json: { error: "not_found" } });
      await expectGapless(g);
    }
  });

  it("two members sending concurrently: sequence numbers are gapless and unique", { timeout: 60_000 }, async () => {
    // Invariant: every accepted message gets its own seq; together they fill the range without gaps.
    const [c, a, b] = [await signUp(app, "carol"), await signUp(app, "alice"), await signUp(app, "bob")];
    await befriend(app, c, a);
    await befriend(app, c, b);
    const g = await newGroup(c, [a, b]);
    for (let round = 0; round < ROUNDS; round++) {
      const before = await one("select seq n from conversations where id = $1", [g]);
      const answers = await Promise.all(Array.from({ length: 40 }, (_, i) => say(i % 2 ? a : b, g, `r${round}-${i}`)));
      expect(answers.every((r) => r.status === 201)).toBe(true);
      const seqs = answers.map((r) => r.json.message.seq as number).sort((x, y) => x - y);
      expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => before + i + 1));
      await expectGapless(g);
    }
  });
});

describe("friend request races", () => {
  it("accept racing withdraw of the same request: exactly one wins, never a friendship with a withdrawn request", { timeout: 60_000 }, async () => {
    // Invariant: one 200 and one 409 request_not_pending; the request ends accepted with a friendship,
    // or withdrawn without one.
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    for (let round = 0; round < ROUNDS * 2; round++) {
      const id = (await request(a, b)).json.id;
      const [accept, withdraw] = await oneOnOne(
        round,
        () => call(b, "POST", `/api/friend-requests/${id}/accept`),
        () => call(a, "POST", `/api/friend-requests/${id}/withdraw`),
      );
      expect([accept.status, withdraw.status].sort()).toEqual([200, 409]);
      const loser = accept.status === 200 ? withdraw : accept;
      expect(loser.json).toEqual({ error: "request_not_pending" });
      const status = (await rows<{ status: string }>("select status from friend_requests where id = $1", [id]))[0]!.status;
      const friends = await one("select count(*) n from friendships");
      expect([status, friends]).toEqual(accept.status === 200 ? ["accepted", 1] : ["withdrawn", 0]);
      if (friends) expect((await call(a, "DELETE", `/api/friends/${b.id}`)).status).toBe(200);
    }
  });

  it("a friend request racing a block: no pending request survives, and a later request is refused", { timeout: 60_000 }, async () => {
    // Invariant: the request is either refused (403 blocked: the block came first) or created and then
    // cancelled by the block — rejected if the blocker received it, withdrawn if the blocker sent it.
    // Never a pending request between a blocked pair; a request issued after the block returned is 403.
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    for (let round = 0; round < ROUNDS * 2; round++) {
      const blocker = round % 2 ? a : b;
      const other = blocker === a ? b : a;
      const [sent, blocked] = await oneOnOne(round, () => request(a, b), () => block(blocker, other));
      expect(blocked.status).toBe(200);
      expect(await one("select count(*) n from friend_requests where status = 'pending'")).toBe(0);
      if (sent.status === 201) {
        const status = (await rows<{ status: string }>("select status from friend_requests where id = $1", [sent.json.id]))[0]!.status;
        expect(status).toBe(blocker === b ? "rejected" : "withdrawn");
      } else {
        expect(sent).toEqual({ status: 403, json: { error: "blocked" } });
      }
      expect(await request(a, b)).toEqual({ status: 403, json: { error: "blocked" } });
      expect(await request(b, a)).toEqual({ status: 403, json: { error: "blocked" } });
      expect((await unblock(blocker, other)).status).toBe(200);
    }
  });
});

describe("read markers and quotas", () => {
  it("concurrent read-marker updates never move backwards, in the table or in the pushes", { timeout: 60_000 }, async () => {
    // Invariant: each answer is at least the seq it asked for; the stored marker ends at the highest seq
    // asked for; the peer's socket sees the marker only ever move forward, ending at that value.
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    for (let i = 0; i < 60; i++) await say(b, dm, `m${i}`);
    const peer = await connect(app, b);
    let highest = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const asks = Array.from({ length: 30 }, (_, i) => 1 + ((i * 7 + round * 13) % 15) + round * 15);
      highest = Math.max(highest, ...asks);
      const answers = await Promise.all(asks.map((seq) => call(a, "POST", `/api/conversations/${dm}/read`, { seq })));
      for (const [i, r] of answers.entries()) {
        expect(r.status).toBe(200);
        expect(r.json.readSeq).toBeGreaterThanOrEqual(asks[i]!);
      }
      expect(await one("select read_seq n from memberships where conversation_id = $1 and principal_id = $2", [dm, a.id])).toBe(highest);
      await peer.waitFor((e) => e.type === "read" && e.principalId === a.id && e.seq === highest);
    }
    const pushed = peer.events.filter((e) => e.type === "read" && e.principalId === a.id).map((e) => e.seq as number);
    expect(pushed).toEqual([...pushed].sort((x, y) => x - y));
    expect(pushed.at(-1)).toBe(highest);
  });

  it("concurrent uploads at the quota boundary never exceed it", { timeout: 60_000 }, async () => {
    // Invariant: whatever the interleaving, the bytes one principal stores never exceed the quota:
    // exactly as many uploads succeed as fit, every other one is 413 quota, and nothing is left behind.
    const [peer] = [await signUp(app, "peer")];
    for (let round = 0; round < ROUNDS; round++) {
      const u = await signUp(app, `uploader${round}`);
      const { conversationId: dm } = await befriend(app, u, peer);
      const size = 2_000 + round * 500; // 5, 4, 3, 2 fit under 10 000
      const { http } = await listen(app);
      const answers = await Promise.all(
        Array.from({ length: 12 }, async (_, i) => {
          const res = await fetch(`${http}/api/conversations/${dm}/attachments`, {
            method: "POST",
            headers: { cookie: u.cookie, "content-type": MULTIPART },
            body: new Uint8Array(multipart([{ name: "file", filename: `f${i}.bin`, type: "application/octet-stream", data: Buffer.alloc(size, i) }])),
          });
          return { status: res.status, json: await res.json() };
        }),
      );
      const fit = Math.floor(QUOTA / size);
      expect(answers.filter((r) => r.status === 201)).toHaveLength(fit);
      expect(answers.filter((r) => r.status !== 201).every((r) => r.status === 413 && r.json.reason === "quota")).toBe(true);
      expect(await one("select coalesce(sum(size), 0) n from attachments where uploader_id = $1", [u.id])).toBe(fit * size);
      await vi.waitFor(async () => expect(await one("select count(*) n from pending_blobs")).toBe(0));
      expect(blobFiles().length).toBe(await one("select count(*) n from attachments"));
    }
  });
});
