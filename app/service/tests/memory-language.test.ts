import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOwnedAgent } from "../src/agents/store.ts";
import { languageRule, MEMORY_LANGUAGES, MEMORY_LANGUAGE_CODES } from "../src/memory/language.ts";
import { reviewInput } from "../src/memory/review.ts";
import { weight } from "../src/memory/weight.ts";
import { siteDay } from "../src/accounts/store.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedJudge, type ScriptedAnswers } from "./helpers/judge.ts";
import { FAST, flagHelpers, JUDGE, MIN, PERSONA, textOf } from "./helpers/memory-flags.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * One language for the palace (src/memory/language.ts; README "An Agent's memory", `PATCH /api/me` `memoryLanguage`,
 * `POST /api/memory/language/convert`): the three prompts that write notes carry one shared sentence about the language, and
 * the owner's existing notes can be restated in the chosen one through the dream's own rewrite path.
 */

const gateway = scriptedGateway();
const judge = scriptedJudge();
const { app, db, clock } = useApp({ env: SITE_ENV, models: gateway, judge, agentWorker: false, memory: true, config: { judge: JUDGE } });
const { memory, say, world, flag, wake } = flagHelpers({ app, db, clock, gateway });

const HOUR = 60 * MIN;
const AUTO = "用和已有笔记相同的语言写；还没有笔记时，用主人在这段对话里说话的语言。";
const KEEP = "人名、地名、店名、专有名词和原话引用保留原文，不要翻译。表示程度或语气、换一种语言容易走样的说法（比如“ちょっと苦手”），保留原文并在后面用括号简短说明。";

let first = 0;
beforeEach(async () => {
  clock.reset();
  first = gateway.calls.length;
  judge.calls.splice(0);
  judge.answer(() => ({ sort: 0.95, faithful: 0.9 }));
  // The dream sweep is armed once at start (`resume`); the clock was reset above, which forgot its timer.
  await memory().resume();
});
afterEach(async () => {
  await closeAllSockets();
  await memory().idle();
  expect(gateway.pending()).toBe(0);
});

const setLanguage = (who: Actor, memoryLanguage: unknown) => api(app, who, "PATCH", "/api/me", { memoryLanguage });
const me = async (who: Actor) => (await api(app, who, "GET", "/api/me")).json;
const callsOf = (marker: string) => gateway.calls.slice(first).filter((c) => c.system.includes(marker));
const ops = (...o: unknown[]) => JSON.stringify({ ops: o });
const seeded = async (who: Actor, agentId: string, text: string, vault: boolean, kind: "owner" | "self" = "owner") =>
  (await api(app, who, "POST", kind === "owner" ? "/api/memory/notes" : `/api/agents/${agentId}/memory/notes`, { text, vault })).json;
const ownerTexts = async (ownerId: string) => (await db.query("select text, vault from owner_notes where owner_id = $1 order by created_at, id", [ownerId])).rows;
const messagesOf = async (who: Actor, conv: string): Promise<any[]> => (await api(app, who, "GET", `/api/conversations/${conv}/messages`)).json.messages;

describe("the list", () => {
  it("is exactly these fourteen codes, each with its own name; the one table the web mirrors", () => {
    expect(Object.entries(MEMORY_LANGUAGES)).toEqual([
      ["zh-Hans", "简体中文"],
      ["zh-Hant", "繁體中文"],
      ["ja", "日本語"],
      ["en", "English"],
      ["ko", "한국어"],
      ["fr", "Français"],
      ["de", "Deutsch"],
      ["es", "Español"],
      ["pt", "Português"],
      ["ru", "Русский"],
      ["it", "Italiano"],
      ["vi", "Tiếng Việt"],
      ["th", "ไทย"],
      ["id", "Bahasa Indonesia"],
    ]);
    expect([...MEMORY_LANGUAGE_CODES]).toEqual(Object.keys(MEMORY_LANGUAGES));
  });

  it("the shared sentence: automatic by default, the language's own name when chosen, then always the same keeping rule", () => {
    expect(languageRule(null)).toBe(AUTO + KEEP);
    expect(languageRule("ja")).toBe(`一律用日本語写。${KEEP}`);
    expect(languageRule("zh-Hant")).toBe(`一律用繁體中文写。${KEEP}`);
  });
});

