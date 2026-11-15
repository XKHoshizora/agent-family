import { describe, expect, it } from "vitest";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Message history, single messages and both searches carry a `principals` map of everyone their messages
 * name (senders, visible quotes' senders, the people in system notices), so a client that never saw a
 * departed member can still show who spoke. Only what the caller can see is named.
 */

const { app } = useApp();

let txn = 0;
const say = (who: Actor, conv: string, text: string, extra: object = {}) =>
  api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `p${++txn}`, ...extra });
const history = (who: Actor, conv: string, query = "") => api(app, who, "GET", `/api/conversations/${conv}/messages${query}`);
const leave = (who: Actor, conv: string) => api(app, who, "DELETE", `/api/conversations/${conv}/members/${who.id}`);
const publicShape = (who: Actor, displayName: string) => ({ id: who.id, handle: who.handle, displayName, kind: "human" });

describe("principals of message reads", () => {
  /** alice's group with bob and carol; bob speaks, then leaves. */
  async function withDepartedMember() {
    const [alice, bob, carol] = [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const conv = await group(app, alice, "trio", [bob, carol]);
    const fromBob = (await say(bob, conv, "needle from bob")).json.message.seq as number;
    expect((await leave(bob, conv)).status).toBe(200);
    return { alice, bob, carol, conv, fromBob };
  }

  it("history names a member who left before the client ever synced, in the same shape as /api/sync", async () => {
    const { alice, bob, carol, conv } = await withDepartedMember();
    const page = (await history(alice, conv)).json;
    expect(page.messages.some((m: any) => m.senderId === bob.id)).toBe(true);
    expect(page.principals[bob.id]).toEqual(publicShape(bob, "bob"));
    const sync = (await api(app, alice, "GET", "/api/sync")).json;
    for (const p of Object.values<any>(page.principals)) expect(sync.principals.find((s: any) => s.id === p.id) ?? p).toEqual(p);
    // Everyone the page mentions (sender, group_created's members, who left) is there, nobody else.
    expect(Object.keys(page.principals).sort()).toEqual([alice.id, bob.id, carol.id].sort());
    for (const [key, p] of Object.entries<any>(page.principals)) expect(p.id).toBe(key);
  });

  it("is limited to the page: a short page names only its own senders", async () => {
    const { alice, bob, carol, conv } = await withDepartedMember();
    await say(carol, conv, "last word");
    const newest = (await history(alice, conv, "?limit=1")).json;
    expect(newest.messages.map((m: any) => m.text)).toEqual(["last word"]);
    expect(Object.keys(newest.principals)).toEqual([carol.id]);
    expect(newest.principals[carol.id]).toEqual(publicShape(carol, "carol"));
    expect(newest.principals[bob.id]).toBeUndefined();
    // An empty history has an empty map.
    const fresh = await group(app, alice, "fresh", [carol, await signUp(app, "dave")]);
    const empty = (await history(alice, fresh, "?before=1")).json;
    expect(empty).toMatchObject({ messages: [], principals: {} });
  });

  it("names the sender of a visible quote, and of a single message", async () => {
    const { alice, bob, carol, conv, fromBob } = await withDepartedMember();
    const quoting = (await say(alice, conv, "agreed", { replyToSeq: fromBob })).json.message.seq as number;
    const page = (await history(carol, conv, "?limit=1")).json;
    expect(page.messages[0].replyTo).toMatchObject({ visible: true, senderId: bob.id });
    expect(Object.keys(page.principals).sort()).toEqual([alice.id, bob.id].sort());

    const single = (await api(app, carol, "GET", `/api/conversations/${conv}/messages/${quoting}`)).json;
    expect(single.message.seq).toBe(quoting);
    expect(Object.keys(single.principals).sort()).toEqual([alice.id, bob.id].sort());
    const plain = (await api(app, carol, "GET", `/api/conversations/${conv}/messages/${fromBob}`)).json;
    expect(plain.principals).toEqual({ [bob.id]: publicShape(bob, "bob") });
  });

  it("names nobody the caller cannot see: not who spoke before they joined, not a hidden quote's sender", async () => {
    const { alice, bob, conv, fromBob } = await withDepartedMember();
    const dave = await signUp(app, "dave");
    await befriend(app, alice, dave);
    expect((await api(app, alice, "POST", `/api/conversations/${conv}/members`, { principalId: dave.id })).status).toBe(201);
    const reply = (await say(alice, conv, "welcome", { replyToSeq: fromBob })).json.message.seq as number;

    const page = (await history(dave, conv)).json;
    const welcome = page.messages.find((m: any) => m.seq === reply);
    expect(welcome.replyTo).toEqual({ seq: fromBob, visible: false });
    expect(page.messages.some((m: any) => m.senderId === bob.id)).toBe(false);
    expect(page.principals[alice.id]).toEqual(publicShape(alice, "alice"));
    expect(page.principals[bob.id]).toBeUndefined();

    // The single message and the searches behave the same for dave.
    expect((await api(app, dave, "GET", `/api/conversations/${conv}/messages/${reply}`)).json.principals[bob.id]).toBeUndefined();
    expect((await api(app, dave, "GET", `/api/conversations/${conv}/messages/${fromBob}`)).status).toBe(404);
    const found = (await api(app, dave, "GET", `/api/search?q=needle`)).json;
    expect(found).toMatchObject({ messages: [], principals: {} });
  });

  it("both searches name the author of a hit, a departed member included", async () => {
    const { alice, bob, conv } = await withDepartedMember();
    const inConversation = (await api(app, alice, "GET", `/api/conversations/${conv}/search?q=needle`)).json;
    expect(inConversation.messages.map((m: any) => m.senderId)).toEqual([bob.id]);
    expect(inConversation.principals).toEqual({ [bob.id]: publicShape(bob, "bob") });

    const everywhere = (await api(app, alice, "GET", "/api/search?q=needle")).json;
    expect(everywhere.messages.map((m: any) => m.senderId)).toEqual([bob.id]);
    expect(everywhere.principals).toEqual({ [bob.id]: publicShape(bob, "bob") });

    const none = (await api(app, alice, "GET", "/api/search?q=nothing-matches-this")).json;
    expect(none).toMatchObject({ messages: [], principals: {} });
  });

  it("still answers 404 for a conversation the caller is not in, and only adds a key to the old shapes", async () => {
    const { alice, conv } = await withDepartedMember();
    const outsider = await signUp(app, "erin");
    expect(await history(outsider, conv)).toEqual({ status: 404, json: { error: "not_found" } });
    const page = (await history(alice, conv)).json;
    expect(Object.keys(page).sort()).toEqual(["messages", "nextBefore", "principals"]);
  });
});
