import { afterEach, describe, expect, it } from "vitest";
import { createWhisper, expireWhispers, type Whisper } from "../src/whispers/store.ts";
import { toWireWhisper } from "../src/whispers/wire.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type TestSocket } from "./helpers/ws.ts";

/**
 * Nothing about a whisper reaches anyone but its owner (design rules 16 and 19; review focus 5): a fellow member's socket and
 * every read route they have, polled before, during and after a whisper's whole life (created, answered, expired), answer
 * byte for byte the same — no frame, no key, no count, no change of `lastSeq`, unread, catch-up or search —; the three
 * whisper routes answer them and a stranger exactly as an id that is none; and the Agent's model is never shown it.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";
const CANARY = "WHISPER-zq9 只给主人看的悄悄话";
/** Keys only a whisper's owner ever receives (also in agents-co-members.test.ts and proactive-decide.test.ts). */
const WHISPER_KEYS = ["whisper", "whispers", "afterSeq"];

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `wp${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

/** olive and her Agent in her group with mia (no Agent) and ned (who has one there too); sam is in no conversation with them. */
async function world() {
  const [owner, mia, ned, sam] = [await signUp(app, "olive"), await signUp(app, "mia"), await signUp(app, "ned"), await signUp(app, "sam")];
  const agent = await mustCreateAgent(app, owner, { handle: "olive_bot", name: "Olive Bot", model: FAST, persona: "简短地回答。" });
  const nedsAgent = await mustCreateAgent(app, ned, { model: FAST });
  const g = await group(app, owner, "team", [mia, ned]);
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  expect((await api(app, ned, "POST", `/api/conversations/${g}/members`, { principalId: nedsAgent.id })).status).toBe(201);
  await say(mia, g, "大家好");
  await say(owner, g, "你好");
  return { owner, mia, ned, sam, agent: agent as { id: string; conversationId: string; handle: string }, g };
}
type World = Awaited<ReturnType<typeof world>>;

async function whisper(w: World, conversationId = w.g): Promise<Whisper> {
  const made = await db.tx((t) =>
    createWhisper(t, { conversationId, ownerId: w.owner.id, agentId: w.agent.id, kind: "found_elsewhere", body: { text: CANARY, actions: ["tell", "dismiss"], detail: { seq: 1 } } }),
  );
  if (!made) throw new Error("whisper refused");
  app.realtime.pushWhisper(made.ownerId, toWireWhisper(made));
  return made;
}

/** Everything `who` can read about the group (and the whisper id `id`, when there is one), by label. */
async function reads(w: World, who: Actor, id: string): Promise<Array<[string, number, unknown]>> {
  const seq = Number((await db.query("select seq from conversations where id = $1", [w.g])).rows[0].seq);
  const out: Array<[string, number, unknown]> = [];
  const read = async (label: string, method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await api(app, who, method, url, body);
    out.push([label, res.status, res.json]);
  };
  await read("sync", "GET", "/api/sync");
  await read("one conversation", "GET", `/api/conversations/${w.g}`);
  await read("members", "GET", `/api/conversations/${w.g}/members`);
  await read("history", "GET", `/api/conversations/${w.g}/messages`);
  await read("history page", "GET", `/api/conversations/${w.g}/messages?limit=1&before=${seq + 1}`);
  await read("the last message", "GET", `/api/conversations/${w.g}/messages/${seq}`);
  await read("search", "GET", `/api/conversations/${w.g}/search?q=${encodeURIComponent("WHISPER-zq9")}`);
  await read("search 2", "GET", `/api/conversations/${w.g}/search?q=${encodeURIComponent("悄悄话")}`);
  await read("global search", "GET", `/api/search?q=${encodeURIComponent("WHISPER-zq9")}`);
  await read("catch-up", "POST", "/api/sync/catchup", { positions: { [w.g]: 0 } });
  await read("catch-up at the end", "POST", "/api/sync/catchup", { positions: { [w.g]: seq } });
  await read("group replies", "GET", `/api/conversations/${w.g}/runs`);
  await read("whispers", "GET", `/api/conversations/${w.g}/whispers`);
  await read("whispers page", "GET", `/api/conversations/${w.g}/whispers?before=${seq + 1}&limit=5`);
  await read("accept", "POST", `/api/whispers/${id}/accept`);
  await read("decline", "POST", `/api/whispers/${id}/decline`);
  return out;
}

/** Nothing of a whisper in `bodies`: no key of one, its text or its id. */
function nothingOf(bodies: Array<[string, unknown]>, ids: string[]): void {
  expect(bodies.length).toBeGreaterThan(0);
  for (const [label, body] of bodies) {
    const keys = keysOf(body);
    expect([label, WHISPER_KEYS.filter((k) => keys.has(k))]).toEqual([label, []]);
    const text = JSON.stringify(body);
    for (const value of ["WHISPER-zq9", ...ids]) expect([label, value, text.includes(value)]).toEqual([label, value, false]);
  }
}

describe("a whisper's whole life, as everyone but its owner sees it", () => {
  it("a fellow member, the owner of another Agent there and a stranger: every read route the same before, during and after; no frame; the owner meanwhile gets everything", async () => {
    const w = await world();
    const [miaSocket, nedSocket, samSocket, ownerSocket] = [await connect(app, w.mia), await connect(app, w.ned), await connect(app, w.sam), await connect(app, w.owner)];
    const others: Array<[string, Actor, TestSocket]> = [
      ["mia", w.mia, miaSocket],
      ["ned", w.ned, nedSocket],
      ["sam", w.sam, samSocket],
    ];
    const ownerBefore = (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json;
    // What they read before any whisper exists — the ids they ask for are a random one's.
    const before = new Map<string, Array<[string, number, unknown]>>();
    for (const [name, who] of others) before.set(name, await reads(w, who, RANDOM));
    // Their whisper routes answer as for an id that is none (ned, who has an Agent there, reads an empty list of his own).
    for (const [name] of others) {
      for (const [label, status, body] of before.get(name)!) {
        if (label.startsWith("whispers") && name === "ned") expect([name, label, status, body]).toEqual([name, label, 200, { whispers: [], nextBefore: null }]);
        else if (label.startsWith("whispers") || label === "accept" || label === "decline") expect([name, label, status, body]).toEqual([name, label, 404, { error: "not_found" }]);
      }
    }

    const ids: string[] = [];
    const phase = async (what: string, id: string) => {
      for (const [name, who] of others) {
        const now = await reads(w, who, id);
        // The same answers, byte for byte, as before the whisper existed: its id is answered as a random one's.
        expect([what, name, now]).toEqual([what, name, before.get(name)]);
      }
      const owner = (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json;
      expect([what, owner.lastSeq, owner.unread, owner.readSeq]).toEqual([what, ownerBefore.lastSeq, ownerBefore.unread, ownerBefore.readSeq]);
    };

    // Created: the owner is pushed it.
    const a = await whisper(w);
    ids.push(a.id);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === a.id);
    expect((await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json.whispers).toBe(1);
    await phase("open", a.id);
    // Answered.
    expect((await api(app, w.owner, "POST", `/api/whispers/${a.id}/accept`)).status).toBe(200);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === a.id && e.whisper.status === "accepted");
    await phase("accepted", a.id);
    const b = await whisper(w);
    ids.push(b.id);
    expect((await api(app, w.owner, "POST", `/api/whispers/${b.id}/decline`)).status).toBe(200);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === b.id && e.whisper.status === "declined");
    await phase("declined", b.id);
    // Expired by the sweep, pushed to the owner as the app does.
    const c = await whisper(w);
    ids.push(c.id);
    await db.query("update whispers set created_at = now() - interval '8 days' where id = $1", [c.id]);
    for (const x of await expireWhispers(db)) app.realtime.pushWhisper(x.ownerId, toWireWhisper(x));
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === c.id && e.whisper.status === "expired");
    await phase("expired", c.id);
    // One open in the Agent's own conversation too.
    const d = await whisper(w, w.agent.conversationId);
    ids.push(d.id);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === d.id);
    await phase("another open", d.id);

    // The owner's pushes went through the group's queue after everything the others could have been sent: none was.
    for (const [name, , socket] of others) expect([name, socket.events]).toEqual([name, []]);
    // Positive control: the owner's own reads carry them.
    const mine = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(mine.whispers.map((x: any) => x.id).sort()).toEqual([...ids].sort());
    expect(mine.whispers.find((x: any) => x.id === d.id).text).toBe(CANARY);

    // Search finds it for nobody, the owner included; unread counts nothing of it.
    for (const who of [w.owner, w.mia]) {
      expect((await api(app, who, "GET", `/api/search?q=${encodeURIComponent("WHISPER-zq9")}`)).json.messages).toEqual([]);
      expect((await api(app, who, "GET", `/api/conversations/${w.g}/search?q=${encodeURIComponent("悄悄话")}`)).json.messages).toEqual([]);
    }
  });

  it("its Agent taken out of the group: the others see the leaving, and nothing of the whisper it expires", async () => {
    const w = await world();
    const miaSocket = await connect(app, w.mia);
    const ownerSocket = await connect(app, w.owner);
    const a = await whisper(w);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === a.id);
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.agent.id}`)).status).toBe(200);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.status === "expired");
    await miaSocket.waitFor((e) => e.type === "message" && e.message.system?.event === "member_removed");
    const bodies: Array<[string, unknown]> = miaSocket.events.map((e, i) => [`frame ${i}`, e]);
    for (const [label, , body] of await reads(w, w.mia, a.id)) bodies.push([label, body]);
    nothingOf(bodies, [a.id]);
  });

  it("the Agent's model is never shown a whisper: not in a group, not in its own conversation", async () => {
    const w = await world();
    await whisper(w);
    await whisper(w, w.agent.conversationId);
    gateway.reply("好的");
    await say(w.owner, w.g, `@${w.agent.handle} 在吗`);
    expect(await app.agentWorker.runOnce()).toBe(true);
    gateway.reply("在的");
    await say(w.owner, w.agent.conversationId, "你好");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls).toHaveLength(2);
    for (const call of gateway.calls) {
      const shown = JSON.stringify({ system: call.system, messages: call.messages });
      expect(shown).toContain(call === gateway.calls[0] ? "在吗" : "你好");
      expect(shown).not.toContain("WHISPER-zq9");
    }
  });
});