describe("the setting", () => {
  it("is null until chosen, is set and cleared by PATCH /api/me and read back by GET /api/me", async () => {
    const owner = await signUp(app, "lgset");
    expect((await me(owner)).memoryLanguage).toBeNull();
    const set = await setLanguage(owner, "ja");
    expect(set.status).toBe(200);
    expect((await me(owner)).memoryLanguage).toBe("ja");
    expect((await setLanguage(owner, null)).status).toBe(200);
    expect((await me(owner)).memoryLanguage).toBeNull();
    for (const code of MEMORY_LANGUAGE_CODES) expect([code, (await setLanguage(owner, code)).status]).toEqual([code, 200]);
  });

  it("an invalid code is rejected and changes nothing", async () => {
    const owner = await signUp(app, "lgbad");
    await setLanguage(owner, "en");
    for (const bad of ["xx", "EN", "zh", "", 5, true, {}]) {
      const r = await setLanguage(owner, bad);
      expect([bad, r.status, r.json.error]).toEqual([bad, 400, "invalid_request"]);
    }
    expect((await me(owner)).memoryLanguage).toBe("en");
  });

  it("is written with the other fields or not at all", async () => {
    const owner = await signUp(app, "lgall");
    const refused = await api(app, owner, "PATCH", "/api/me", { memoryLanguage: "fr", memoryModel: { source: "site", id: "no-such-model" } });
    expect(refused.status).toBe(400);
    expect((await me(owner)).memoryLanguage).toBeNull();
    const refusedName = await api(app, owner, "PATCH", "/api/me", { memoryLanguage: "fr", displayName: "" });
    expect(refusedName.status).toBe(400);
    expect((await me(owner)).memoryLanguage).toBeNull();
    const both = await api(app, owner, "PATCH", "/api/me", { memoryLanguage: "fr", dream: false });
    expect(both.status).toBe(200);
    expect(await me(owner)).toMatchObject({ memoryLanguage: "fr", dream: false });
  });
});

describe("the review's system text", () => {
  async function review(tag: string, language: string | null, group = false) {
    const w = await world(tag);
    if (language !== null) expect((await setLanguage(w.owner, language)).status).toBe(200);
    const agent = (await readOwnedAgent(db, w.owner.id, w.agent.id))!;
    const conv = group ? w.g : w.agent.conversationId;
    await say(w.owner, conv, "我喜欢茶");
    const input = await reviewInput(db, agent, conv, 0, { kinds: new Set(["owner", "self"]), config: app.deps.config, now: new Date() });
    return input!.system;
  }

  it("carries the automatic sentence by default and no old wording about translating", async () => {
    const system = await review("rva", null);
    expect(system).toContain(AUTO + KEEP);
    expect(system).not.toContain("用主人说这句话时的语言记，不要翻译");
  });

  it("carries the chosen language when one is set, and not the automatic sentence", async () => {
    const system = await review("rvb", "ja");
    expect(system).toContain(`一律用日本語写。${KEEP}`);
    expect(system).not.toContain(AUTO);
  });

  it("a group's review carries it too", async () => {
    expect(await review("rvc", null, true)).toContain(AUTO + KEEP);
    expect(await review("rvd", "de", true)).toContain(`一律用Deutsch写。${KEEP}`);
  });

  it("tells a mistaken note from a changed fact, and speaks only of the operations there are", async () => {
    const system = await review("rve", null);
    expect(system).toContain(
      "主人说之前记错了、不是那样（“不是周三，是周四”）：用 replace 把那一条改成对的，错的内容不要留下，也不要写成“以前……”。只有事情真的变了（以前确实是那样，现在换了）才写成“现在…（以前…，YYYY 年 M 月改的）”。",
    );
    expect(system).toContain("用 replace 合成一条，再用 remove 去掉多出来的");
    expect(system).not.toContain("merge");
    expect(system).not.toContain("旧的不留");
    expect(system).toContain('{"op":"add","kind":"owner","text":"…"}');
    expect(system).toContain('{"op":"add","kind":"self","text":"…"}');
  });
});

