import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appellationEntriesOf } from "../src/agents/store.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * How an Agent addresses its owner (`ownerAppellation`) and specific other people or Agents (`appellations`): the
 * owner's settings, in the owner's view of the Agent and nowhere else. A target is a person or an Agent that is neither
 * this Agent nor its owner and is the owner's friend or a current member of a group the Agent is in; anything else
 * answers as an id that does not exist. The membership routes do not take Agents yet, so these tests seat an Agent in a
 * group directly in the database.
 */

const { app, db } = useApp({ env: SITE_ENV, agentWorker: false });

afterEach(() => {
  vi.restoreAllMocks();
});

const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";
/** Text no appellation may hold besides a line break: NUL, another control character, a lone surrogate (made from code points). */
const UNSTORABLE = [0, 7, 9, 0xd800, 0xdc00].flatMap((cp) => [String.fromCharCode(cp), `a${String.fromCharCode(cp)}b`]);

const put = (who: Actor, agentId: string, target: string, appellation: unknown) =>
  api(app, who, "PUT", `/api/agents/${agentId}/appellations/${target}`, { appellation });
const remove = (who: Actor, agentId: string, target: string) => api(app, who, "DELETE", `/api/agents/${agentId}/appellations/${target}`);
const view = async (who: Actor, agentId: string) => (await api(app, who, "GET", `/api/agents/${agentId}`)).json;
const targetsOf = (v: { appellations: Array<{ principalId: string }> }) => v.appellations.map((e) => e.principalId);

/** The rows of `agent_appellations` of `agentId`, by target. */
const stored = async (agentId: string): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await db.query<{ principal_id: string; appellation: string }>("select principal_id, appellation from agent_appellations where agent_id = $1", [agentId])).rows.map((r) => [
      r.principal_id,
      r.appellation,
    ]),
  );

