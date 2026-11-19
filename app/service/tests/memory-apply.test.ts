import { describe, expect, it } from "vitest";
import { lockAccount } from "../src/accounts/store.ts";
import { lockRoom } from "../src/memory/write.ts";
import { applyOps, confirmChange, discardChange, proposeUnlocks, undoChange, vaultKey } from "../src/memory/apply.ts";
import type { Op } from "../src/memory/ops.ts";
import { listAgentNotes, listOwnerNotes, notesFor, type NoteKind, type Rooms } from "../src/memory/store.ts";
import { api, group, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Applying what a review changed (README "An Agent's memory"): the order inside one change, the room limits, what
 * only the owner may do (take a note out of the vault), and undo / confirm / discard of a recorded change.
 */

const { app, db } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1000" }, agentWorker: false });

const ROOMS: Rooms = { owner: 2000, self: 3000, hearsay: 2000 };
const BOTH = new Set<NoteKind>(["owner", "self"]);
const OPEN = { vault: false, unsure: false };

let counter = 0;
async function world() {
  const n = ++counter;
  const owner = await signUp(app, `ap_owner${n}`);
  const agent = await mustCreateAgent(app, owner);
  return { n, actor: owner, cookie: owner.cookie as string, conv: agent.conversationId as string, ownerId: owner.id as string, agentId: agent.id as string };
}
type World = Awaited<ReturnType<typeof world>>;

type SeedOver = { vault?: boolean; vaultBy?: "auto" | "owner"; unsure?: boolean };
async function seed(w: World, kind: NoteKind, text: string, over: SeedOver = {}): Promise<string> {
  const table = kind === "owner" ? "owner_notes" : "agent_notes";
  const column = kind === "owner" ? "owner_id" : "agent_id";
  const { rows } = await db.query<{ id: string }>(
    `insert into ${table} (${column}, text, vault, vault_by, unsure) values ($1, $2, $3, $4, $5) returning id`,
    [kind === "owner" ? w.ownerId : w.agentId, text, over.vault ?? true, over.vaultBy ?? "auto", over.unsure ?? false],
  );
  return rows[0]!.id;
}

const otherOwner = async (w: World): Promise<string> => (await signUp(app, `ap_other${w.n}`)).id as string;

/** The owner's own edit of a note, through the route. */
const patchNote = async (w: World, id: string, body: Record<string, unknown>) => {
  const res = await api(app, { cookie: w.cookie }, "PATCH", `/api/memory/notes/${id}`, body);
  expect(res.status).toBe(200);
};

const ownerNotes = (w: World) => listOwnerNotes(db, w.ownerId);
const selfNotes = (w: World) => listAgentNotes(db, w.agentId);

type Over = {
  sharedNotes?: boolean;
  kinds?: ReadonlySet<NoteKind>;
  status?: "applied" | "pending";
  vaults?: Map<string, { vault: boolean; unsure: boolean }>;
  duplicates?: ReadonlySet<string>;
  rooms?: Rooms;
};
const run = (w: World, ops: Op[], refs: Map<string, { kind: NoteKind; id: string }>, over: Over = {}) =>
  db.tx((t) =>
    applyOps(t, { ownerId: w.ownerId, agentId: w.agentId, sharedNotes: over.sharedNotes ?? true, kinds: over.kinds ?? BOTH }, ops, refs, {
      conversationId: w.conv,
      originConversationId: w.conv,
      status: over.status ?? "applied",
      vaults: over.vaults ?? new Map(),
      duplicates: over.duplicates ?? new Set(),
      rooms: over.rooms ?? ROOMS,
    }),
  );
const ref = (kind: NoteKind, id: string) => ({ kind, id });
const undo = (w: World, id: string, rooms = ROOMS) => db.tx((t) => undoChange(t, w.ownerId, id, rooms));
const confirm = (w: World, id: string, rooms = ROOMS) => db.tx((t) => confirmChange(t, w.ownerId, id, rooms));
const propose = (w: World, notes: Array<{ kind: NoteKind; id: string }>) => db.tx((t) => proposeUnlocks(t, { ownerId: w.ownerId, agentId: w.agentId }, w.conv, notes));
const changeRow = async (id: string) =>
  (await db.query<{ status: string; ops: Array<Record<string, unknown>>; full: boolean }>('select status, ops, "full" from memory_changes where id = $1', [id])).rows[0]!;

describe("applyOps", () => {
  it("adds a note of each kind: in the vault, unsure, from a review, remembering where it began", async () => {
    const w = await world();
    const r = await run(w, [{ op: "add", kind: "owner", text: "likes tea" }, { op: "add", kind: "self", text: "owner is brief" }], new Map());
    expect(r!.full).toBe(false);
    expect(r!.unlocks).toEqual([]);
    expect(r!.applied.map((a) => [a.op, a.kind, a.before, a.after, a.vaultBefore, a.vaultAfter])).toEqual([
      ["add", "owner", null, "likes tea", null, true],
      ["add", "self", null, "owner is brief", null, true],
    ]);
    const [o] = await ownerNotes(w);
    const [s] = await selfNotes(w);
    expect(r!.applied.map((a) => a.noteId)).toEqual([o!.id, s!.id]);
    for (const n of [o!, s!]) expect(n).toMatchObject({ vault: true, vaultBy: "auto", unsure: true, origin: "review", originConversationId: w.conv });
    const row = await changeRow(r!.changeId!);
    expect(row.status).toBe("applied");
    expect(row.full).toBe(false);
    expect(row.ops.map((x) => x.noteId)).toEqual([o!.id, s!.id]);
  });

  it("a verdict for the text puts a new note in or out of the vault", async () => {
    const w = await world();
    const vaults = new Map([
      [vaultKey("owner", "likes tea"), OPEN],
      [vaultKey("owner", "secret plan"), { vault: true, unsure: false }],
    ]);
    await run(w, [{ op: "add", kind: "owner", text: "likes tea" }, { op: "add", kind: "owner", text: "secret plan" }], new Map(), { vaults });
    // Notes added in one change share a creation time, so their order is not defined: look them up by text.
    const byText = new Map((await ownerNotes(w)).map((n) => [n.text, n]));
    expect(byText.get("likes tea")).toMatchObject({ vault: false, unsure: false });
    expect(byText.get("secret plan")).toMatchObject({ vault: true, unsure: false });
  });

  it("replaces, removes and locks a note of each kind", async () => {
    const w = await world();
    const o1 = await seed(w, "owner", "old owner", { vault: false });
    const o2 = await seed(w, "owner", "gone owner", { vault: false });
    const s1 = await seed(w, "self", "old self", { vault: false });
    const s2 = await seed(w, "self", "to lock", { vault: false });
    const refs = new Map([["a", ref("owner", o1)], ["b", ref("owner", o2)], ["c", ref("self", s1)], ["d", ref("self", s2)]]);
    const r = await run(
      w,
      [
        { op: "replace", ref: "a", text: "new owner" },
        { op: "remove", ref: "b" },
        { op: "replace", ref: "c", text: "new self" },
        { op: "lock", ref: "d" },
      ],
      refs,
      { vaults: new Map([[vaultKey("owner", "new owner"), OPEN], [vaultKey("self", "new self"), OPEN]]) },
    );
    expect(r!.applied.map((a) => [a.op, a.before, a.after, a.vaultBefore, a.vaultAfter])).toEqual([
      ["replace", "old owner", "new owner", false, false],
      ["remove", "gone owner", null, false, null],
      ["replace", "old self", "new self", false, false],
      ["lock", "to lock", "to lock", false, true],
    ]);
    expect((await ownerNotes(w)).map((n) => [n.text, n.vault])).toEqual([["new owner", false]]);
    expect((await selfNotes(w)).map((n) => [n.text, n.vault, n.vaultBy])).toEqual([["new self", false, "auto"], ["to lock", true, "owner"]]);
  });

  it("does removes and replaces before adds: a merge frees room for its add", async () => {
    const w = await world();
    const a = await seed(w, "owner", "x".repeat(10));
    const b = await seed(w, "owner", "y".repeat(10));
    const rooms = { ...ROOMS, owner: 25 };
    const refs = new Map([["a", ref("owner", a)], ["b", ref("owner", b)]]);
    // The add is listed first and fits only after the merge.
    const add: Op = { op: "add", kind: "owner", text: "z".repeat(12) };
    const alone = await run(w, [add], refs, { rooms });
    expect(alone).toMatchObject({ applied: [], full: true });
    const r = await run(w, [add, { op: "replace", ref: "a", text: "m".repeat(8) }, { op: "remove", ref: "b" }], refs, { rooms });
    expect(r!.full).toBe(false);
    expect(r!.applied.map((x) => x.op)).toEqual(["replace", "remove", "add"]);
    expect((await ownerNotes(w)).map((n) => n.text).sort()).toEqual(["m".repeat(8), "z".repeat(12)].sort());
  });

  it("an add that does not fit is dropped and sets full; the ones that fit are kept; the row says full", async () => {
    const w = await world();
    await seed(w, "owner", "x".repeat(15));
    const rooms = { ...ROOMS, owner: 20 };
    const r = await run(w, [{ op: "add", kind: "owner", text: "y".repeat(10) }, { op: "add", kind: "owner", text: "z".repeat(5) }], new Map(), { rooms });
    expect(r!.full).toBe(true);
    expect(r!.applied.map((a) => a.after)).toEqual(["z".repeat(5)]);
    expect((await changeRow(r!.changeId!)).full).toBe(true);
    // Counted in code points, not UTF-16 units.
    const w2 = await world();
    const r2 = await run(w2, [{ op: "add", kind: "self", text: "😀".repeat(5) }], new Map(), { rooms: { ...ROOMS, self: 5 } });
    expect(r2!.full).toBe(false);
    expect(await selfNotes(w2)).toHaveLength(1);
  });

  it("when only the fullness is left, the change row still says full (the hint is shown with it)", async () => {
    const w = await world();
    await seed(w, "owner", "x".repeat(20));
    const r = await run(w, [{ op: "add", kind: "owner", text: "no room" }], new Map(), { rooms: { ...ROOMS, owner: 20 } });
    expect(r).toMatchObject({ applied: [], full: true, unlocks: [] });
    expect(await changeRow(r!.changeId!)).toMatchObject({ status: "applied", ops: [], full: true });
  });

  it("the room of an Agent's own notes is its own: a full owner room does not stop a self note", async () => {
    const w = await world();
    await seed(w, "owner", "x".repeat(20));
    const r = await run(w, [{ op: "add", kind: "owner", text: "no room" }, { op: "add", kind: "self", text: "room here" }], new Map(), { rooms: { ...ROOMS, owner: 20 } });
    expect(r!.full).toBe(true);
    expect(r!.applied.map((a) => a.kind)).toEqual(["self"]);
  });

  it("a replace that would pass the room is dropped and sets full", async () => {
    const w = await world();
    const a = await seed(w, "owner", "x".repeat(10));
    const r = await run(w, [{ op: "replace", ref: "a", text: "y".repeat(30) }], new Map([["a", ref("owner", a)]]), { rooms: { ...ROOMS, owner: 20 } });
    expect(r).toMatchObject({ applied: [], full: true });
    expect((await ownerNotes(w))[0]!.text).toBe("x".repeat(10));
  });

  it("drops owner-kind ops when the notes are not shared or the kind is not allowed", async () => {
    const w = await world();
    const o = await seed(w, "owner", "about me");
    const s = await seed(w, "self", "mine");
    const refs = new Map([["o", ref("owner", o)], ["s", ref("self", s)]]);
    const ops: Op[] = [
      { op: "add", kind: "owner", text: "new about me" },
      { op: "add", kind: "self", text: "new mine" },
      { op: "remove", ref: "o" },
      { op: "replace", ref: "s", text: "changed mine" },
    ];
    const off = await run(w, ops, refs, { sharedNotes: false });
    expect(off!.applied.map((a) => [a.op, a.kind])).toEqual([["replace", "self"], ["add", "self"]]);
    expect((await ownerNotes(w)).map((n) => n.text)).toEqual(["about me"]);

    const w2 = await world();
    const o2 = await seed(w2, "owner", "about me");
    const s2 = await seed(w2, "self", "mine");
    const refs2 = new Map([["o", ref("owner", o2)], ["s", ref("self", s2)]]);
    const onlyOwner = await run(w2, ops, refs2, { kinds: new Set<NoteKind>(["owner"]) });
    expect(onlyOwner!.applied.map((a) => [a.op, a.kind])).toEqual([["remove", "owner"], ["add", "owner"]]);
    expect((await selfNotes(w2)).map((n) => n.text)).toEqual(["mine"]);
  });

  it("drops an add whose text is in duplicates, and an op naming a note that is gone or not this owner's", async () => {
    const w = await world();
    const stranger = await world();
    const foreign = await seed(stranger, "owner", "theirs");
    const gone = await seed(w, "owner", "soon gone");
    await db.query("delete from owner_notes where id = $1", [gone]);
    const refs = new Map([["f", ref("owner", foreign)], ["g", ref("owner", gone)]]);
    const r = await run(
      w,
      [{ op: "add", kind: "owner", text: "already known" }, { op: "remove", ref: "f" }, { op: "replace", ref: "g", text: "x y" }, { op: "lock", ref: "f" }],
      refs,
      { duplicates: new Set(["already known"]) },
    );
    expect(r).toBeNull();
    expect((await ownerNotes(stranger)).map((n) => [n.text, n.vault])).toEqual([["theirs", true]]);
  });

  it("touches a note at most once per change: the first op on it wins", async () => {
    const w = await world();
    const a = await seed(w, "owner", "first", { vault: false });
    const refs = new Map([["a", ref("owner", a)]]);
    const r = await run(w, [{ op: "replace", ref: "a", text: "second" }, { op: "remove", ref: "a" }, { op: "lock", ref: "a" }], refs, {
      vaults: new Map([[vaultKey("owner", "second"), OPEN]]),
    });
    expect(r!.applied.map((x) => x.op)).toEqual(["replace"]);
    expect((await ownerNotes(w)).map((n) => [n.text, n.vault])).toEqual([["second", false]]);
  });

  it("answers null and records nothing when nothing is left", async () => {
    const w = await world();
    expect(await run(w, [], new Map())).toBeNull();
    expect(await run(w, [{ op: "remove", ref: "nope" }], new Map())).toBeNull();
    expect((await db.query("select count(*)::int as n from memory_changes")).rows[0].n).toBe(0);
  });

  it("pending writes nothing but the change row; confirming applies it", async () => {
    const w = await world();
    const a = await seed(w, "owner", "old", { vault: false });
    const refs = new Map([["a", ref("owner", a)]]);
    const r = await run(w, [{ op: "add", kind: "owner", text: "new fact" }, { op: "replace", ref: "a", text: "newer" }], refs, {
      status: "pending",
      vaults: new Map([[vaultKey("owner", "new fact"), OPEN], [vaultKey("owner", "newer"), OPEN]]),
    });
    expect(r!.applied.map((x) => [x.op, x.noteId === null])).toEqual([["replace", false], ["add", true]]);
    expect((await ownerNotes(w)).map((n) => [n.text, n.vault])).toEqual([["old", false]]);
    expect((await changeRow(r!.changeId!)).status).toBe("pending");

    const done = await confirm(w, r!.changeId!);
    expect(Array.isArray(done) && done.map((x) => x.op)).toEqual(["replace", "add"]);
    expect((await ownerNotes(w)).map((n) => [n.text, n.vault]).sort()).toEqual([["new fact", false], ["newer", false]]);
    const row = await changeRow(r!.changeId!);
    expect(row.status).toBe("applied");
    expect(row.ops.every((x) => typeof x.noteId === "string")).toBe(true);
    // It is applied now: no second confirm, and discarding is over.
    expect(await confirm(w, r!.changeId!)).toBeNull();
    expect(await db.tx((t) => discardChange(t, w.ownerId, r!.changeId!))).toBeNull();
    // And an applied change of the owner's own can still be undone.
    expect(await undo(w, r!.changeId!)).toBe("undone");
    expect((await ownerNotes(w)).map((n) => n.text)).toEqual(["old"]);
  });

  it("never applies an unlock: the note stays in the vault and its ref comes back", async () => {
    const w = await world();
    const a = await seed(w, "owner", "private thing", { vault: true });
    const b = await seed(w, "owner", "open thing", { vault: false });
    const refs = new Map([["a", ref("owner", a)], ["b", ref("owner", b)]]);
    const r = await run(w, [{ op: "unlock", ref: "a" }, { op: "unlock", ref: "b" }, { op: "unlock", ref: "ghost" }], refs);
    expect(r).toMatchObject({ applied: [], unlocks: ["a"], changeId: null });
    expect((await ownerNotes(w)).find((n) => n.id === a)).toMatchObject({ vault: true, vaultBy: "auto" });
    // Alongside other ops, and in a pending change too.
    for (const status of ["applied", "pending"] as const) {
      const p = await run(w, [{ op: "unlock", ref: "a" }, { op: "add", kind: "self", text: `kept ${status}` }], refs, { status });
      expect(p!.unlocks).toEqual(["a"]);
      expect(p!.applied.map((x) => x.op)).toEqual(["add"]);
      expect((await ownerNotes(w)).find((n) => n.id === a)!.vault).toBe(true);
      expect((await changeRow(p!.changeId!)).ops.map((x) => x.op)).toEqual(["add"]);
    }
  });

  it("a replace keeps a vault note in the vault whatever the new text and the verdict", async () => {
    const w = await world();
    const a = await seed(w, "owner", "private", { vault: true, unsure: true });
    const s = await seed(w, "self", "private too", { vault: true });
    const refs = new Map([["a", ref("owner", a)], ["s", ref("self", s)]]);
    await run(w, [{ op: "replace", ref: "a", text: "harmless" }, { op: "replace", ref: "s", text: "also harmless" }], refs, {
      vaults: new Map([[vaultKey("owner", "harmless"), OPEN], [vaultKey("self", "also harmless"), OPEN]]),
    });
    expect((await ownerNotes(w))[0]).toMatchObject({ text: "harmless", vault: true, unsure: true });
    expect((await selfNotes(w))[0]).toMatchObject({ text: "also harmless", vault: true });
  });

  it("a replace of a note the owner locked keeps it locked; one the owner opened is re-sorted towards the vault like an auto note", async () => {
    const w = await world();
    const ownerLocked = await seed(w, "owner", "owner locked", { vault: true, vaultBy: "owner" });
    const openA = await seed(w, "owner", "owner opened a", { vault: false, vaultBy: "owner" });
    const openB = await seed(w, "owner", "owner opened b", { vault: false, vaultBy: "owner" });
    const openC = await seed(w, "owner", "owner opened c", { vault: false, vaultBy: "owner" });
    const autoOpen = await seed(w, "owner", "auto open", { vault: false });
    const autoOpen2 = await seed(w, "owner", "auto open 2", { vault: false });
    const refs = new Map([
      ["l", ref("owner", ownerLocked)],
      ["a", ref("owner", openA)],
      ["b", ref("owner", openB)],
      ["c", ref("owner", openC)],
      ["d", ref("owner", autoOpen)],
      ["e", ref("owner", autoOpen2)],
    ]);
    await run(
      w,
      [
        { op: "replace", ref: "l", text: "now harmless l" },
        { op: "replace", ref: "a", text: "now private a" },
        { op: "replace", ref: "b", text: "still harmless b" },
        { op: "replace", ref: "c", text: "no verdict c" },
        { op: "replace", ref: "d", text: "now private d" },
        { op: "replace", ref: "e", text: "still harmless e" },
      ],
      refs,
      {
        vaults: new Map([
          [vaultKey("owner", "now harmless l"), OPEN],
          [vaultKey("owner", "now private a"), { vault: true, unsure: false }],
          [vaultKey("owner", "still harmless b"), OPEN],
          [vaultKey("owner", "now private d"), { vault: true, unsure: true }],
          [vaultKey("owner", "still harmless e"), OPEN],
        ]),
      },
    );
    const byText = new Map((await ownerNotes(w)).map((n) => [n.text, n]));
    expect(byText.get("now harmless l")).toMatchObject({ vault: true, vaultBy: "owner" });
    // The owner opened it, but this text is new and the owner never approved it for groups.
    expect(byText.get("now private a")).toMatchObject({ vault: true, vaultBy: "auto", unsure: false });
    expect(byText.get("still harmless b")).toMatchObject({ vault: false, vaultBy: "owner" });
    expect(byText.get("no verdict c")).toMatchObject({ vault: true, vaultBy: "auto", unsure: true });
    expect(byText.get("now private d")).toMatchObject({ vault: true, vaultBy: "auto", unsure: true });
    expect(byText.get("still harmless e")).toMatchObject({ vault: false });
  });

  it("a replace of an open auto note with no verdict goes into the vault, unsure (fail closed)", async () => {
    const w = await world();
    const a = await seed(w, "self", "open", { vault: false });
    await run(w, [{ op: "replace", ref: "a", text: "changed" }], new Map([["a", ref("self", a)]]));
    expect((await selfNotes(w))[0]).toMatchObject({ text: "changed", vault: true, unsure: true });
  });

  it("holds the owner's account lock: a change waits for whoever holds it", async () => {
    const w = await world();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = db.tx(async (t) => {
      await lockAccount(t, w.ownerId);
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    let finished = false;
    const pending = run(w, [{ op: "add", kind: "owner", text: "waits" }], new Map()).then((x) => {
      finished = true;
      return x;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(finished).toBe(false);
    release();
    await holder;
    expect(await pending).not.toBeNull();
  });
});

describe("undoChange", () => {
  it("restores the exact previous text and vault state of every note a change touched", async () => {
    const w = await world();
    const a = await seed(w, "owner", "alpha", { vault: false });
    const b = await seed(w, "owner", "beta", { vault: true, vaultBy: "owner", unsure: true });
    const c = await seed(w, "self", "gamma", { vault: false });
    const refs = new Map([["a", ref("owner", a)], ["b", ref("owner", b)], ["c", ref("self", c)]]);
    const r = await run(
      w,
      [{ op: "replace", ref: "a", text: "alpha 2" }, { op: "remove", ref: "b" }, { op: "lock", ref: "c" }, { op: "add", kind: "self", text: "delta" }],
      refs,
      { vaults: new Map([[vaultKey("owner", "alpha 2"), OPEN]]) },
    );
    expect(await undo(w, r!.changeId!)).toBe("undone");
    const owners = new Map((await ownerNotes(w)).map((n) => [n.id, n]));
    expect(owners.get(a)).toMatchObject({ text: "alpha", vault: false, vaultBy: "auto" });
    // The removed note is back, with its id, vault state and unsure flag.
    expect(owners.get(b)).toMatchObject({ text: "beta", vault: true, vaultBy: "owner", unsure: true });
    expect([...owners.keys()].sort()).toEqual([a, b].sort());
    // The note the change locked was open before: it is open again, with its old vault_by. The added one is gone.
    expect((await selfNotes(w)).map((n) => [n.id, n.text, n.vault, n.vaultBy])).toEqual([[c, "gamma", false, "auto"]]);
    expect((await changeRow(r!.changeId!)).status).toBe("undone");
    expect(await undo(w, r!.changeId!)).toBeNull();
  });

  it("is refused as stale when any note it touched changed since, and then changes nothing", async () => {
    const w = await world();
    const a = await seed(w, "owner", "alpha", { vault: false });
    const r1 = await run(w, [{ op: "replace", ref: "a", text: "alpha 2" }, { op: "add", kind: "owner", text: "added" }], new Map([["a", ref("owner", a)]]), {
      vaults: new Map([[vaultKey("owner", "alpha 2"), OPEN]]),
    });
    await patchNote(w, a, { text: "edited by hand" });
    expect(await undo(w, r1!.changeId!)).toBe("stale");
    expect((await ownerNotes(w)).map((n) => n.text).sort()).toEqual(["added", "edited by hand"]);
    expect((await changeRow(r1!.changeId!)).status).toBe("applied");

    const w2 = await world();
    const x = await seed(w2, "owner", "x1", { vault: false });
    const r2 = await run(w2, [{ op: "lock", ref: "x" }], new Map([["x", ref("owner", x)]]));
    await patchNote(w2, x, { vault: true });
    expect(await undo(w2, r2!.changeId!)).toBe("stale");

    const w3 = await world();
    const r3 = await run(w3, [{ op: "add", kind: "self", text: "to be deleted" }], new Map());
    await db.query("delete from agent_notes where agent_id = $1", [w3.agentId]);
    expect(await undo(w3, r3!.changeId!)).toBe("stale");

    const w4 = await world();
    const y = await seed(w4, "owner", "removed one");
    const r4 = await run(w4, [{ op: "remove", ref: "y" }], new Map([["y", ref("owner", y)]]));
    await db.query("insert into owner_notes (id, owner_id, text) values ($1, $2, 'reappeared')", [y, w4.ownerId]);
    expect(await undo(w4, r4!.changeId!)).toBe("stale");
  });

  it("restores the vault state exactly, but never opens a note that was inside before the change", async () => {
    const w = await world();
    const a = await seed(w, "owner", "open one", { vault: false, vaultBy: "owner" });
    const b = await seed(w, "owner", "locked one", { vault: true });
    const l = await seed(w, "owner", "to lock", { vault: false });
    const refs = new Map([["a", ref("owner", a)], ["b", ref("owner", b)], ["l", ref("owner", l)]]);
    // Moved into the vault by a replace, or by a lock, from outside: undo puts it back outside, as it was.
    const r = await run(w, [{ op: "replace", ref: "a", text: "now private" }, { op: "lock", ref: "l" }], refs, { vaults: new Map([[vaultKey("owner", "now private"), { vault: true, unsure: true }]]) });
    expect((await ownerNotes(w)).find((n) => n.id === a)).toMatchObject({ vault: true, vaultBy: "auto", unsure: true });
    expect(await undo(w, r!.changeId!)).toBe("undone");
    expect((await ownerNotes(w)).find((n) => n.id === a)).toMatchObject({ text: "open one", vault: false, vaultBy: "owner", unsure: false });
    expect((await ownerNotes(w)).find((n) => n.id === l)).toMatchObject({ text: "to lock", vault: false, vaultBy: "auto" });

    // A note that was inside stays inside, and a lock of one already inside gets its vault_by back.
    const r1 = await run(w, [{ op: "replace", ref: "b", text: "edited locked" }], refs, { vaults: new Map([[vaultKey("owner", "edited locked"), OPEN]]) });
    expect(await undo(w, r1!.changeId!)).toBe("undone");
    expect((await ownerNotes(w)).find((n) => n.id === b)).toMatchObject({ text: "locked one", vault: true });
    const r1b = await run(w, [{ op: "lock", ref: "b" }], refs);
    expect(await undo(w, r1b!.changeId!)).toBe("undone");
    expect((await ownerNotes(w)).find((n) => n.id === b)).toMatchObject({ vault: true, vaultBy: "auto" });

    // A vault note the owner has since moved out is stale, not restored.
    const r2 = await run(w, [{ op: "replace", ref: "b", text: "edited locked" }], refs, { vaults: new Map([[vaultKey("owner", "edited locked"), OPEN]]) });
    await patchNote(w, b, { vault: false });
    expect(await undo(w, r2!.changeId!)).toBe("stale");
    expect((await ownerNotes(w)).find((n) => n.id === b)).toMatchObject({ text: "edited locked", vault: false });

    // A removed vault note is re-inserted in the vault.
    const c = await seed(w, "self", "was locked", { vault: true });
    const r3 = await run(w, [{ op: "remove", ref: "c" }], new Map([["c", ref("self", c)]]));
    expect(await undo(w, r3!.changeId!)).toBe("undone");
    expect((await selfNotes(w)).find((n) => n.id === c)).toMatchObject({ text: "was locked", vault: true });
  });

  it("is the owner's: another owner, an unknown id, and a change that is not applied answer null", async () => {
    const w = await world();
    const r = await run(w, [{ op: "add", kind: "owner", text: "kept" }], new Map());
    expect(await db.tx(async (t) => undoChange(t, await otherOwner(w), r!.changeId!, ROOMS))).toBeNull();
    expect(await undo(w, "00000000-0000-4000-8000-000000000000")).toBeNull();
    const p = await run(w, [{ op: "add", kind: "owner", text: "pending one" }], new Map(), { status: "pending" });
    expect(await undo(w, p!.changeId!)).toBeNull();
    expect((await ownerNotes(w)).map((n) => n.text)).toEqual(["kept"]);
  });
});

describe("proposeUnlocks, confirmChange and discardChange", () => {
  it("writes one pending change for the notes still in the vault, and nothing is opened", async () => {
    const w = await world();
    const a = await seed(w, "owner", "private thing", { vault: true });
    const b = await seed(w, "self", "also private", { vault: true });
    const c = await seed(w, "owner", "already open", { vault: false });
    const id = await propose(w, [ref("owner", a), ref("self", b), ref("owner", c), ref("owner", "00000000-0000-4000-8000-000000000000")]);
    const row = await changeRow(id!);
    expect(row.status).toBe("pending");
    expect(row.ops.map((x) => [x.op, x.kind, x.noteId, x.vaultBefore, x.vaultAfter])).toEqual([
      ["unlock", "owner", a, true, false],
      ["unlock", "self", b, true, false],
    ]);
    expect((await ownerNotes(w)).map((n) => n.vault)).toEqual([true, false]);
    expect(await propose(w, [ref("owner", c)])).toBeNull();
  });

  it("confirming an unlock opens the note, by the owner: the only code that does", async () => {
    const w = await world();
    const a = await seed(w, "owner", "private thing", { vault: true, unsure: true });
    const b = await seed(w, "self", "also private", { vault: true });
    const id = await propose(w, [ref("owner", a), ref("self", b)]);
    const done = await confirm(w, id!);
    expect(Array.isArray(done) && done.map((x) => [x.op, x.noteId, x.vaultBefore, x.vaultAfter])).toEqual([
      ["unlock", a, true, false],
      ["unlock", b, true, false],
    ]);
    expect((await ownerNotes(w))[0]).toMatchObject({ vault: false, vaultBy: "owner", unsure: false });
    expect((await selfNotes(w))[0]).toMatchObject({ vault: false, vaultBy: "owner" });
    expect((await changeRow(id!)).status).toBe("applied");
    // Undoing an unlock puts the notes back in the vault (into it is always allowed).
    expect(await undo(w, id!)).toBe("undone");
    expect((await ownerNotes(w))[0]).toMatchObject({ vault: true, vaultBy: "auto", unsure: true });
  });

  it("is stale when a referenced note is gone or changed, and then applies nothing", async () => {
    const w = await world();
    const a = await seed(w, "owner", "private thing", { vault: true });
    const b = await seed(w, "owner", "other thing", { vault: true });
    const id = await propose(w, [ref("owner", b), ref("owner", a)]);
    await db.query("delete from owner_notes where id = $1", [a]);
    expect(await confirm(w, id!)).toBe("stale");
    expect((await ownerNotes(w))[0]).toMatchObject({ text: "other thing", vault: true });
    expect((await changeRow(id!)).status).toBe("discarded");

    const c = await seed(w, "owner", "text c", { vault: true });
    const id2 = await propose(w, [ref("owner", c)]);
    await db.query("update owner_notes set text = 'edited c' where id = $1", [c]);
    expect(await confirm(w, id2!)).toBe("stale");
    expect((await ownerNotes(w)).find((n) => n.id === c)!.vault).toBe(true);
  });

  it("only the owner of the change may confirm or discard it; a discarded change is over", async () => {
    const w = await world();
    const a = await seed(w, "owner", "p", { vault: true });
    const id = await propose(w, [ref("owner", a)]);
    const otherId = await otherOwner(w);
    expect(await db.tx((t) => confirmChange(t, otherId, id!, ROOMS))).toBeNull();
    expect(await db.tx((t) => discardChange(t, otherId, id!))).toBeNull();
    expect((await ownerNotes(w))[0]!.vault).toBe(true);
    expect(await db.tx((t) => discardChange(t, w.ownerId, id!))).toBe("discarded");
    expect((await changeRow(id!)).status).toBe("discarded");
    expect(await confirm(w, id!)).toBeNull();
    expect((await ownerNotes(w))[0]!.vault).toBe(true);
  });

  it("confirming the other ops of a pending change never opens a vault note; an add that does not fit makes the whole change full, pending", async () => {
    const w = await world();
    const a = await seed(w, "owner", "locked a", { vault: true });
    const r = await run(w, [{ op: "replace", ref: "a", text: "locked a2" }, { op: "add", kind: "owner", text: "q".repeat(10) }], new Map([["a", ref("owner", a)]]), {
      status: "pending",
      vaults: new Map([[vaultKey("owner", "locked a2"), OPEN], [vaultKey("owner", "q".repeat(10)), OPEN]]),
    });
    const z = await seed(w, "owner", "z".repeat(10));
    expect(await confirm(w, r!.changeId!, { ...ROOMS, owner: 25 })).toBe("full");
    expect((await ownerNotes(w)).map((n) => n.text).sort()).toEqual(["locked a", "z".repeat(10)]);
    await db.query("delete from owner_notes where id = $1", [z]);
    const done = await confirm(w, r!.changeId!, { ...ROOMS, owner: 25 });
    expect(Array.isArray(done) && done.map((x) => x.op)).toEqual(["replace", "add"]);
    expect((await ownerNotes(w)).map((n) => [n.text, n.vault]).sort()).toEqual([["locked a2", true], ["q".repeat(10), false]].sort());
  });
});

describe("the follow-up rulings", () => {
  it("undo checks the rooms: restoring a removed note into a room refilled since answers full and changes nothing", async () => {
    const w = await world();
    const rooms = { ...ROOMS, owner: 2000 };
    const big = await seed(w, "owner", "b".repeat(1900));
    const r = await run(w, [{ op: "remove", ref: "big" }], new Map([["big", ref("owner", big)]]), { rooms });
    await seed(w, "owner", "c".repeat(200));
    expect(await undo(w, r!.changeId!, rooms)).toBe("full");
    expect((await ownerNotes(w)).map((n) => n.text.length)).toEqual([200]);
    expect((await changeRow(r!.changeId!)).status).toBe("applied");
    await db.query("delete from owner_notes where owner_id = $1", [w.ownerId]);
    expect(await undo(w, r!.changeId!, rooms)).toBe("undone");
    expect((await ownerNotes(w)).map((n) => n.id)).toEqual([big]);
    // Undoing a replace that shrank a note is checked the same way.
    const w2 = await world();
    const x = await seed(w2, "self", "x".repeat(100));
    const r2 = await run(w2, [{ op: "replace", ref: "x", text: "y".repeat(10) }], new Map([["x", ref("self", x)]]), { vaults: new Map([[vaultKey("self", "y".repeat(10)), OPEN]]) });
    await seed(w2, "self", "z".repeat(2950));
    expect(await undo(w2, r2!.changeId!, { ...ROOMS, self: 3000 })).toBe("full");
    expect((await selfNotes(w2)).find((n) => n.id === x)!.text).toBe("y".repeat(10));
  });

  it("a text with control characters or a lone surrogate applies cleanly, without them", async () => {
    const w = await world();
    const a = await seed(w, "owner", "old", { vault: false });
    const r = await run(
      w,
      [{ op: "add", kind: "owner", text: "likes\u0000tea" }, { op: "add", kind: "self", text: "a\ud800b\u0007" }, { op: "replace", ref: "a", text: "new\u0000er" }],
      new Map([["a", ref("owner", a)]]),
      { vaults: new Map([[vaultKey("owner", "newer"), OPEN]]) },
    );
    expect(r!.applied.map((x) => x.after)).toEqual(["newer", "likestea", "ab"]);
    expect((await ownerNotes(w)).map((n) => n.text).sort()).toEqual(["likestea", "newer"]);
    expect((await selfNotes(w)).map((n) => n.text)).toEqual(["ab"]);
  });

  it("deleting a note by the route waits for the room lock, as every write does", async () => {
    const w = await world();
    const a = await seed(w, "owner", "to delete");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = db.tx(async (t) => {
      await lockRoom(t, { kind: "owner", ownerId: w.ownerId });
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    let finished = false;
    const pending = api(app, { cookie: w.cookie }, "DELETE", `/api/memory/notes/${a}`).then((x) => {
      finished = true;
      return x;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(finished).toBe(false);
    release();
    await holder;
    expect((await pending).status).toBe(200);
    expect(await ownerNotes(w)).toEqual([]);
  });

  it("subtracts the removes before judging a replace's growth, whatever the order of the ops", async () => {
    const w = await world();
    const a = await seed(w, "owner", "a".repeat(10));
    const b = await seed(w, "owner", "b".repeat(10));
    const refs = new Map([["a", ref("owner", a)], ["b", ref("owner", b)]]);
    const r = await run(w, [{ op: "replace", ref: "a", text: "c".repeat(20) }, { op: "remove", ref: "b" }], refs, {
      rooms: { ...ROOMS, owner: 25 },
      vaults: new Map([[vaultKey("owner", "c".repeat(20)), OPEN]]),
    });
    expect(r!.full).toBe(false);
    expect(r!.applied.map((x) => x.op).sort()).toEqual(["remove", "replace"]);
    expect((await ownerNotes(w)).map((n) => n.text)).toEqual(["c".repeat(20)]);
  });

  it("does nothing for an Agent that is not the owner's", async () => {
    const w = await world();
    const stranger = await world();
    const bad = { ...w, agentId: stranger.agentId };
    const r = await run(bad, [{ op: "add", kind: "owner", text: "sneaky" }], new Map());
    expect(r).toBeNull();
    const a = await seed(w, "owner", "p", { vault: true });
    expect(await propose(bad, [ref("owner", a)])).toBeNull();
    expect(await ownerNotes(w)).toHaveLength(1);
    expect((await db.query("select count(*)::int as n from memory_changes")).rows[0].n).toBe(0);
  });

  it("lists the notes a change adds in the order of its ops", async () => {
    const w = await world();
    const texts = ["fact one", "fact two", "fact three", "fact four", "fact five"];
    await run(w, texts.map((text): Op => ({ op: "add", kind: "owner", text })), new Map());
    expect((await ownerNotes(w)).map((n) => n.text)).toEqual(texts);
  });
});

describe("fix round 2", () => {
  it("a held merge confirms cleanly when its net effect fits, whatever the order of its ops", async () => {
    const w = await world();
    const a = await seed(w, "owner", "a".repeat(10));
    const b = await seed(w, "owner", "b".repeat(10));
    const refs = new Map([["a", ref("owner", a)], ["b", ref("owner", b)]]);
    const r = await run(w, [{ op: "replace", ref: "a", text: "c".repeat(20) }, { op: "remove", ref: "b" }], refs, {
      status: "pending",
      vaults: new Map([[vaultKey("owner", "c".repeat(20)), OPEN]]),
    });
    const done = await confirm(w, r!.changeId!, { ...ROOMS, owner: 25 });
    expect(Array.isArray(done) && done.map((x) => x.op).sort()).toEqual(["remove", "replace"]);
    expect((await ownerNotes(w)).map((n) => n.text)).toEqual(["c".repeat(20)]);
  });

  it("a held change whose net effect does not fit answers full, writes nothing and stays pending; it confirms once there is room", async () => {
    const w = await world();
    const a = await seed(w, "owner", "a".repeat(10));
    const b = await seed(w, "owner", "b".repeat(10));
    const refs = new Map([["a", ref("owner", a)], ["b", ref("owner", b)]]);
    const r = await run(w, [{ op: "replace", ref: "a", text: "c".repeat(30) }, { op: "remove", ref: "b" }], refs, {
      status: "pending",
      vaults: new Map([[vaultKey("owner", "c".repeat(30)), OPEN]]),
    });
    const e = await seed(w, "owner", "e".repeat(10));
    const rooms = { ...ROOMS, owner: 35 };
    expect(await confirm(w, r!.changeId!, rooms)).toBe("full");
    expect((await ownerNotes(w)).map((n) => n.text).sort()).toEqual(["a".repeat(10), "b".repeat(10), "e".repeat(10)]);
    expect((await changeRow(r!.changeId!)).status).toBe("pending");
    await db.query("delete from owner_notes where id = $1", [e]);
    const done = await confirm(w, r!.changeId!, rooms);
    expect(Array.isArray(done) && done.map((x) => x.op).sort()).toEqual(["remove", "replace"]);
    expect((await ownerNotes(w)).map((n) => n.text)).toEqual(["c".repeat(30)]);
    expect((await changeRow(r!.changeId!)).status).toBe("applied");
  });

  it("applyOps judges a change by its net effect: a growing replace listed before a shrinking one is kept", async () => {
    const w = await world();
    const a = await seed(w, "owner", "a".repeat(10));
    const b = await seed(w, "owner", "b".repeat(20));
    const refs = new Map([["a", ref("owner", a)], ["b", ref("owner", b)]]);
    const r = await run(w, [{ op: "replace", ref: "a", text: "c".repeat(20) }, { op: "replace", ref: "b", text: "d".repeat(10) }], refs, {
      rooms: { ...ROOMS, owner: 35 },
      vaults: new Map([[vaultKey("owner", "c".repeat(20)), OPEN], [vaultKey("owner", "d".repeat(10)), OPEN]]),
    });
    expect(r!.full).toBe(false);
    expect(r!.applied).toHaveLength(2);
  });

  it("a verdict is for a kind: the same text sorted open for self and into the vault for owner is told apart, for adds and replaces", async () => {
    const w = await world();
    const text = "shared words";
    const vaults = new Map([[vaultKey("self", text), OPEN], [vaultKey("owner", text), { vault: true, unsure: false }]]);
    await run(w, [{ op: "add", kind: "owner", text }, { op: "add", kind: "self", text }], new Map(), { vaults });
    expect((await ownerNotes(w))[0]).toMatchObject({ vault: true, unsure: false });
    expect((await selfNotes(w))[0]).toMatchObject({ vault: false, unsure: false });
    const o = await seed(w, "owner", "old o", { vault: false });
    const s = await seed(w, "self", "old s", { vault: false });
    await run(w, [{ op: "replace", ref: "o", text: "another text" }, { op: "replace", ref: "s", text: "another text" }], new Map([["o", ref("owner", o)], ["s", ref("self", s)]]), {
      vaults: new Map([[vaultKey("self", "another text"), OPEN], [vaultKey("owner", "another text"), { vault: true, unsure: false }]]),
    });
    expect((await ownerNotes(w)).find((n) => n.id === o)).toMatchObject({ vault: true });
    expect((await selfNotes(w)).find((n) => n.id === s)).toMatchObject({ vault: false });
  });

  it("a note gets the same created_at and updated_at; a removed note comes back at its exact time, so the order survives", async () => {
    const w = await world();
    const texts = Array.from({ length: 8 }, (_, i) => `fact number ${i}`);
    await run(w, texts.map((text): Op => ({ op: "add", kind: "owner", text })), new Map());
    expect((await db.query("select count(*)::int as n from owner_notes where created_at <> updated_at")).rows[0].n).toBe(0);
    const before = (await ownerNotes(w)).map((n) => n.id);
    const refs = new Map(before.map((id, i) => [`n${i}`, ref("owner", id)]));
    const r = await run(w, [1, 2, 3, 4, 5, 6].map((i): Op => ({ op: "remove", ref: `n${i}` })), refs);
    expect(await undo(w, r!.changeId!)).toBe("undone");
    expect((await ownerNotes(w)).map((n) => n.id)).toEqual(before);
    expect((await ownerNotes(w)).map((n) => n.text)).toEqual(texts);
  });

  it("undo is stale when the owner changed the unsure flag since: an owner's own lock after the model's makes it not undoable", async () => {
    const w = await world();
    const a = await seed(w, "owner", "lock me", { vault: false, unsure: true });
    const r = await run(w, [{ op: "lock", ref: "a" }], new Map([["a", ref("owner", a)]]));
    expect((await ownerNotes(w))[0]).toMatchObject({ vault: true, vaultBy: "owner", unsure: true });
    await patchNote(w, a, { vault: true });
    expect(await undo(w, r!.changeId!)).toBe("stale");
    expect((await ownerNotes(w))[0]).toMatchObject({ vault: true, vaultBy: "owner", unsure: false });
  });
});

describe("fix round 3", () => {
  const lockedByModel = async (w: World) => {
    const a = await seed(w, "owner", "lock me", { vault: false });
    const r = await run(w, [{ op: "lock", ref: "a" }], new Map([["a", ref("owner", a)]]));
    return { a, r };
  };

  it("the owner's own lock after the model's, through the route, makes the model's lock not undoable", async () => {
    const w = await world();
    const { a, r } = await lockedByModel(w);
    const res = await api(app, { cookie: w.cookie }, "PATCH", `/api/memory/notes/${a}`, { vault: true });
    expect(res.status).toBe(200);
    expect(await undo(w, r!.changeId!)).toBe("stale");
    expect((await ownerNotes(w))[0]).toMatchObject({ vault: true, vaultBy: "owner" });
    expect((await changeRow(r!.changeId!)).status).toBe("applied");
  });

  it("with nothing else done, the model's lock is undone and the note is open again; the recorded times are exact UTC text", async () => {
    const w = await world();
    const { r } = await lockedByModel(w);
    const op = (await changeRow(r!.changeId!)).ops[0]!;
    for (const key of ["updatedAtBefore", "updatedAtAfter"]) expect(op[key]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    expect(await undo(w, r!.changeId!)).toBe("undone");
    expect((await ownerNotes(w))[0]).toMatchObject({ vault: false, vaultBy: "auto" });
  });

  it("a held change is stale after the owner edits the note and edits it back to the same text", async () => {
    const w = await world();
    const a = await seed(w, "owner", "original words", { vault: true });
    const id = await propose(w, [ref("owner", a)]);
    for (const text of ["changed words", "original words"]) {
      expect((await api(app, { cookie: w.cookie }, "PATCH", `/api/memory/notes/${a}`, { text })).status).toBe(200);
    }
    expect((await ownerNotes(w))[0]).toMatchObject({ text: "original words", vault: true });
    expect(await confirm(w, id!)).toBe("stale");
    expect((await ownerNotes(w))[0]!.vault).toBe(true);
    expect((await changeRow(id!)).status).toBe("discarded");
  });

  it("growth is judged in op order across adds and replaces together", async () => {
    const w = await world();
    const a = await seed(w, "owner", "a".repeat(10));
    const r = await run(w, [{ op: "add", kind: "owner", text: "n".repeat(10) }, { op: "replace", ref: "a", text: "c".repeat(20) }], new Map([["a", ref("owner", a)]]), {
      rooms: { ...ROOMS, owner: 25 },
      vaults: new Map([[vaultKey("owner", "c".repeat(20)), OPEN]]),
    });
    expect(r!.full).toBe(true);
    expect(r!.applied.map((x) => x.op)).toEqual(["add"]);
    expect((await ownerNotes(w)).map((n) => n.text).sort()).toEqual(["a".repeat(10), "n".repeat(10)]);
  });
});

describe("undo walks back through changes to one note", () => {
  const twoChanges = async () => {
    const w = await world();
    const n = await seed(w, "owner", "version zero", { vault: false });
    const refs = new Map([["n", ref("owner", n)]]);
    const open = (text: string) => new Map([[vaultKey("owner", text), OPEN]]);
    const r1 = await run(w, [{ op: "replace", ref: "n", text: "version one" }], refs, { vaults: open("version one") });
    const r2 = await run(w, [{ op: "replace", ref: "n", text: "version two" }], refs, { vaults: open("version two") });
    return { w, n, r1: r1!.changeId!, r2: r2!.changeId! };
  };

  it("undoing newest first works, ends with the original text, and both changes are undone", async () => {
    const { w, r1, r2 } = await twoChanges();
    expect(await undo(w, r2)).toBe("undone");
    expect((await ownerNotes(w))[0]!.text).toBe("version one");
    expect(await undo(w, r1)).toBe("undone");
    expect((await ownerNotes(w))[0]).toMatchObject({ text: "version zero", vault: false });
    expect((await changeRow(r1)).status).toBe("undone");
    expect((await changeRow(r2)).status).toBe("undone");
  });

  it("undoing in the wrong order is stale, and so is the second undo after an owner edit in between", async () => {
    const { w, n, r1, r2 } = await twoChanges();
    expect(await undo(w, r1)).toBe("stale");
    expect(await undo(w, r2)).toBe("undone");
    await patchNote(w, n, { text: "edited between" });
    expect(await undo(w, r1)).toBe("stale");
    expect((await ownerNotes(w))[0]!.text).toBe("edited between");
  });

  it("a removed note comes back with the updated_at it had, so an earlier change to it can still be undone", async () => {
    const w = await world();
    const n = await seed(w, "owner", "before");
    const refs = new Map([["n", ref("owner", n)]]);
    const r1 = await run(w, [{ op: "replace", ref: "n", text: "after" }], refs);
    const r2 = await run(w, [{ op: "remove", ref: "n" }], refs);
    expect(await undo(w, r2!.changeId!)).toBe("undone");
    expect(await undo(w, r1!.changeId!)).toBe("undone");
    expect((await ownerNotes(w))[0]).toMatchObject({ id: n, text: "before" });
  });
});

describe("a note keeps its origin conversation only while all its content came from there", () => {
  async function inGroup() {
    const w = await world();
    const mia = await signUp(app, `ap_mia${w.n}`);
    const g = await group(app, mia, "群", [w.actor, await signUp(app, `ap_ned${w.n}`)]);
    return { w, g };
  }
  const setOrigin = (kind: NoteKind, id: string, conv: string) =>
    db.query(`update ${kind === "owner" ? "owner_notes" : "agent_notes"} set origin_conversation_id = $2 where id = $1`, [id, conv]);
  const agentOf = (w: World) => ({ id: w.agentId, ownerId: w.ownerId, memory: true, sharedNotes: true });
  const shownIn = async (w: World, conv: string, group: boolean): Promise<string[]> => {
    const shown = await notesFor(db, agentOf(w), { conversationId: conv, group });
    return [...shown.owner, ...shown.self].map((n) => n.text).sort();
  };

  it("a review in another conversation that replaces a vault note which began in a group takes it out of that group's view; in its own conversation the owner still has it", async () => {
    const { w, g } = await inGroup();
    const a = await seed(w, "owner", "喝茶", { vault: true });
    await setOrigin("owner", a, g);
    expect(await shownIn(w, g, true)).toEqual(["喝茶"]);
    await run(w, [{ op: "replace", ref: "a", text: "喝茶，私下里还说过胃不好" }], new Map([["a", ref("owner", a)]]), { vaults: new Map([[vaultKey("owner", "喝茶，私下里还说过胃不好"), { vault: true, unsure: false }]]) });
    expect(await shownIn(w, g, true)).toEqual([]);
    expect(await shownIn(w, w.conv, false)).toEqual(["喝茶，私下里还说过胃不好"]);
    expect((await ownerNotes(w))[0]).toMatchObject({ originConversationId: null, vault: true });
  });

  it("a replace written from the note's own conversation keeps the origin", async () => {
    const { w, g } = await inGroup();
    const a = await seed(w, "owner", "喝茶", { vault: true });
    await setOrigin("owner", a, g);
    await db.tx((t) =>
      applyOps(t, { ownerId: w.ownerId, agentId: w.agentId, sharedNotes: true, kinds: BOTH }, [{ op: "replace", ref: "a", text: "喝绿茶" }], new Map([["a", ref("owner", a)]]), {
        conversationId: w.conv,
        originConversationId: g,
        status: "applied",
        vaults: new Map(),
        duplicates: new Set(),
        rooms: ROOMS,
      }),
    );
    expect(await shownIn(w, g, true)).toEqual(["喝绿茶"]);
  });

  it("undo brings the origin back exactly", async () => {
    const { w, g } = await inGroup();
    const a = await seed(w, "owner", "喝茶", { vault: true });
    await setOrigin("owner", a, g);
    const r = await run(w, [{ op: "replace", ref: "a", text: "喝茶，胃不好" }], new Map([["a", ref("owner", a)]]));
    expect((await ownerNotes(w))[0]!.originConversationId).toBeNull();
    expect(await undo(w, r!.changeId!)).toBe("undone");
    expect((await ownerNotes(w))[0]).toMatchObject({ text: "喝茶", originConversationId: g });
    expect(await shownIn(w, g, true)).toEqual(["喝茶"]);
  });

  it("an owner's text edit in the palace clears the origin of that note; a vault-only patch does not", async () => {
    const { w, g } = await inGroup();
    const a = await seed(w, "owner", "喝茶", { vault: true });
    const b = await seed(w, "self", "说话简短", { vault: true });
    await setOrigin("owner", a, g);
    await setOrigin("self", b, g);
    await patchNote(w, a, { vault: true });
    expect(await shownIn(w, g, true)).toEqual(["喝茶", "说话简短"]);
    await patchNote(w, a, { text: "喝茶，其实是怕失眠" });
    expect(await shownIn(w, g, true)).toEqual(["说话简短"]);
    expect((await ownerNotes(w))[0]).toMatchObject({ originConversationId: null });
    const res = await api(app, { cookie: w.cookie }, "PATCH", `/api/agents/${w.agentId}/memory/notes/${b}`, { text: "说话简短，先说结论" });
    expect(res.status).toBe(200);
    expect(await shownIn(w, g, true)).toEqual([]);
  });
});