describe("the hearsay's system text", () => {
  async function heardSystem(tag: string, language: string | null): Promise<string> {
    const w = await world(tag);
    if (language !== null) expect((await setLanguage(w.owner, language)).status).toBe(200);
    const seq = await say(w.mia, w.g, "小李下周要去北京出差");
    gateway.reply(JSON.stringify({ entries: [], drop: [] }));
    await flag(w.agent.id, w.g, seq, "hearsay");
    await wake();
    const [call] = callsOf("听说整理员");
    return call!.system;
  }

  it("carries the automatic sentence by default", async () => {
    const system = await heardSystem("hsa", null);
    expect(system).toContain(AUTO + KEEP);
    expect(system).not.toContain("用对方说这句话时的语言");
  });

  it("carries the chosen language when one is set", async () => {
    const system = await heardSystem("hsb", "ko");
    expect(system).toContain(`一律用한국어写。${KEEP}`);
    expect(system).not.toContain(AUTO);
  });
});

describe("the dream's system text", () => {
  const dreamAnswer = ops();
  async function dreamSystem(tag: string, language: string | null): Promise<string> {
    const owner = await signUp(app, tag);
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    if (language !== null) expect((await setLanguage(owner, language)).status).toBe(200);
    await seeded(owner, agent.id, "喜欢喝茶", false);
    gateway.reply(dreamAnswer);
    clock.advance(3 * HOUR + MIN);
    await memory().idle();
    const [call] = callsOf("梦中整理员");
    return call!.system;
  }

  it("carries the automatic sentence by default, and says nothing of converting", async () => {
    const system = await dreamSystem("dsa", null);
    expect(system).toContain(AUTO + KEEP);
    expect(system).not.toContain("用 rewrite 改写成");
    expect(system).not.toContain("最多改 8 条");
  });

  it("carries the chosen language, and asks it to convert at most 8 notes that are not in it", async () => {
    const system = await dreamSystem("dsb", "fr");
    expect(system).toContain(`一律用Français写。${KEEP}`);
    expect(system).not.toContain(AUTO);
    expect(system).toContain("用 rewrite 改写成Français");
    expect(system).toContain("最多改 8 条");
  });
});