/** Puts principal `id` into conversation `conv` from its current seq on. */
const seat = (conv: string, id: string) =>
  db.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) select id, $2, 'speaker', seq from conversations where id = $1`, [conv, id]);

/** An owner and their Agent seated in a group made by `eve`, with `gus` (her friend, not the owner's); `mia` is the owner's friend only. */
async function world() {
  const [owner, mia, gus, eve] = [await signUp(app, "own"), await signUp(app, "mia"), await signUp(app, "gus"), await signUp(app, "eve")];
  const agent = await mustCreateAgent(app, owner);
  await befriend(app, owner, mia);
  const g = await group(app, eve, "team", [gus, owner]);
  await seat(g, agent.id);
  return { owner, mia, gus, eve, agent, g };
}

describe("ownerAppellation", () => {
  it("is set at creation and by edit, trimmed, and cleared with null; the owner's view carries it", async () => {
    const owner = await signUp(app, "own");
    const created = await mustCreateAgent(app, owner, { ownerAppellation: "  老板 " });
    expect(created).toMatchObject({ ownerAppellation: "老板", appellations: [] });
    expect((await mustCreateAgent(app, owner)).ownerAppellation).toBeNull();

    expect((await api(app, owner, "PATCH", `/api/agents/${created.id}`, { ownerAppellation: "主人大人" })).json.ownerAppellation).toBe("主人大人");
    // An edit of something else leaves it.
    expect((await api(app, owner, "PATCH", `/api/agents/${created.id}`, { intro: "x" })).json.ownerAppellation).toBe("主人大人");
    expect((await view(owner, created.id)).ownerAppellation).toBe("主人大人");
    const listed = (await api(app, owner, "GET", "/api/agents")).json.agents.find((a: { id: string }) => a.id === created.id);
    expect(listed.ownerAppellation).toBe("主人大人");
    expect((await api(app, owner, "PATCH", `/api/agents/${created.id}`, { ownerAppellation: null })).json.ownerAppellation).toBeNull();
    expect((await view(owner, created.id)).ownerAppellation).toBeNull();
  });

  it("is 400 when empty, only spaces, over 20 characters, across lines, holding NUL, another control character or a lone surrogate, or not text — in create and in edit", async () => {
    const owner = await signUp(app, "own");
    const agent = await mustCreateAgent(app, owner);
    for (const value of ["", "   ", "一".repeat(21), "a\nb", "a\rb", "a\u2028b", "a\u0085b", "a\u000bb", ...UNSTORABLE, 5, {}]) {
      expect([value, (await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { ownerAppellation: value })).status]).toEqual([value, 400]);
      const body = { handle: `bad_${randomUUID().slice(0, 8)}`, name: "B", ownerAppellation: value };
      expect([value, (await api(app, owner, "POST", "/api/agents", body)).status]).toEqual([value, 400]);
    }
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { ownerAppellation: "一".repeat(20) })).status).toBe(200);
    expect((await view(owner, agent.id)).ownerAppellation).toBe("一".repeat(20));
  });
});

describe("PUT and DELETE /api/agents/:id/appellations/:principalId", () => {
  it("sets, replaces and removes; the view lists them by handle with the target's current handle and name", async () => {
    const w = await world();
    const other = await mustCreateAgent(app, w.eve, { name: "Eve的Bot" });
    await seat(w.g, other.id);

    const first = await put(w.owner, w.agent.id, w.mia.id, "  米亚 ");
    expect(first.status).toBe(200);
    expect(first.json.appellations).toEqual([{ principalId: w.mia.id, kind: "human", handle: w.mia.handle, name: "mia", appellation: "米亚" }]);
    await put(w.owner, w.agent.id, other.id, "小机器人");
    const both = (await put(w.owner, w.agent.id, w.mia.id, "亚亚")).json;
    expect(both.appellations).toEqual(
      [
        { principalId: w.mia.id, kind: "human", handle: w.mia.handle, name: "mia", appellation: "亚亚" },
        { principalId: other.id, kind: "agent", handle: other.handle, name: "Eve的Bot", appellation: "小机器人" },
      ].sort((a, b) => (a.handle < b.handle ? -1 : 1)),
    );
    expect((await view(w.owner, w.agent.id)).appellations).toEqual(both.appellations);
    const listed = (await api(app, w.owner, "GET", "/api/agents")).json.agents.find((a: { id: string }) => a.id === w.agent.id);
    expect(listed.appellations).toEqual(both.appellations);

    // The target's name changes: the view shows the current one.
    await db.query("update principals set display_name = '新名字' where id = $1", [w.mia.id]);
    const renamed = (await view(w.owner, w.agent.id)).appellations.find((e: { principalId: string }) => e.principalId === w.mia.id);
    expect(renamed.name).toBe("新名字");

    const removed = await remove(w.owner, w.agent.id, w.mia.id);
    expect(removed.status).toBe(200);
    expect(targetsOf(removed.json)).toEqual([other.id]);
    // Taking back what is not there is 404, for a target it never named as for an id that is nobody's or no id at all.
    for (const target of [w.mia.id, RANDOM, RANDOM.toUpperCase(), "00000000-0000-0000-0000-000000000000", "not-an-id"]) {
      expect([target, await remove(w.owner, w.agent.id, target)]).toEqual([target, { status: 404, json: { error: "not_found" } }]);
    }
    expect(targetsOf(await view(w.owner, w.agent.id))).toEqual([other.id]);
  });

  it("accepts a friend in no shared group, a group member who is no friend, and someone else's Agent in the group", async () => {
    const w = await world();
    const shared = await db.query("select 1 from memberships m join memberships a using (conversation_id) where m.principal_id = $1 and a.principal_id = $2", [w.mia.id, w.agent.id]);
    expect(shared.rowCount).toBe(0);
    expect((await put(w.owner, w.agent.id, w.mia.id, "米亚")).status).toBe(200);
    expect((await api(app, w.owner, "GET", "/api/social")).json.friends.map((f: { id: string }) => f.id)).not.toContain(w.gus.id);
    expect((await put(w.owner, w.agent.id, w.gus.id, "古斯")).status).toBe(200);
    const theirs = await mustCreateAgent(app, w.eve);
    await seat(w.g, theirs.id);
    expect((await put(w.owner, w.agent.id, theirs.id, "伊芙的")).status).toBe(200);
    expect(targetsOf(await view(w.owner, w.agent.id))).toHaveLength(3);
  });

  it("is 400 for text that is empty, only spaces, over 20 characters, across lines, holding NUL, another control character or a lone surrogate, or not text; nothing is stored", async () => {
    const w = await world();
    for (const value of ["", "  ", "一".repeat(21), "a\nb", "a\u2029b", ...UNSTORABLE, 7, null, undefined]) {
      expect([value, (await put(w.owner, w.agent.id, w.mia.id, value)).status]).toEqual([value, 400]);
    }
    expect((await api(app, w.owner, "PUT", `/api/agents/${w.agent.id}/appellations/${w.mia.id}`, { appellation: "好", extra: 1 })).status).toBe(400);
    expect((await view(w.owner, w.agent.id)).appellations).toEqual([]);
    expect((await put(w.owner, w.agent.id, w.mia.id, "一".repeat(20))).status).toBe(200);
  });

  it("answers 404 not_found, byte for byte as an id that does not exist, for every target and Agent it must not reveal", async () => {
    const w = await world();
    const stranger = await signUp(app, "stranger");
    const alone = await signUp(app, "alone"); // neither a friend of the owner nor in a group with the Agent
    const outsideAgent = await mustCreateAgent(app, stranger); // an Agent in no group of this one
    // The Agent was in a group with the stranger, and has left it.
    const g2 = await group(app, await signUp(app, "elsewhere"), "other", [stranger, await signUp(app, "third")]);
    await seat(g2, w.agent.id);
    await db.query("update memberships set left_seq = joined_seq + 1 where conversation_id = $1 and principal_id = $2", [g2, w.agent.id]);

    const raw = async (method: "PUT" | "DELETE", who: Actor, agentId: string, target: string) => {
      const res = await app.inject({
        method,
        url: `/api/agents/${agentId}/appellations/${target}`,
        headers: { cookie: who.cookie },
        ...(method === "PUT" ? { payload: { appellation: "称呼" } } : {}),
      });
      return { status: res.statusCode, type: String(res.headers["content-type"] ?? ""), body: res.body };
    };
    const reference = await raw("PUT", w.owner, w.agent.id, RANDOM);
    expect(reference.status).toBe(404);
    expect(JSON.parse(reference.body)).toEqual({ error: "not_found" });
    const targets: Array<[string, string]> = [
      ["the Agent itself", w.agent.id],
      ["the owner", w.owner.id],
      ["a person in no shared group and no friend", alone.id],
      ["an Agent in no shared group", outsideAgent.id],
      ["a member of a group the Agent has left", stranger.id],
      ["a malformed id", "not-a-uuid"],
      ["a malformed id longer than any id", "x".repeat(65)],
    ];
    for (const [label, target] of targets) expect([label, await raw("PUT", w.owner, w.agent.id, target)]).toEqual([label, reference]);
    // Removing what is no id at all is the same 404, however long it is.
    for (const target of ["not-a-uuid", "x".repeat(65)]) expect([target, await raw("DELETE", w.owner, w.agent.id, target)]).toEqual([target, reference]);
    // Longer than the router takes a path segment: what it answers for any such segment, an Agent's id too.
    const overlong = "x".repeat(300);
    expect(await raw("PUT", w.owner, w.agent.id, overlong)).toEqual(await raw("PUT", w.owner, overlong, RANDOM));

    // Not the caller's Agent: the same as an Agent that does not exist, even for a target that qualifies for its owner.
    const noAgent = await raw("PUT", w.mia, RANDOM, w.mia.id);
    expect(noAgent).toEqual(reference);
    expect(await raw("PUT", stranger, w.agent.id, w.mia.id)).toEqual(noAgent);
    expect(await raw("PUT", w.mia, w.agent.id, w.mia.id)).toEqual(noAgent);
    const noAgentDelete = await raw("DELETE", stranger, RANDOM, w.mia.id);
    expect(noAgentDelete.status).toBe(404);
    expect(await raw("DELETE", stranger, w.agent.id, w.mia.id)).toEqual(noAgentDelete);
    expect((await view(w.owner, w.agent.id)).appellations).toEqual([]);
  });

  it("keeps a row whose target no longer qualifies listed and removable, but a new one for it is 404", async () => {
    const w = await world();
    expect((await put(w.owner, w.agent.id, w.gus.id, "古斯")).status).toBe(200);
    await db.query("update memberships set left_seq = joined_seq + 1 where conversation_id = $1 and principal_id = $2", [w.g, w.gus.id]);
    expect(targetsOf(await view(w.owner, w.agent.id))).toEqual([w.gus.id]);
    expect((await put(w.owner, w.agent.id, w.gus.id, "新称呼")).status).toBe(404);
    expect(await stored(w.agent.id)).toEqual({ [w.gus.id]: "古斯" });
    expect(targetsOf((await remove(w.owner, w.agent.id, w.gus.id)).json)).toEqual([]);
  });

  it("shows an Agent it names by name and handle only while that Agent is in a group with it and not deleted; the row stays, removable; a person always shows", async () => {
    const w = await world();
    const theirs = await mustCreateAgent(app, w.eve, { name: "Eve的Bot" });
    await seat(w.g, theirs.id);
    await put(w.owner, w.agent.id, theirs.id, "小机器人");
    await put(w.owner, w.agent.id, w.gus.id, "古斯");
    const entryOf = async (id: string) => (await view(w.owner, w.agent.id)).appellations.find((e: { principalId: string }) => e.principalId === id);
    const inGroup = (id: string, now: boolean) =>
      db.query(`update memberships set left_seq = ${now ? "null" : "joined_seq + 1"} where conversation_id = $1 and principal_id = $2`, [w.g, id]);
    expect(await entryOf(theirs.id)).toEqual({ principalId: theirs.id, kind: "agent", handle: theirs.handle, name: "Eve的Bot", appellation: "小机器人" });

    await inGroup(theirs.id, false);
    await inGroup(w.gus.id, false);
    const hidden = { principalId: theirs.id, kind: "agent", handle: null, name: null, appellation: "小机器人" };
    expect(await entryOf(theirs.id)).toEqual(hidden);
    expect(await entryOf(w.gus.id)).toMatchObject({ handle: w.gus.handle, name: "gus" });
    const listed = (await api(app, w.owner, "GET", "/api/agents")).json.agents.find((a: { id: string }) => a.id === w.agent.id);
    expect(listed.appellations.find((e: { principalId: string }) => e.principalId === theirs.id)).toEqual(hidden);
    // Back in the group, it shows again; deleted, it does not, still a member or not.
    await inGroup(theirs.id, true);
    expect((await entryOf(theirs.id)).name).toBe("Eve的Bot");
    await db.query("update agents set deleted_at = now() where principal_id = $1", [theirs.id]);
    expect(await entryOf(theirs.id)).toEqual(hidden);
    expect(targetsOf((await remove(w.owner, w.agent.id, theirs.id)).json)).toEqual([w.gus.id]);
  });

  it("holds at most 100 targets: the 101st is 409 too_many, replacing one at the cap is fine, removing one makes room", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const { rows } = await db.query<{ id: string }>(
        "insert into principals (kind, handle, display_name, owner_id) values ('agent', $1, $2, $3) returning id",
        [`fill_${String(i).padStart(3, "0")}`, `Fill ${i}`, w.eve.id],
      );
      ids.push(rows[0]!.id);
      await seat(w.g, rows[0]!.id);
    }
    for (const id of ids) expect((await put(w.owner, w.agent.id, id, "称")).status).toBe(200);
    expect(await put(w.owner, w.agent.id, w.mia.id, "米亚")).toEqual({ status: 409, json: { error: "too_many" } });
    expect((await put(w.owner, w.agent.id, ids[0]!, "改")).status).toBe(200);
    expect(targetsOf(await view(w.owner, w.agent.id))).toHaveLength(100);
    await remove(w.owner, w.agent.id, ids[1]!);
    expect((await put(w.owner, w.agent.id, w.mia.id, "米亚")).status).toBe(200);
  });

  it("shows its owner's own other Agent by name and handle with no group in common, until it is deleted; someone else's Agent out of every shared group is blanked", async () => {
    const w = await world();
    const mine = await mustCreateAgent(app, w.owner, { name: "我的二号" });
    const theirs = await mustCreateAgent(app, w.eve, { name: "Eve的Bot" });
    for (const id of [mine.id, theirs.id]) await seat(w.g, id);
    await put(w.owner, w.agent.id, mine.id, "二号");
    await put(w.owner, w.agent.id, theirs.id, "小机器人");
    await db.query("update memberships set left_seq = joined_seq + 1 where conversation_id = $1 and principal_id = any($2::uuid[])", [w.g, [mine.id, theirs.id]]);
    const entryOf = async (id: string) => (await view(w.owner, w.agent.id)).appellations.find((e: { principalId: string }) => e.principalId === id);
    expect(await entryOf(mine.id)).toEqual({ principalId: mine.id, kind: "agent", handle: mine.handle, name: "我的二号", appellation: "二号" });
    expect(await entryOf(theirs.id)).toEqual({ principalId: theirs.id, kind: "agent", handle: null, name: null, appellation: "小机器人" });
    await db.query("update agents set deleted_at = now() where principal_id = $1", [mine.id]);
    expect(await entryOf(mine.id)).toEqual({ principalId: mine.id, kind: "agent", handle: null, name: null, appellation: "二号" });
  });

  it("reads memberships only to show someone else's Agent: a view naming people and its owner's own Agents never waits on them", async () => {
    const w = await world();
    const mine = await mustCreateAgent(app, w.owner, { name: "我的二号" });
    const theirs = await mustCreateAgent(app, w.eve, { name: "Eve的Bot" });
    for (const id of [mine.id, theirs.id]) await seat(w.g, id);
    await put(w.owner, w.agent.id, mine.id, "二号");
    await put(w.owner, w.agent.id, w.mia.id, "米亚");
    /** The owner's view's read while another transaction holds memberships in ACCESS EXCLUSIVE mode, waiting at most 1 s. */
    const readLocked = async () => {
      const holder = await db.pool.connect();
      try {
        await holder.query("begin");
        await holder.query("lock table memberships in access exclusive mode");
        return await db.tx(async (t) => {
          await t.query("set local lock_timeout = '1s'");
          return appellationEntriesOf(t, [w.agent.id]);
        });
      } finally {
        await holder.query("rollback");
        holder.release();
      }
    };
    expect((await readLocked()).get(w.agent.id)!.map((e) => e.name)).toEqual(expect.arrayContaining(["mia", "我的二号"]));
    // Someone else's Agent named as well: then it reads them, and waits (55P03: the lock was not granted in time).
    await put(w.owner, w.agent.id, theirs.id, "小机器人");
    await expect(readLocked()).rejects.toMatchObject({ code: "55P03" });
  });

  it("is 409 agent_deleted for a deleted Agent, for set and remove alike", async () => {
    const w = await world();
    await put(w.owner, w.agent.id, w.mia.id, "米亚");
    expect((await api(app, w.owner, "DELETE", `/api/agents/${w.agent.id}`)).status).toBe(200);
    expect(await put(w.owner, w.agent.id, w.mia.id, "米")).toEqual({ status: 409, json: { error: "agent_deleted" } });
    expect(await remove(w.owner, w.agent.id, w.mia.id)).toEqual({ status: 409, json: { error: "agent_deleted" } });
  });

  it("is removed with its target principal", async () => {
    const w = await world();
    const { rows } = await db.query<{ id: string }>(
      "insert into principals (kind, handle, display_name, owner_id) values ('agent', 'gone_bot', 'Gone', $1) returning id",
      [w.eve.id],
    );
    await seat(w.g, rows[0]!.id);
    await put(w.owner, w.agent.id, rows[0]!.id, "没了");
    await put(w.owner, w.agent.id, w.mia.id, "米亚");
    await db.query("delete from memberships where principal_id = $1", [rows[0]!.id]);
    await db.query("delete from principals where id = $1", [rows[0]!.id]);
    expect(targetsOf(await view(w.owner, w.agent.id))).toEqual([w.mia.id]);
    expect(Object.keys(await stored(w.agent.id))).toEqual([w.mia.id]);
  });

  it("pushes the Agent to its owner only, once per change, and tells nobody else", async () => {
    const w = await world();
    const agentChanged = vi.spyOn(app.realtime, "pushAgentChanged");
    const principalChanged = vi.spyOn(app.realtime, "pushPrincipalChanged");
    const published = vi.spyOn(app.deps.conversations, "publish");
    expect((await put(w.owner, w.agent.id, w.mia.id, "米亚")).status).toBe(200);
    expect((await remove(w.owner, w.agent.id, w.mia.id)).status).toBe(200);
    expect(agentChanged.mock.calls).toEqual([
      [w.owner.id, w.agent.id],
      [w.owner.id, w.agent.id],
    ]);
    expect(principalChanged).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    // A refused one pushes nothing.
    agentChanged.mockClear();
    await put(w.owner, w.agent.id, RANDOM, "x");
    await put(w.owner, w.agent.id, w.mia.id, "");
    expect(agentChanged).not.toHaveBeenCalled();
    // Nor does one that sets what is already there (trimmed, it is the same text).
    expect((await put(w.owner, w.agent.id, w.mia.id, "米亚")).status).toBe(200);
    expect((await put(w.owner, w.agent.id, w.mia.id, " 米亚 ")).status).toBe(200);
    expect((await put(w.owner, w.agent.id, w.mia.id, "亚亚")).json.appellations).toMatchObject([{ principalId: w.mia.id, appellation: "亚亚" }]);
    expect(agentChanged.mock.calls).toEqual([
      [w.owner.id, w.agent.id],
      [w.owner.id, w.agent.id],
    ]);
  });
});
