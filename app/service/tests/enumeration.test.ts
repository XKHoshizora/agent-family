import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

/**
 * Enumeration: for every route that takes a conversation id, a message seq, an attachment id, a
 * friend-request id or a principal id, an id that exists but is not the caller's business gets exactly
 * (status, content type and body, byte for byte) the answer a random id gets. Where the product means to
 * answer differently, the intended difference is asserted instead and named in the test.
 */

const { blobs } = useProbeBlobs("af-enum-");
const { app, db } = useApp({ blobs });

const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";

let txn = 0;
const say = (who: Actor, conv: string, text: string, extra: object = {}) =>
  api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `e${++txn}`, ...extra });
const add = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "POST", `/api/conversations/${conv}/members`, { principalId: target.id });
const remove = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "DELETE", `/api/conversations/${conv}/members/${target.id}`);

async function upload(who: Actor, conv: string, name = "f.bin"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename: name, type: "application/octet-stream", data: Buffer.from(`bytes of ${name}`) }]),
  });
  if (res.statusCode !== 201) throw new Error(`upload ${res.statusCode} ${res.body}`);
  return res.json().id;
}

async function sendFile(who: Actor, conv: string, name: string): Promise<string> {
  const id = await upload(who, conv, name);
  const res = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { attachmentId: id, clientTxn: `e${++txn}` });
  if (res.status !== 201) throw new Error(`sendFile ${res.status}`);
  return id;
}

/** What a client can observe of an answer, with `id` (when the answer echoes it) replaced by a placeholder. */
async function observe(who: Actor, req: InjectOptions, id?: string): Promise<{ status: number; type: string; body: string }> {
  const res = await app.inject({ ...req, headers: { ...(req.headers as object), cookie: who.cookie } });
  const body = id ? res.body.split(id).join("<id>") : res.body;
  return { status: res.statusCode, type: String(res.headers["content-type"] ?? ""), body };
}

/** Asserts that every `existing` id is answered exactly like `random`. Returns that common answer. */
async function indistinguishable(
  who: Actor,
  label: string,
  request: (id: string) => InjectOptions,
  existing: Record<string, string>,
  random = RANDOM,
  echoes = false,
) {
  const reference = await observe(who, request(random), echoes ? random : undefined);
  expect(reference.status, `${label}: reference`).toBeGreaterThanOrEqual(400);
  for (const [kind, id] of Object.entries(existing)) {
    const got = await observe(who, request(id), echoes ? id : undefined);
    expect([label, kind, got]).toEqual([label, kind, reference]);
  }
  return reference;
}

const json = (method: InjectOptions["method"], url: string, payload?: object): InjectOptions => ({
  method,
  url,
  ...(payload === undefined ? {} : { payload }),
});

