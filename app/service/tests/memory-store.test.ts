import { describe, expect, it } from "vitest";
import { listAgentNotes, listHearsay, listOwnerNotes, notesFor, roomOf } from "../src/memory/store.ts";
import { weightOf } from "../src/memory/weight.ts";
import { api, group, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * The tables, settings and read rules of an Agent's memory (README "An Agent's memory"): a new note is in the vault,
 * `notesFor` is the one place that decides which notes a conversation may show, and nobody but the owner sees a setting.
 */

const { app, db } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1000" }, agentWorker: false });

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

const reject = (code: string, sql: string, params: unknown[] = []) => expect(db.query(sql, params)).rejects.toMatchObject({ code });

/** A signed-up owner with an Agent and two groups. */
async function world() {
  const owner = await signUp(app, "mem_owner");
  const mia = await signUp(app, "mem_mia");
  const ned = await signUp(app, "mem_ned");
  const agent = await mustCreateAgent(app, owner);
  const g1 = await group(app, owner, "G1", [mia, ned]);
  const g2 = await group(app, owner, "G2", [mia, ned]);
  return { owner, mia, agent, g1, g2, own: agent.conversationId as string };
}

type Where = "own" | "g1" | "g2";
const insertNote = async (table: "owner_notes" | "agent_notes", who: string, text: string, vault: boolean, origin: string | null) => {
  const column = table === "owner_notes" ? "owner_id" : "agent_id";
  await db.query(`insert into ${table} (${column}, text, vault, origin_conversation_id) values ($1, $2, $3, $4)`, [who, text, vault, origin]);
};

describe("tables", () => {
  it("a new note is in the vault, by auto, sure, from a review; the checks hold", async () => {
    const { owner, agent } = await world();
    await db.query("insert into owner_notes (owner_id, text) values ($1, 'a')", [owner.id]);
    await db.query("insert into agent_notes (agent_id, text) values ($1, 'b')", [agent.id]);
    for (const table of ["owner_notes", "agent_notes"]) {
      const { rows } = await db.query(`select vault, vault_by, unsure, origin, origin_conversation_id from ${table}`);
      expect(rows).toEqual([{ vault: true, vault_by: "auto", unsure: false, origin: "review", origin_conversation_id: null }]);
    }
    await reject(CHECK_VIOLATION, "insert into owner_notes (owner_id, text) values ($1, '')", [owner.id]);
    // The column's check is a coarse guard of 9000 characters, not the limit: a room of 3000 weight holds 9000 one-byte characters.
    await reject(CHECK_VIOLATION, "insert into owner_notes (owner_id, text) values ($1, $2)", [owner.id, "x".repeat(9001)]);
    await db.query("insert into owner_notes (owner_id, text) values ($1, $2)", [owner.id, "x".repeat(9000)]);
    await db.query("insert into agent_notes (agent_id, text) values ($1, $2)", [agent.id, "x".repeat(9000)]);
    await reject(CHECK_VIOLATION, "insert into agent_notes (agent_id, text) values ($1, $2)", [agent.id, "x".repeat(9001)]);
    // Whatever the language, a text within a room's weight limit is within the column's 9000 characters: a character weighs at least a third.
    const { roomOwner, roomSelf, modelEntryMax } = app.deps.config.memory;
    for (const limit of [roomOwner, roomSelf]) expect(3 * limit).toBeLessThanOrEqual(9000);
    expect(3 * modelEntryMax).toBeLessThanOrEqual(600);
    await reject(CHECK_VIOLATION, "insert into agent_notes (agent_id, text, vault_by) values ($1, 'x', 'code')", [agent.id]);
    await reject(CHECK_VIOLATION, "insert into agent_notes (agent_id, text, origin) values ($1, 'x', 'dream')", [agent.id]);
    await reject(FOREIGN_KEY_VIOLATION, "insert into agent_notes (agent_id, text, origin_conversation_id) values ($1, 'x', gen_random_uuid())", [agent.id]);
  });

  it("hearsay is 1 to 600 characters (a model entry of 200 weight is at most that) and needs its group; flags and changes have their kinds and statuses", async () => {
    const { owner, agent, g1 } = await world();
    const hear = (text: string) =>
      db.query("insert into agent_hearsay (agent_id, conversation_id, speaker_name, text, said_at) values ($1, $2, 'Mia', $3, now())", [agent.id, g1, text]);
    await hear("x".repeat(600));
    await expect(hear("")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(hear("x".repeat(601))).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await reject(
      FOREIGN_KEY_VIOLATION,
      "insert into agent_hearsay (agent_id, conversation_id, speaker_name, text, said_at) values ($1, gen_random_uuid(), 'Mia', 'x', now())",
      [agent.id],
    );

    await db.query("insert into memory_flags (agent_id, conversation_id, seq, kind) values ($1, $2, 3, 'own')", [agent.id, g1]);
    await reject(CHECK_VIOLATION, "insert into memory_flags (agent_id, conversation_id, seq, kind) values ($1, $2, 3, 'other')", [agent.id, g1]);
    await db.query("insert into memory_review_state (agent_id, conversation_id) values ($1, $2)", [agent.id, g1]);
    expect((await db.query("select reviewed_seq::text as s from memory_review_state")).rows).toEqual([{ s: "0" }]);

    const change = (status: string) =>
      db.query("insert into memory_changes (owner_id, agent_id, status, ops) values ($1, $2, $3, '[]')", [owner.id, agent.id, status]);
    for (const s of ["applied", "undone", "pending", "discarded"]) await change(s);
    await expect(change("lost")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect((await db.query('select distinct "full" from memory_changes')).rows).toEqual([{ full: false }]);
  });

  it("deleting a conversation takes its hearsay with it; a note's origin only goes null", async () => {
    const { owner, agent } = await world();
    // A bare conversation (one with messages and members is never deleted by hand).
    const c = (await db.query<{ id: string }>("insert into conversations (type, creator_id) values ('agent', $1) returning id", [owner.id])).rows[0]!.id;
    await insertNote("owner_notes", owner.id, "n", false, c);
    await db.query("insert into agent_hearsay (agent_id, conversation_id, speaker_name, text, said_at) values ($1, $2, 'Mia', 'h', now())", [agent.id, c]);
    await db.query("delete from conversations where id = $1", [c]);
    expect((await db.query("select origin_conversation_id from owner_notes")).rows).toEqual([{ origin_conversation_id: null }]);
    expect((await db.query("select 1 from agent_hearsay")).rowCount).toBe(0);
  });

  it("the settings default: Agents memory on, ask off, shared on; accounts auto, with three values", async () => {
    const { owner } = await world();
    expect((await db.query("select memory, memory_ask, shared_notes from agents")).rows).toEqual([{ memory: true, memory_ask: false, shared_notes: true }]);
    await db.query("insert into accounts (principal_id) values ($1) on conflict do nothing", [owner.id]);
    expect((await db.query("select new_notes from accounts where principal_id = $1", [owner.id])).rows).toEqual([{ new_notes: "auto" }]);
    for (const v of ["vault", "open"]) await db.query("update accounts set new_notes = $2 where principal_id = $1", [owner.id, v]);
    await reject(CHECK_VIOLATION, "update accounts set new_notes = 'x' where principal_id = $1", [owner.id]);
  });
});

describe("the lists and the room", () => {
  it("lists come oldest first and a room is measured in weight", async () => {
    const { owner, agent, g1 } = await world();
    await db.query("insert into owner_notes (owner_id, text, created_at) values ($1, 'second', now()), ($1, 'first', now() - interval '1 hour')", [owner.id]);
    await db.query("insert into agent_notes (agent_id, text, created_at) values ($1, 'two', now()), ($1, 'one', now() - interval '1 hour')", [agent.id]);
    await db.query(
      "insert into agent_hearsay (agent_id, conversation_id, speaker_name, text, said_at, created_at) values ($1, $2, 'Mia', 'b', now(), now()), ($1, $2, 'Mia', 'a', now(), now() - interval '1 hour')",
      [agent.id, g1],
    );
    const mine = await listOwnerNotes(db, owner.id);
    expect(mine.map((n) => [n.kind, n.text, n.vault, n.vaultBy, n.unsure, n.origin, n.originConversationId])).toEqual([
      ["owner", "first", true, "auto", false, "review", null],
      ["owner", "second", true, "auto", false, "review", null],
    ]);
    expect(mine[0]!.createdAt).toBeInstanceOf(Date);
    expect((await listAgentNotes(db, agent.id)).map((n) => [n.kind, n.text])).toEqual([
      ["self", "one"],
      ["self", "two"],
    ]);
    const heard = await listHearsay(db, agent.id);
    expect(heard.map((h) => h.text)).toEqual(["a", "b"]);
    expect(heard[0]).toMatchObject({ agentId: agent.id, conversationId: g1, speakerId: null, speakerName: "Mia" });
    expect(await listHearsay(db, agent.id, "00000000-0000-4000-8000-000000000000")).toEqual([]);
    expect((await listHearsay(db, agent.id, g1)).length).toBe(2);
    expect(weightOf([{ text: "ab" }, { text: "你好😀" }])).toBe(1 + 4);
    expect(roomOf(app.deps.config)).toEqual({ owner: 2000, self: 3000, hearsay: 2000, notes: 150 });
  });
});

describe("notesFor: the usage rules in one place", () => {
  /** Seeds both kinds and hearsay; the texts say what each note is. */
  async function seeded() {
    const w = await world();
    const { owner, agent, g1, g2, own } = w;
    for (const [table, who] of [
      ["owner_notes", owner.id],
      ["agent_notes", agent.id],
    ] as const) {
      const k = table === "owner_notes" ? "o" : "s";
      await insertNote(table, who, `${k}-open`, false, null);
      await insertNote(table, who, `${k}-vault`, true, null);
      await insertNote(table, who, `${k}-vault-g1`, true, g1);
      await insertNote(table, who, `${k}-vault-g2`, true, g2);
      await insertNote(table, who, `${k}-open-g2`, false, g2);
      await insertNote(table, who, `${k}-vault-own`, true, own);
    }
    const hear = (c: string, t: string) =>
      db.query("insert into agent_hearsay (agent_id, conversation_id, speaker_name, text, said_at) values ($1, $2, 'Mia', $3, now())", [agent.id, c, t]);
    await hear(g1, "h-g1");
    await hear(g2, "h-g2");
    return w;
  }
  const names = (r: { owner: { text: string }[]; self: { text: string }[]; hearsay: { text: string }[] }) => ({
    owner: r.owner.map((n) => n.text).sort(),
    self: r.self.map((n) => n.text).sort(),
    hearsay: r.hearsay.map((n) => n.text).sort(),
  });
  const ask = async (w: Awaited<ReturnType<typeof seeded>>, where: Where, over: { memory?: boolean; sharedNotes?: boolean } = {}) =>
    names(
      await notesFor(
        db,
        { id: w.agent.id, ownerId: w.owner.id, memory: over.memory ?? true, sharedNotes: over.sharedNotes ?? true },
        { conversationId: { own: w.own, g1: w.g1, g2: w.g2 }[where], group: where !== "own" },
      ),
    );
  const EVERYTHING_O = ["o-open", "o-open-g2", "o-vault", "o-vault-g1", "o-vault-g2", "o-vault-own"];
  const EVERYTHING_S = ["s-open", "s-open-g2", "s-vault", "s-vault-g1", "s-vault-g2", "s-vault-own"];

  it("memory off: nothing at all, in any conversation", async () => {
    const w = await seeded();
    for (const where of ["own", "g1", "g2"] as const) expect(await ask(w, where, { memory: false })).toEqual({ owner: [], self: [], hearsay: [] });
  });

  it("in the owner's own conversation: everything, the group hearsay too", async () => {
    const w = await seeded();
    expect(await ask(w, "own")).toEqual({ owner: EVERYTHING_O, self: EVERYTHING_S, hearsay: ["h-g1", "h-g2"] });
  });

  it("in a group: what is out of the vault, what began in that group, and that group's hearsay only", async () => {
    const w = await seeded();
    expect(await ask(w, "g1")).toEqual({ owner: ["o-open", "o-open-g2", "o-vault-g1"], self: ["s-open", "s-open-g2", "s-vault-g1"], hearsay: ["h-g1"] });
    expect(await ask(w, "g2")).toEqual({ owner: ["o-open", "o-open-g2", "o-vault-g2"], self: ["s-open", "s-open-g2", "s-vault-g2"], hearsay: ["h-g2"] });
  });

  it("shared notes off: no notes about the owner anywhere, the Agent's own and hearsay unchanged", async () => {
    const w = await seeded();
    expect(await ask(w, "own", { sharedNotes: false })).toEqual({ owner: [], self: EVERYTHING_S, hearsay: ["h-g1", "h-g2"] });
    expect(await ask(w, "g1", { sharedNotes: false })).toEqual({ owner: [], self: ["s-open", "s-open-g2", "s-vault-g1"], hearsay: ["h-g1"] });
  });

  it("another owner's and another Agent's notes never appear, and an unsure hearsay note is like any other", async () => {
    const w = await seeded();
    const other = await signUp(app, "mem_other");
    const stranger = await mustCreateAgent(app, other);
    await insertNote("owner_notes", other.id, "x-owner", false, null);
    await insertNote("agent_notes", stranger.id, "x-self", false, null);
    await db.query("insert into agent_hearsay (agent_id, conversation_id, speaker_name, text, said_at) values ($1, $2, 'Mia', 'x-hear', now())", [stranger.id, w.g1]);
    await db.query("insert into owner_notes (owner_id, text, vault, unsure, origin, origin_conversation_id) values ($1, 'o-hearsay-open', false, true, 'hearsay', null), ($1, 'o-hearsay-vault', true, true, 'hearsay', null)", [w.owner.id]);
    await db.query("insert into agent_notes (agent_id, text, vault, unsure, origin, origin_conversation_id) values ($1, 's-hearsay-open', false, true, 'hearsay', null), ($1, 's-hearsay-vault', true, true, 'hearsay', $2)", [w.agent.id, w.g1]);
    for (const where of ["own", "g1", "g2"] as const) {
      const got = JSON.stringify(await ask(w, where));
      for (const t of ["x-owner", "x-self", "x-hear"]) expect([where, t, got.includes(t)]).toEqual([where, t, false]);
    }
    const g1 = await ask(w, "g1");
    expect(g1.owner).toContain("o-hearsay-open");
    expect(g1.owner).not.toContain("o-hearsay-vault");
    expect(g1.self).toEqual(expect.arrayContaining(["s-hearsay-open", "s-hearsay-vault"]));
    expect((await ask(w, "g2")).self).not.toContain("s-hearsay-vault");
    expect((await ask(w, "own")).owner).toContain("o-hearsay-vault");
  });

  it("a group that began no note shows nothing of the vault and no hearsay", async () => {
    const w = await seeded();
    const none = await notesFor(
      db,
      { id: w.agent.id, ownerId: w.owner.id, memory: true, sharedNotes: true },
      { conversationId: "00000000-0000-4000-8000-000000000000", group: true },
    );
    expect(names(none)).toEqual({ owner: ["o-open", "o-open-g2"], self: ["s-open", "s-open-g2"], hearsay: [] });
  });
});

describe("the settings on the wire", () => {
  it("an Agent has memory on, ask off, shared notes on; each is a boolean on create and PATCH", async () => {
    const owner = await signUp(app, "mem_wire");
    const agent = await mustCreateAgent(app, owner);
    expect(agent).toMatchObject({ memory: true, memoryAsk: false, sharedNotes: true });
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json).toMatchObject({ memory: true, memoryAsk: false, sharedNotes: true });
    const list = (await api(app, owner, "GET", "/api/agents")).json as { agents: Record<string, unknown>[] };
    expect(list.agents[0]).toMatchObject({ memory: true, memoryAsk: false, sharedNotes: true });
    for (const key of ["memory", "memoryAsk", "sharedNotes"]) {
      for (const bad of ["yes", null, 1]) {
        expect([key, bad, (await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { [key]: bad })).status]).toEqual([key, bad, 400]);
        expect([key, bad, (await api(app, owner, "POST", "/api/agents", { handle: `bad_${key.toLowerCase()}`, name: "x", [key]: bad })).status]).toEqual([key, bad, 400]);
      }
    }
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { memory: false, memoryAsk: true, sharedNotes: false })).json).toMatchObject({
      memory: false,
      memoryAsk: true,
      sharedNotes: false,
    });
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json).toMatchObject({ memory: false, memoryAsk: true, sharedNotes: false });
    const made = await api(app, owner, "POST", "/api/agents", { handle: "mem_made", name: "Made", memory: false, memoryAsk: true, sharedNotes: false });
    expect(made).toMatchObject({ status: 201, json: { memory: false, memoryAsk: true, sharedNotes: false } });
  });

  it("GET /api/me has newNotes (auto at first); PATCH sets it to auto, vault or open and nothing else", async () => {
    const owner = await signUp(app, "mem_me");
    expect((await api(app, owner, "GET", "/api/me")).json.newNotes).toBe("auto");
    for (const v of ["vault", "open", "auto"]) {
      expect((await api(app, owner, "PATCH", "/api/me", { newNotes: v })).status).toBe(200);
      expect((await api(app, owner, "GET", "/api/me")).json.newNotes).toBe(v);
    }
    for (const bad of ["all", null, 1, ""]) expect([bad, (await api(app, owner, "PATCH", "/api/me", { newNotes: bad })).status]).toEqual([bad, 400]);
    expect((await api(app, owner, "PATCH", "/api/me", {})).status).toBe(400);
    const both = await api(app, owner, "PATCH", "/api/me", { displayName: "Memo", newNotes: "vault" });
    expect(both).toMatchObject({ status: 200, json: { displayName: "Memo" } });
    expect((await api(app, owner, "GET", "/api/me")).json).toMatchObject({ displayName: "Memo", newNotes: "vault" });
    const other = await signUp(app, "mem_me2");
    expect((await api(app, other, "GET", "/api/me")).json.newNotes).toBe("auto");
  });
});