describe("converting the existing notes", () => {
  const convertCalls = () => callsOf("笔记语言整理员");
  const rewrite = (ref: string, text: string) => ({ op: "rewrite", ref, text });
  const convert = (who: Actor) => api(app, who, "POST", "/api/memory/language/convert");
  /** The judge finds a result faithful unless it holds the word INVENTED; sorting answers harmless. */
  const faithfulUnlessInvented = (state: string, qs: ReadonlyArray<{ key: string }>): ScriptedAnswers => (qs[0]!.key === "faithful" ? { faithful: state.includes("INVENTED") ? 0.1 : 0.9 } : { sort: 0.95 });

  it("is refused 409 no_language while the setting is automatic, and for anyone who is not signed in", async () => {
    const owner = await signUp(app, "cv0");
    const r = await convert(owner);
    expect([r.status, r.json.error]).toEqual([409, "no_language"]);
    expect(convertCalls()).toHaveLength(0);
    const anon = await app.inject({ method: "POST", url: "/api/memory/language/convert" });
    expect(anon.statusCode).toBe(401);
  });

  it("one call per room that has notes; a rewrite applies only when the judge finds it faithful; one undoable change per room; the vault, hearsay and a co-member are untouched", async () => {
    const w = await world("cv1");
    const empty = await mustCreateAgent(app, w.owner, { handle: "cv1_empty", name: "cv1_empty", model: FAST, persona: PERSONA });
    expect(empty.id).not.toBe(w.agent.id);
    const tea = await seeded(w.owner, w.agent.id, "喜欢喝茶", false);
    const allergy = await seeded(w.owner, w.agent.id, "对花生过敏", true);
    const spicy = await seeded(w.owner, w.agent.id, "爱吃辣", false);
    await seeded(w.owner, w.agent.id, "回答要简短", false, "self");
    await db.query("insert into agent_hearsay (agent_id, conversation_id, speaker_id, speaker_name, text, said_at) values ($1, $2, $3, 'miacv1', '主人喜欢咖啡', now())", [w.agent.id, w.g, w.mia.id]);
    const groupBefore = (await messagesOf(w.mia, w.g)).length;
    expect((await setLanguage(w.owner, "en")).status).toBe(200);
    judge.answer(faithfulUnlessInvented);
    gateway.reply(ops(rewrite("n1", "Likes tea"), rewrite("n2", "Allergic to peanuts"), rewrite("n3", "Eats spicy food and INVENTED a debt")));
    gateway.reply(ops(rewrite("n1", "Keep answers short")));

    const done = await convert(w.owner);
    expect([done.status, done.json]).toEqual([200, { rooms: 2, converted: 3, kept: 1, noRoom: 0, failedRooms: 0 }]);

    const calls = convertCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.system).toContain("一律用English写。");
    expect(calls[0]!.system).toContain(KEEP);
    expect(JSON.parse(textOf(calls[0]!))).toEqual({
      notes: [
        { ref: "n1", text: "喜欢喝茶" },
        { ref: "n2", text: "对花生过敏" },
        { ref: "n3", text: "爱吃辣" },
      ],
    });
    expect(JSON.parse(textOf(calls[1]!))).toEqual({ notes: [{ ref: "n1", text: "回答要简短" }] });
    expect(await ownerTexts(w.owner.id)).toEqual([
      { text: "Likes tea", vault: false },
      { text: "Allergic to peanuts", vault: true },
      { text: "爱吃辣", vault: false },
    ]);
    expect((await db.query("select text from agent_notes where agent_id = $1", [w.agent.id])).rows).toEqual([{ text: "Keep answers short" }]);
    expect((await db.query("select text from agent_hearsay where agent_id = $1", [w.agent.id])).rows).toEqual([{ text: "主人喜欢咖啡" }]);

    // One audited change per room, of the dream's phase; the memory calls are the owner's.
    const changes = (await db.query("select id, agent_id, status, phase, ops from memory_changes where owner_id = $1 order by created_at", [w.owner.id])).rows;
    expect(changes.map((c) => [c.status, c.phase, c.ops.map((o: any) => o.op)])).toEqual([
      ["applied", "dream", ["replace", "replace"]],
      ["applied", "dream", ["replace"]],
    ]);
    expect((await db.query("select count(*)::int as n from agent_runs where owner_id = $1 and purpose = 'memory'", [w.owner.id])).rows[0].n).toBe(2);
    const notices = [...(await messagesOf(w.owner, w.agent.conversationId)), ...(await messagesOf(w.owner, empty.conversationId))].filter((m) => m.system?.event === "memory_changed");
    expect(notices.map((m) => [m.system.phase, m.system.lines])).toEqual(
      expect.arrayContaining([
        ["dream", ["改成了：Likes tea", "改成了：Allergic to peanuts"]],
        ["dream", ["改成了：Keep answers short"]],
      ]),
    );

    // Nothing for anyone else: the group got no message, and a co-member's own call finds nothing to do.
    expect((await messagesOf(w.mia, w.g)).length).toBe(groupBefore);
    expect((await messagesOf(w.mia, w.g)).filter((m) => m.system?.event === "memory_changed")).toEqual([]);
    expect((await convert(w.mia)).json.error).toBe("no_language");

    // Undoing a room's change gives the notes back as they were.
    const ownerChange = changes[0]!;
    const undone = await api(app, w.owner, "POST", `/api/agents/${ownerChange.agent_id}/memory/changes/${ownerChange.id}/undo`);
    expect([undone.status, undone.json]).toEqual([200, { status: "undone" }]);
    expect(await ownerTexts(w.owner.id)).toEqual([
      { text: "喜欢喝茶", vault: false },
      { text: "对花生过敏", vault: true },
      { text: "爱吃辣", vault: false },
    ]);
    expect(tea.id).toBeTruthy();
    expect(allergy.id).toBeTruthy();
    expect(spicy.id).toBeTruthy();
  });

  it("a room whose answer cannot be used is a failed room (not counted as kept), an owner with no notes counts nothing: 200 and nothing changed", async () => {
    const owner = await signUp(app, "cv2");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    expect((await setLanguage(owner, "ja")).status).toBe(200);
    expect((await convert(owner)).json).toEqual({ rooms: 0, converted: 0, kept: 0, noRoom: 0, failedRooms: 0 });
    await seeded(owner, agent.id, "喜欢喝茶", false);
    gateway.reply("not json at all");
    expect((await convert(owner)).json).toEqual({ rooms: 1, converted: 0, kept: 0, noRoom: 0, failedRooms: 1 });
    expect(await ownerTexts(owner.id)).toEqual([{ text: "喜欢喝茶", vault: false }]);
    expect((await db.query("select count(*)::int as n from memory_changes where owner_id = $1", [owner.id])).rows[0].n).toBe(0);
  });

  it("is 409 busy while a conversion or a dream of that owner is under way", async () => {
    const owner = await signUp(app, "cv3");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    await seeded(owner, agent.id, "喜欢喝茶", false);
    expect((await setLanguage(owner, "en")).status).toBe(200);
    const hold = gateway.hang();
    const running = convert(owner);
    const called = await hold.reached;
    expect(called.system).toContain("笔记语言整理员");
    const second = await convert(owner);
    expect([second.status, second.json.error]).toEqual([409, "busy"]);
    hold.release(ops(rewrite("n1", "Likes tea")));
    expect((await running).json).toEqual({ rooms: 1, converted: 1, kept: 0, noRoom: 0, failedRooms: 0 });

    // A dream under way.
    const dreaming = gateway.hang();
    await seeded(owner, agent.id, "爱喝咖啡", false);
    clock.advance(3 * HOUR + MIN);
    const dreamCall = await dreaming.reached;
    expect(dreamCall.system).toContain("梦中整理员");
    const during = await convert(owner);
    expect([during.status, during.json.error]).toEqual([409, "busy"]);
    dreaming.release(ops());
    await memory().idle();
  });
});