describe("enumeration: an existing id that is not yours is answered like a random one", () => {
  it("conversation ids: never in it, left it, removed from it, someone else's direct chat, closed — on every route", async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    await befriend(app, alice, eve);
    await befriend(app, eve, carol);
    const { conversationId: direct } = await befriend(app, alice, bob);
    const neverIn = await group(app, alice, "never", [bob, carol]);
    const left = await group(app, alice, "left", [eve, bob]);
    const removed = await group(app, alice, "removed", [eve, bob]);
    const closed = await group(app, alice, "closed", [eve, bob]);
    for (const g of [neverIn, left, removed, direct, closed]) await say(alice, g, "hello secret");
    await sendFile(alice, neverIn, "secret.bin");
    expect((await remove(eve, left, eve)).status).toBe(200);
    expect((await remove(alice, removed, eve)).status).toBe(200);
    for (const who of [eve, alice, bob]) expect((await remove(who, closed, who)).status).toBe(200);

    const existing = { neverIn, left, removed, direct, closed, upperCase: neverIn.toUpperCase() };
    const routes: Array<[string, (id: string) => InjectOptions]> = [
      ["one conversation", (id) => json("GET", `/api/conversations/${id}`)],
      ["rename", (id) => json("PATCH", `/api/conversations/${id}`, { title: "mine" })],
      ["members", (id) => json("GET", `/api/conversations/${id}/members`)],
      ["add member", (id) => json("POST", `/api/conversations/${id}/members`, { principalId: carol.id })],
      ["leave", (id) => json("DELETE", `/api/conversations/${id}/members/${eve.id}`)],
      ["remove someone", (id) => json("DELETE", `/api/conversations/${id}/members/${bob.id}`)],
      ["send", (id) => json("POST", `/api/conversations/${id}/messages`, { text: "hi", clientTxn: "enum-1" })],
      ["send a quote", (id) => json("POST", `/api/conversations/${id}/messages`, { text: "hi", replyToSeq: 1, clientTxn: "enum-2" })],
      ["history", (id) => json("GET", `/api/conversations/${id}/messages`)],
      ["history page", (id) => json("GET", `/api/conversations/${id}/messages?before=3&limit=2`)],
      ["one message", (id) => json("GET", `/api/conversations/${id}/messages/1`)],
      ["search", (id) => json("GET", `/api/conversations/${id}/search?q=secret`)],
      ["read marker", (id) => json("POST", `/api/conversations/${id}/read`, { seq: 1 })],
      [
        "upload",
        (id) => ({
          method: "POST",
          url: `/api/conversations/${id}/attachments`,
          headers: { "content-type": MULTIPART },
          payload: multipart([{ name: "file", filename: "x.bin", data: "x" }]),
        }),
      ],
    ];
    for (const [label, request] of routes) {
      const answer = await indistinguishable(eve, label, request, existing);
      expect([label, answer.status, answer.body]).toEqual([label, 404, '{"error":"not_found"}']);
    }

    // Catch-up echoes the id it was given: the same answer once the id itself is taken out.
    for (const [kind, id] of Object.entries(existing)) {
      const got = await observe(eve, json("POST", "/api/sync/catchup", { positions: { [id]: 0 } }), id.toLowerCase());
      const reference = await observe(eve, json("POST", "/api/sync/catchup", { positions: { [RANDOM]: 0 } }), RANDOM);
      expect([kind, got]).toEqual([kind, reference]);
      expect(JSON.parse(reference.body)).toEqual({ messages: [], gone: ["<id>"], more: false });
    }
    // And none of them appears anywhere in /api/sync or a global search.
    const sync = (await api(app, eve, "GET", "/api/sync")).json;
    expect(JSON.stringify(sync)).not.toMatch(new RegExp([neverIn, left, removed, direct, closed].join("|")));
    expect((await api(app, eve, "GET", "/api/search?q=secret")).json).toEqual({ messages: [], nextBefore: null });
    // Nothing she sent got in anywhere (her own leave notices aside).
    const hers = await db.query("select count(*) n from messages where sender_id = $1 and kind <> 'system'", [eve.id]);
    expect(Number(hers.rows[0].n)).toBe(0);
  });

  it("message seqs: a seq from before you joined is answered like one that does not exist", async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    await befriend(app, alice, eve);
    const g = await group(app, alice, "late", [bob, carol]);
    for (let i = 0; i < 4; i++) await say(alice, g, `before you ${i}`);
    expect((await add(alice, g, eve)).status).toBe(201);
    const joinedAt = Number((await db.query("select seq from conversations where id = $1", [g])).rows[0].seq);
    expect(joinedAt).toBeGreaterThan(3);

    // The path seq, and a quote's seq in a send.
    const one = (seq: string) => json("GET", `/api/conversations/${g}/messages/${seq}`);
    const answer = await indistinguishable(eve, "one message", one, { first: "1", preJoin: "3", lastPreJoin: String(joinedAt - 1) }, "999999");
    expect(answer.status).toBe(404);
    const quote = (seq: string) => json("POST", `/api/conversations/${g}/messages`, { text: "re", replyToSeq: Number(seq), clientTxn: `q${seq}` });
    const refused = await indistinguishable(eve, "quote", quote, { preJoin: "2", lastPreJoin: String(joinedAt - 1) }, "999999");
    expect(refused).toMatchObject({ status: 400, body: '{"error":"invalid_request"}' });
    // Positive control: the join notice is hers.
    expect((await api(app, eve, "GET", `/api/conversations/${g}/messages/${joinedAt}`)).status).toBe(200);
  });

  it("attachment ids: download and send treat other people's, unsent, pre-join and left-behind attachments like a random id", async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    await befriend(app, alice, eve);
    const elsewhere = await group(app, alice, "elsewhere", [bob, carol]);
    const sentElsewhere = await sendFile(alice, elsewhere, "elsewhere.bin");
    const unsentElsewhere = await upload(alice, elsewhere, "unsent-elsewhere.bin");
    const shared = await group(app, alice, "shared", [bob, carol]);
    const preJoin = await sendFile(alice, shared, "pre.bin");
    expect((await add(alice, shared, eve)).status).toBe(201);
    const othersUnsent = await upload(alice, shared, "alice-unsent.bin");
    const ownUnsent = await upload(eve, shared, "eve-unsent.bin");
    const formerHome = await group(app, alice, "former", [eve, bob]);
    const leftBehind = await sendFile(alice, formerHome, "left-behind.bin");
    expect((await remove(eve, formerHome, eve)).status).toBe(200);

    const download = (id: string) => json("GET", `/api/attachments/${id}`);
    const answer = await indistinguishable(eve, "download", download, {
      sentElsewhere,
      unsentElsewhere,
      preJoin,
      othersUnsent,
      ownUnsent,
      leftBehind,
      upperCase: sentElsewhere.toUpperCase(),
    });
    expect(answer).toMatchObject({ status: 404, body: '{"error":"not_found"}' });

    const send = (id: string) => json("POST", `/api/conversations/${shared}/messages`, { attachmentId: id, clientTxn: `s-${id.slice(0, 8)}` });
    const refused = await indistinguishable(eve, "send", send, { sentElsewhere, unsentElsewhere, preJoin, othersUnsent, leftBehind });
    expect(refused).toMatchObject({ status: 400, body: '{"error":"invalid_request"}' });
    // Positive control: her own upload, in this conversation, sends.
    expect((await app.inject({ ...send(ownUnsent), headers: { cookie: eve.cookie } })).statusCode).toBe(201);
  });

  it("friend-request ids: someone else's request, or your own in the wrong role, is answered like a random id", async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const othersPending = (await api(app, alice, "POST", "/api/friend-requests", { handle: bob.handle })).json.id;
    const othersAccepted = (await api(app, carol, "POST", "/api/friend-requests", { handle: bob.handle })).json.id;
    expect((await api(app, bob, "POST", `/api/friend-requests/${othersAccepted}/accept`)).status).toBe(200);
    const mineSent = (await api(app, eve, "POST", "/api/friend-requests", { handle: carol.handle })).json.id;
    const mineReceived = (await api(app, alice, "POST", "/api/friend-requests", { handle: eve.handle })).json.id;

    const others = { othersPending, othersAccepted, upperCase: othersPending.toUpperCase() };
    for (const route of ["", "/accept", "/reject", "/withdraw"]) {
      const request = (id: string) => json(route ? "POST" : "GET", `/api/friend-requests/${id}${route}`);
      const answer = await indistinguishable(eve, `request${route}`, request, others);
      expect(answer).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    }
    // Your own request, in the role you do not have: the sender cannot accept or reject, the recipient cannot withdraw.
    for (const route of ["/accept", "/reject"]) {
      await indistinguishable(eve, `own sent${route}`, (id) => json("POST", `/api/friend-requests/${id}${route}`), { mineSent });
    }
    await indistinguishable(eve, "own received/withdraw", (id) => json("POST", `/api/friend-requests/${id}/withdraw`), { mineReceived });
    // Positive control: both are hers to read.
    expect((await api(app, eve, "GET", `/api/friend-requests/${mineSent}`)).status).toBe(200);
    expect((await api(app, eve, "GET", `/api/friend-requests/${mineReceived}`)).status).toBe(200);
  });

  it("principal ids: unfriend, unblock, adding to a group or a new group, and removing from a group treat a stranger like a random id", async () => {
    const [eve, friend1, friend2, stranger] = [await signUp(app, "eve"), await signUp(app, "friend1"), await signUp(app, "friend2"), await signUp(app, "stranger")];
    await befriend(app, eve, friend1);
    await befriend(app, eve, friend2);
    const g = await group(app, eve, "mine", [friend1, friend2]);
    const exStrangerFriend = await signUp(app, "exfriend");
    await befriend(app, eve, exStrangerFriend);
    expect((await api(app, eve, "DELETE", `/api/friends/${exStrangerFriend.id}`)).status).toBe(200);
    const strangers = { stranger: stranger.id, exFriend: exStrangerFriend.id, upperCase: stranger.id.toUpperCase() };

    const unfriend = await indistinguishable(eve, "unfriend", (id) => json("DELETE", `/api/friends/${id}`), strangers);
    expect(unfriend).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    const addToGroup = await indistinguishable(eve, "add", (id) => json("POST", `/api/conversations/${g}/members`, { principalId: id }), strangers);
    expect(addToGroup).toMatchObject({ status: 403, body: '{"error":"forbidden"}' });
    const newGroup = await indistinguishable(eve, "new group", (id) => json("POST", "/api/conversations", { title: "t", memberIds: [friend1.id, id] }), strangers);
    expect(newGroup).toMatchObject({ status: 403, body: '{"error":"forbidden"}' });
    const removeFromGroup = await indistinguishable(eve, "remove", (id) => json("DELETE", `/api/conversations/${g}/members/${id}`), strangers);
    expect(removeFromGroup).toMatchObject({ status: 404, body: '{"error":"not_found"}' });

    // Unblocking someone you never blocked is a no-op, existing or not: the same 200.
    const unblock = async (id: string) => observe(eve, json("DELETE", `/api/blocks/${id}`));
    expect(await unblock(stranger.id)).toEqual(await unblock(RANDOM));
    expect((await unblock(RANDOM)).status).toBe(200);
  });

  it("intended differences: any existing principal can be blocked and has an avatar; a random id is 404", async () => {

    // Principal ids are learnt from handles (lookup, rate-limited) and from shared conversations; ids
    // themselves are random UUIDs, so answering by existence here reveals nothing guessable.
    const [eve, stranger] = [await signUp(app, "eve"), await signUp(app, "stranger")];
    const avatar = (id: string) => observe(eve, json("GET", `/api/principals/${id}/avatar`));
    expect((await avatar(stranger.id)).status).toBe(200);
    expect(await avatar(RANDOM)).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    const block = (id: string) => observe(eve, json("PUT", `/api/blocks/${id}`));
    expect((await block(stranger.id)).status).toBe(200);
    expect(await block(RANDOM)).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
  });
});