describe("a conversion changes the language and nothing else, and says what it could not do", () => {
  const rewrite = (ref: string, text: string) => ({ op: "rewrite", ref, text });
  const convert = (who: Actor) => api(app, who, "POST", "/api/memory/language/convert");
  const rows = async (ownerId: string) => (await db.query("select text, vault, vault_by, unsure, origin_conversation_id from owner_notes where owner_id = $1 order by created_at, id", [ownerId])).rows;
  const faithfulOnly = (_s: string, qs: ReadonlyArray<{ key: string }>): ScriptedAnswers => (qs[0]!.key === "faithful" ? { faithful: 0.9 } : { sort: 0.05 });

  it("keeps every note's vault, vault_by and unsure exactly as they are, and asks the judge only the faithful question", async () => {
    const owner = await signUp(app, "cf1");
    await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    for (const [text, vault, by, unsure] of [["喜欢喝茶", false, "auto", false], ["爱吃辣", false, "owner", false], ["对花生过敏", true, "auto", true], ["住在上海", true, "owner", false]] as const) {
      await db.query("insert into owner_notes (owner_id, text, vault, vault_by, unsure) values ($1, $2, $3, $4, $5)", [owner.id, text, vault, by, unsure]);
    }
    const before = (await rows(owner.id)).map(({ vault, vault_by, unsure }) => ({ vault, vault_by, unsure }));
    expect((await setLanguage(owner, "en")).status).toBe(200);
    // A sorter that would lock everything, were it ever asked.
    judge.answer(faithfulOnly);
    gateway.reply(ops(rewrite("n1", "Likes tea"), rewrite("n2", "Eats spicy food"), rewrite("n3", "Allergic to peanuts"), rewrite("n4", "Lives in Shanghai")));
    const done = await convert(owner);
    expect(done.json).toMatchObject({ converted: 4, kept: 0 });
    expect((await rows(owner.id)).map((r) => r.text)).toEqual(["Likes tea", "Eats spicy food", "Allergic to peanuts", "Lives in Shanghai"]);
    expect((await rows(owner.id)).map(({ vault, vault_by, unsure }) => ({ vault, vault_by, unsure }))).toEqual(before);
    expect(judge.calls.flatMap((c) => c.questions.map((q) => q.key))).toEqual(["faithful", "faithful", "faithful", "faithful"]);
  });

  it("origin_conversation_id is not changed by a conversion", async () => {
    const w = await world("cf2");
    await db.query("insert into owner_notes (owner_id, text, vault, origin, origin_conversation_id) values ($1, '喜欢喝茶', false, 'review', $2)", [w.owner.id, w.g]);
    expect((await setLanguage(w.owner, "en")).status).toBe(200);
    gateway.reply(ops(rewrite("n1", "Likes tea")));
    expect((await convert(w.owner)).json).toMatchObject({ converted: 1 });
    expect(await rows(w.owner.id)).toMatchObject([{ text: "Likes tea", origin_conversation_id: w.g }]);
  });

  it("with 先问我再记 on, a conversion the owner asked for is applied at once, not left pending", async () => {
    const owner = await signUp(app, "cf3");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA, memoryAsk: true });
    await seeded(owner, agent.id, "喜欢喝茶", false);
    expect((await setLanguage(owner, "en")).status).toBe(200);
    gateway.reply(ops(rewrite("n1", "Likes tea")));
    expect((await convert(owner)).json).toMatchObject({ converted: 1 });
    expect(await ownerTexts(owner.id)).toEqual([{ text: "Likes tea", vault: false }]);
    expect((await db.query("select status from memory_changes where owner_id = $1", [owner.id])).rows).toEqual([{ status: "applied" }]);
  });

  it("a restatement is limited like any model entry, in weight: one of the source's weight applies whatever the script; one past 200 weight is left as it was", async () => {
    const owner = await signUp(app, "cf4");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    await seeded(owner, agent.id, "茶".repeat(80), false);
    await seeded(owner, agent.id, "爱".repeat(80), false);
    expect((await setLanguage(owner, "en")).status).toBe(200);
    // 239 letters weigh 80 (the source's weight) though they are three times its code points; 639 letters weigh 213, past the entry limit of 200.
    const within = "tea ".repeat(60).trim();
    const past = "tea ".repeat(160).trim();
    expect(weight(within)).toBe(80);
    expect(weight(past)).toBeGreaterThan(200);
    gateway.reply(ops(rewrite("n1", within), rewrite("n2", past)));
    expect((await convert(owner)).json).toMatchObject({ converted: 1, kept: 1, noRoom: 0 });
    expect((await ownerTexts(owner.id)).map((r) => r.text)).toEqual([within, "爱".repeat(80)]);
    // The prompt no longer promises a length of three times the source.
    const system = callsOf("笔记语言整理员")[0]!.system;
    expect(system).not.toContain("3 倍");
    expect(system).not.toContain("600");
  });

  it("a full Chinese room converted to English, each note restated with the same weight, applies every note: no noRoom", async () => {
    const owner = await signUp(app, "cf4b");
    await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    // Twenty notes of 100 weight: the room of 2000 is full.
    for (let i = 0; i < 20; i++) await db.query("insert into owner_notes (owner_id, text, vault) values ($1, $2, false)", [owner.id, `${"茶".repeat(99)}${String.fromCharCode(97 + i)}`]);
    expect((await setLanguage(owner, "en")).status).toBe(200);
    const english = Array.from({ length: 20 }, (_, i) => `${"tea ".repeat(74)}n${i}`);
    for (const text of english) expect(weight(text)).toBe(100);
    gateway.reply(ops(...english.map((text, i) => rewrite(`n${i + 1}`, text))));
    expect((await convert(owner)).json).toEqual({ rooms: 1, converted: 20, kept: 0, noRoom: 0, failedRooms: 0 });
    expect((await ownerTexts(owner.id)).map((r) => r.text).sort()).toEqual([...english].sort());
  });

  it("the call's output limit is sized to the room: twice what it holds, 40 a note and 200, never above the model's limit", async () => {
    const owner = await signUp(app, "cf5");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    await seeded(owner, agent.id, "喜欢喝茶", false);
    await seeded(owner, agent.id, "爱吃辣", false);
    expect((await setLanguage(owner, "en")).status).toBe(200);
    gateway.reply(ops());
    await convert(owner);
    // 4 + 3 = 7 weight in 2 notes: 2 x 7 + 40 x 2 + 200.
    expect(callsOf("笔记语言整理员")[0]!.maxOutputTokens).toBe(2 * 7 + 40 * 2 + 200);
    // A room that would ask for more than the model gives is cut to what it gives (FAST: 4096).
    for (let i = 0; i < 9; i++) await db.query("insert into owner_notes (owner_id, text, vault) values ($1, $2, false)", [owner.id, `${"茶".repeat(190)}${i}`]);
    gateway.reply(ops());
    await convert(owner);
    expect(callsOf("笔记语言整理员")[1]!.maxOutputTokens).toBe(Math.min(4096, 2 * (7 + 9 * 191) + 40 * 11 + 200));
  });

  it("a restatement the room cannot hold is left as it is and counted in noRoom (and in kept)", async () => {
    const owner = await signUp(app, "cf6");
    await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    // 19 notes of 100 weight and one of 50: 1950 of the room's 2000.
    for (let i = 0; i < 19; i++) await db.query("insert into owner_notes (owner_id, text, vault) values ($1, $2, false)", [owner.id, `${"茶".repeat(99)}${String.fromCharCode(97 + i)}`]);
    await db.query("insert into owner_notes (owner_id, text, vault) values ($1, $2, false)", [owner.id, "爱".repeat(50)]);
    expect((await setLanguage(owner, "en")).status).toBe(200);
    gateway.reply(ops(rewrite("n20", "love ".repeat(72).trim())));
    const done = await convert(owner);
    expect(done.json).toEqual({ rooms: 1, converted: 0, kept: 20, noRoom: 1, failedRooms: 0 });
    expect((await ownerTexts(owner.id)).at(-1)!.text).toBe("爱".repeat(50));
  });

  it("with the memory allowance empty no room can be processed at all: 503 unavailable, nothing changed, nothing charged; with some rooms processed it is a 200 with failedRooms", async () => {
    const owner = await signUp(app, "cf9");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    await seeded(owner, agent.id, "喜欢喝茶", false);
    expect((await setLanguage(owner, "en")).status).toBe(200);
    const day = siteDay(new Date(), app.deps.config.siteTimezone);
    await db.query("insert into memory_usage (owner_id, day, used_micro) values ($1, $2::date, 900000000000) on conflict (owner_id, day) do update set used_micro = 900000000000", [owner.id, day]);
    const res = await convert(owner);
    expect([res.status, res.json]).toEqual([503, { error: "unavailable" }]);
    expect(await ownerTexts(owner.id)).toEqual([{ text: "喜欢喝茶", vault: false }]);
  });

  it("a truncated answer is a failed room: not counted in kept", async () => {
    const owner = await signUp(app, "cf7");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    await seeded(owner, agent.id, "喜欢喝茶", false);
    expect((await setLanguage(owner, "en")).status).toBe(200);
    gateway.reply('{"ops":[{"op":"rewrite","ref":"n1","text":"Likes');
    expect((await convert(owner)).json).toEqual({ rooms: 1, converted: 0, kept: 0, noRoom: 0, failedRooms: 1 });
    expect(await ownerTexts(owner.id)).toEqual([{ text: "喜欢喝茶", vault: false }]);
  });

  it("when the owner's points run out midway, the rooms after that are failed rooms", async () => {
    const owner = await signUp(app, "cf8");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: PERSONA });
    await seeded(owner, agent.id, "喜欢喝茶", false);
    await seeded(owner, agent.id, "回答要简短", false, "self");
    expect((await setLanguage(owner, "en")).status).toBe(200);
    const hold = gateway.hang();
    const running = convert(owner);
    await hold.reached;
    const day = siteDay(new Date(), app.deps.config.siteTimezone);
    await db.query("insert into memory_usage (owner_id, day, used_micro) values ($1, $2::date, 900000000000) on conflict (owner_id, day) do update set used_micro = 900000000000", [owner.id, day]);
    hold.release(ops(rewrite("n1", "Likes tea")));
    expect((await running).json).toEqual({ rooms: 2, converted: 1, kept: 0, noRoom: 0, failedRooms: 1 });
    expect(await ownerTexts(owner.id)).toEqual([{ text: "Likes tea", vault: false }]);
  });

  it("the nightly dream restates up to 8 notes that are not in the chosen language, and they are applied", async () => {
    const w = await world("cf9");
    await seeded(w.owner, w.agent.id, "喜欢喝茶", false);
    expect((await setLanguage(w.owner, "en")).status).toBe(200);
    gateway.reply(ops(rewrite("n1", "Likes tea")));
    clock.advance(3 * HOUR + MIN);
    await memory().idle();
    expect(callsOf("梦中整理员")).toHaveLength(1);
    expect(callsOf("梦中整理员")[0]!.system).toContain("最多改 8 条");
    expect(await ownerTexts(w.owner.id)).toEqual([{ text: "Likes tea", vault: false }]);
    const [change] = (await db.query("select phase, status from memory_changes where owner_id = $1", [w.owner.id])).rows;
    expect(change).toEqual({ phase: "dream", status: "applied" });
  });
});