describe("enumeration by timing (coarse)", () => {
  // Coarse on purpose: medians of interleaved calls, compared within a factor of 2. Before the catch-up
  // fix the busy conversation's median was ~2.8x the random id's (16 ms vs 6 ms with 30 000 messages).
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
  const ratio = (a: number, b: number) => Math.max(a, b) / Math.min(a, b);

  /** Times `a` and `b` alternately (so load drift hits both alike) and returns both medians in ms. */
  async function race(a: () => Promise<unknown>, b: () => Promise<unknown>, rounds = 25): Promise<[number, number]> {
    const time = async (f: () => Promise<unknown>) => {
      const t0 = performance.now();
      await f();
      return performance.now() - t0;
    };
    for (let i = 0; i < 3; i++) await Promise.all([time(a), time(b)]); // warm up both paths
    const ta: number[] = [];
    const tb: number[] = [];
    for (let i = 0; i < rounds; i++) {
      ta.push(await time(a));
      tb.push(await time(b));
    }
    return [median(ta), median(tb)];
  }

  /** `n` text messages from `sender`, written straight into the table (setup only; nothing reads them through the API). */
  async function seed(conversationId: string, sender: string, n: number): Promise<void> {
    await db.query(
      `with c as (select seq from conversations where id = $1 for update)
       insert into messages (conversation_id, seq, sender_id, kind, body)
       select $1, c.seq + g, $2, 'text', jsonb_build_object('text', 'filler ' || g) from c, generate_series(1, $3::int) g`,
      [conversationId, sender, n],
    );
    await db.query("update conversations set seq = seq + $2 where id = $1", [conversationId, n]);
  }

  it("catch-up: a busy conversation you are not in costs about what a random id costs", { timeout: 60_000 }, async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const busy = await group(app, alice, "busy", [bob, carol]);
    await seed(busy, alice.id, 30_000);
    const catchUp = (id: string) => async () => {
      const res = await api(app, eve, "POST", "/api/sync/catchup", { positions: { [id]: 0 } });
      expect(res.json).toEqual({ messages: [], gone: [id], more: false });
    };
    const [existing, random] = await race(catchUp(busy), catchUp(RANDOM));
    expect(ratio(existing, random), `medians: existing ${existing.toFixed(2)} ms, random ${random.toFixed(2)} ms`).toBeLessThan(2);
  });

  it("download: an attachment you may not see costs about what a random id costs", { timeout: 60_000 }, async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const elsewhere = await group(app, alice, "elsewhere", [bob, carol]);
    await seed(elsewhere, alice.id, 30_000);
    const hidden = await sendFile(alice, elsewhere, "hidden.bin");
    const download = (id: string) => async () => {
      const res = await app.inject({ method: "GET", url: `/api/attachments/${id}`, headers: { cookie: eve.cookie } });
      expect(res.statusCode).toBe(404);
    };
    const [existing, random] = await race(download(hidden), download(RANDOM));
    expect(ratio(existing, random), `medians: existing ${existing.toFixed(2)} ms, random ${random.toFixed(2)} ms`).toBeLessThan(2);
  });
});
