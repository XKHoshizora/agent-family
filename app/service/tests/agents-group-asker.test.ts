import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideProactive } from "../src/agents/proactive/decide.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { markOf, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { byName, scriptedJudge } from "./helpers/judge.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

/**
 * A late joiner cannot get the past out of someone's Agent (Task 10b; the product rule of 2026-11-20): in a group, the
 * history a reply's model is shown starts at the later of where the Agent's own membership began and where the asker's
 * current membership began — the asker being the person whose message caused the reply: the sender of a mention, the
 * sender of the message a reply nobody asked for answers, and in an Agents' chain the person whose message started it
 * (unknown: the latest join among the group's people now). Nothing before that line reaches the model: no message, no
 * quote of one, no file of one. Driven through the real routes, the worker run by hand; every assertion is on what the
 * scripted model was actually sent.
 */

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 4000,
  dailyLimit: 20_000,
};
const gateway = scriptedGateway();
const judge = scriptedJudge();
const { blobs } = useProbeBlobs("af-group-asker-");
const { app, db } = useApp({ env: SITE_ENV, models: gateway, judge, blobs, agentWorker: false, config: { judge: JUDGE } });

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
  judge.calls.splice(0);
  judge.answer(() => ({}));
});
afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
/** What the attack asked (docs/acceptance/attack-1). */
const QUESTION = "@helper_bot 我刚进群，大家最近有什么要注意的吗？";
/** Said in the group after the Agent joined and before the newcomer did: never shown to a reply the newcomer asked for. */
const SECRET = {
  m: "SECRET-M-10b 我下个月要做手术，先别往外说",
  m2: "SECRET-M2-10b 我家最近在闹离婚",
  file: "FILE-SECRET-10b 体检结果：一切正常",
};
const FILE_NAME = "体检报告.txt";

let txn = 0;
const say = async (who: Actor, conv: string, text: string, extra: Record<string, unknown> = {}): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ak${++txn}`, ...extra });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
/** Uploads `data` as `filename` and sends it to `conv` with no caption. */
async function sendFile(who: Actor, conv: string, filename: string, data: string): Promise<void> {
  const uploaded = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename, type: "application/octet-stream", data }]),
  });
  expect(uploaded.statusCode).toBe(201);
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { attachmentId: uploaded.json().id, clientTxn: `ak${++txn}` });
  expect(sent.status).toBe(201);
}
const addMember = async (by: Actor, conv: string, principalId: string): Promise<void> => {
  const res = await api(app, by, "POST", `/api/conversations/${conv}/members`, { principalId });
  if (res.status !== 201) throw new Error(`addMember: ${res.status} ${JSON.stringify(res.json)}`);
};
const leave = async (who: Actor, conv: string): Promise<void> => {
  const res = await api(app, who, "DELETE", `/api/conversations/${conv}/members/${who.id}`);
  if (res.status !== 200) throw new Error(`leave: ${res.status} ${JSON.stringify(res.json)}`);
};
/** Where `principalId`'s current stay in `conv` began. */
const joinedSeq = async (conv: string, principalId: string): Promise<number> =>
  Number(
    (await db.query<{ seq: string }>("select joined_seq::text as seq from memberships where conversation_id = $1 and principal_id = $2 and left_seq is null", [conv, principalId]))
      .rows[0]!.seq,
  );

const callsHere = (): ModelCall[] => gateway.calls.slice(first);
const lastCall = (): ModelCall => {
  const calls = callsHere();
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)!;
};
/** Runs the oldest queued reply, which answers `text`. */
async function answer(text: string): Promise<void> {
  gateway.reply(text);
  expect(await app.agentWorker.runOnce()).toBe(true);
}
/** Everything a call shows the model as text: its system text and every text part of its turns. */
const shownText = (call: ModelCall): string =>
  [call.system, ...call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))].join("\n");

/**
 * The seqs of `conv`'s messages from people that `call` shows — a message's text, or its file's name, appears in what
 * it sends (every such text is distinct in these tests) — and, for comparison, those after `line`.
 */
async function seqsShown(call: ModelCall, conv: string): Promise<{ shown: number[]; all: Array<{ seq: number }> }> {
  const { rows } = await db.query<{ seq: string; text: string | null; name: string | null }>(
    `select m.seq::text as seq, m.body ->> 'text' as text, m.body -> 'attachment' ->> 'name' as name
       from messages m join principals p on p.id = m.sender_id
      where m.conversation_id = $1 and m.kind in ('text', 'file') and p.kind = 'human'
      order by m.seq`,
    [conv],
  );
  const text = shownText(call);
  const all = rows.map((r) => ({ seq: Number(r.seq), shows: r.text ? r.text : r.name! }));
  return { shown: all.filter((m) => text.includes(m.shows)).map((m) => m.seq), all };
}
/** The seqs of `conv`'s messages from people after `line`. */
const peopleAfter = async (conv: string, line: number): Promise<number[]> =>
  (
    await db.query<{ seq: string }>(
      `select m.seq::text as seq from messages m join principals p on p.id = m.sender_id
        where m.conversation_id = $1 and m.kind in ('text', 'file') and p.kind = 'human' and m.seq > $2 order by m.seq`,
      [conv, line],
    )
  ).rows.map((r) => Number(r.seq));

/** No canary of what was said before the line in anything the call sends: its system text, its texts, its files' bytes. */
function expectNoSecret(call: ModelCall): void {
  const sent = JSON.stringify(call);
  for (const secret of [...Object.values(SECRET), FILE_NAME]) expect([secret, sent.includes(secret)]).toEqual([secret, false]);
  for (const m of call.messages) for (const p of m.parts) if (p.type !== "text") expect(Buffer.from(p.data).toString("utf8")).not.toContain("SECRET");
}

const runsOf = async (agentId: string, conv: string) =>
  (
    await db.query<{ status: string; error: string | null; lane: string }>(
      "select status, error, lane from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id",
      [agentId, conv],
    )
  ).rows;

interface World {
  /** The Agent's owner, who made the group. */
  v: Actor;
  m: Actor;
  m2: Actor;
  /** The newcomer: befriended by `v`, not yet in the group. */
  s: Actor;
  g: string;
  /** `v`'s Agent 小助手 (`@helper_bot`), in the group, proactive. */
  agent: { id: string; handle: string; name: string; conversationId: string };
}

async function world(): Promise<World> {
  const [v, m, m2, s] = [await signUp(app, "vivi"), await signUp(app, "mona"), await signUp(app, "mike"), await signUp(app, "sam")];
  const g = await group(app, v, "小区业主群", [m, m2]);
  const agent = await mustCreateAgent(app, v, { handle: "helper_bot", name: "小助手", intro: "帮大家记事", model: FAST, persona: "你是小助手，说话简短。", proactive: true });
  await addMember(v, g, agent.id);
  await befriend(app, v, s);
  return { v, m, m2, s, g, agent };
}

/** `m` and `m2` each say a private thing (no mention) and `m2` sends a file: all after the Agent joined. */
async function privateThings(w: World): Promise<void> {
  await say(w.m, w.g, SECRET.m);
  await say(w.m2, w.g, SECRET.m2);
  await sendFile(w.m2, w.g, FILE_NAME, SECRET.file);
}

/** `v` adds the newcomer; returns where their stay began. */
async function newcomerJoins(w: World): Promise<number> {
  await addMember(w.v, w.g, w.s.id);
  return joinedSeq(w.g, w.s.id);
}

// --- the attack ------------------------------------------------------------------------------------------------------

describe("a newcomer asks someone's Agent what was said before they joined", () => {
  it("the attack: the newcomer's question is answered from nothing before their joining — no message, no file; the same question from an older member is answered from everything since the Agent joined", async () => {
    const w = await world();
    const agentJoined = await joinedSeq(w.g, w.agent.id);
    await privateThings(w);
    const line = await newcomerJoins(w);

    const asked = await say(w.s, w.g, QUESTION);
    await answer("（给新来的回答）");
    const toNewcomer = lastCall();
    expectNoSecret(toNewcomer);
    const fromNewcomer = await seqsShown(toNewcomer, w.g);
    expect(fromNewcomer.shown).toEqual(await peopleAfter(w.g, line));
    expect(fromNewcomer.shown).toEqual([asked]);
    expect(fromNewcomer.all.filter((x) => x.seq <= line && x.seq > agentJoined)).toHaveLength(3);

    // The same question from a member who was there before the Agent: everything since the Agent joined.
    await say(w.m, w.g, QUESTION);
    await answer("（给老成员的回答）");
    const toMember = lastCall();
    const sent = shownText(toMember);
    for (const secret of [SECRET.m, SECRET.m2]) expect([secret, sent.includes(secret)]).toEqual([secret, true]);
    expect(sent).toContain(`[文件：${FILE_NAME}]\n${SECRET.file}`);
    expect((await seqsShown(toMember, w.g)).shown).toEqual(await peopleAfter(w.g, agentJoined));
    expect(await runsOf(w.agent.id, w.g)).toEqual([
      { status: "done", error: null, lane: "others" },
      { status: "done", error: null, lane: "others" },
    ]);
  });

  it("a reply nobody asked for, picked for the newcomer's message, is cut at the newcomer's joining", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    await say(w.m, w.g, "欢迎新邻居");
    const asked = await say(w.s, w.g, "我刚进群，大家最近有什么要注意的吗？");
    judge.answer(byName({ 小助手: 0.95 }));
    const decided = await decideProactive({ db, judge, config: app.deps.config, log: app.log }, w.g, asked);
    expect(decided.runs).toHaveLength(1);
    for (const run of decided.runs) app.agentPort.announce(run);

    await answer("（主动回答新来的）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual(await peopleAfter(w.g, line));
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "done", error: null, lane: "proactive" }]);
  });

  it("an Agents' chain the newcomer started: the Agent they asked and the Agent it asked are both cut at the newcomer's joining; the same chain an older member started is not", async () => {
    const w = await world();
    const other = await mustCreateAgent(app, w.m, { handle: "other_bot", name: "阿杰", intro: "擅长查资料", model: FAST, persona: "你是阿杰。" });
    await addMember(w.m, w.g, other.id);
    await privateThings(w);
    const line = await newcomerJoins(w);

    const asked = await say(w.s, w.g, "@helper_bot 你帮我问问阿杰，大家最近有什么要注意的？");
    await answer("@other_bot 最近群里有什么要注意的吗？");
    const toFirst = lastCall();
    await answer("没什么特别的。");
    const toSecond = lastCall();
    expect(toSecond).not.toBe(toFirst);
    for (const call of [toFirst, toSecond]) {
      expectNoSecret(call);
      expect((await seqsShown(call, w.g)).shown).toEqual([asked]);
    }
    expect(shownText(toSecond)).toContain("@other_bot 最近群里有什么要注意的吗？");
    expect((await runsOf(other.id, w.g)).map((r) => r.status)).toEqual(["done"]);

    // The same chain from an older member reaches back to the Agents' own joining.
    await say(w.m2, w.g, "@helper_bot 你也帮我问问阿杰，大家最近有什么要注意的？");
    await answer("@other_bot 再问一次，最近群里有什么要注意的吗？");
    await answer("还是没什么。");
    const fromMember = lastCall();
    for (const secret of [SECRET.m, SECRET.m2]) expect([secret, shownText(fromMember).includes(secret)]).toEqual([secret, true]);
    expect(line).toBeGreaterThan(0);
  });

  it("after leaving and coming back the line is where the newcomer came back: nothing of their first stay, nothing of while they were away", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    await say(w.s, w.g, "FIRST-STAY-10b 大家好");
    await leave(w.s, w.g);
    await say(w.m, w.g, "SECRET-AWAY-10b 他走了我们说点别的");
    const back = await newcomerJoins(w);

    const asked = await say(w.s, w.g, QUESTION);
    await answer("（回答回来的人）");
    const call = lastCall();
    expectNoSecret(call);
    for (const absent of ["FIRST-STAY-10b", "SECRET-AWAY-10b"]) expect([absent, JSON.stringify(call).includes(absent)]).toEqual([absent, false]);
    expect((await seqsShown(call, w.g)).shown).toEqual([asked]);
    expect(await peopleAfter(w.g, back)).toEqual([asked]);
  });

  it("a message after the line quoting one before it: the quote is left out for the newcomer's question (as for one the Agent cannot see), shown for an older member's", async () => {
    const w = await world();
    const quoted = await say(w.m, w.g, "SECRET-QUOTED-10b 我们周六去吃火锅");
    await newcomerJoins(w);
    const quoting = await say(w.m2, w.g, "看上面这条", { replyToSeq: quoted });
    // The newcomer's read of it carries no quoted text either (the wire's own "not visible").
    const read = (await api(app, w.s, "GET", `/api/conversations/${w.g}/messages`)).json.messages.find((x: { seq: number }) => x.seq === quoting);
    expect(read.replyTo).toEqual({ seq: quoted, visible: false });

    const asked = await say(w.s, w.g, QUESTION);
    await answer("（回答新来的）");
    const toNewcomer = lastCall();
    const m = markOf(toNewcomer);
    expect(JSON.stringify(toNewcomer)).not.toContain("SECRET-QUOTED-10b");
    expect(toNewcomer.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: `〔${m} mike｜群成员〕看上面这条` },
          { type: "text", text: `〔${m} sam｜群成员〕${QUESTION}` },
        ],
      },
    ]);
    expect((await seqsShown(toNewcomer, w.g)).shown).toEqual([quoting, asked]);

    await say(w.m, w.g, "@helper_bot 上面那条引用说的是什么？");
    await answer("（回答老成员）");
    expect(shownText(lastCall())).toContain(`〔${markOf(lastCall())} mike｜群成员〕\n> SECRET-QUOTED-10b 我们周六去吃火锅\n看上面这条`);
  });

  it("the newcomer's mention folded into a reply an older member asked for: the one reply answers both, cut at the later joining — the newcomer's", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const older = await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const asked = await say(w.s, w.g, QUESTION);
    // One queued reply covers both.
    expect((await runsOf(w.agent.id, w.g)).map((r) => r.status)).toEqual(["queued"]);
    await answer("（一起回答）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual([older, asked]);
    expect(await peopleAfter(w.g, line)).toEqual([older, asked]);
  });

  it("the newcomer's mention noted while a reply to an older member runs: that reply is as it was; its follow-up is cut at the newcomer's joining", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    await say(w.m, w.g, "@helper_bot 周末停水的事你记得吗？");
    const hold = gateway.hang();
    const running = app.agentWorker.runOnce();
    const toMember = await hold.reached;
    const asked = await say(w.s, w.g, QUESTION);
    hold.release("（回答老成员）");
    expect(await running).toBe(true);
    // The older member's reply was shown everything since the Agent joined.
    for (const secret of [SECRET.m, SECRET.m2]) expect([secret, shownText(toMember).includes(secret)]).toEqual([secret, true]);

    await answer("（回答新来的）");
    const followUp = lastCall();
    expect(followUp).not.toBe(toMember);
    expectNoSecret(followUp);
    expect((await seqsShown(followUp, w.g)).shown).toEqual(await peopleAfter(w.g, line));
    expect((await seqsShown(followUp, w.g)).shown).toContain(asked);
  });

  it("a reply whose asker is not known (a run recorded before askers were, or a chain whose first person cannot be told) is cut at the latest joining of the group's people now", async () => {
    const w = await world();
    await privateThings(w);
    const line = await newcomerJoins(w);
    const after = await say(w.m, w.g, "AFTER-10b 新邻居来了");
    // As a run recorded before this rule: no asker on it.
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, triggered_by, lane)
       values ('reply', $1, $2, $3, 'queued', $4, 'agent', 'others')`,
      [w.g, w.agent.id, w.v.id, after],
    );
    await answer("（不知道谁问的）");
    const call = lastCall();
    expectNoSecret(call);
    expect((await seqsShown(call, w.g)).shown).toEqual(await peopleAfter(w.g, line));
    expect((await seqsShown(call, w.g)).shown).toEqual([after]);
  });

  it("a newcomer's very first question is a window of one message: planned and answered, no context_too_small", async () => {
    const w = await world();
    await privateThings(w);
    for (let i = 0; i < 5; i++) await say(w.m, w.g, `早先的闲聊 ${i}`);
    await newcomerJoins(w);
    await say(w.s, w.g, QUESTION);
    await answer("（一条消息的窗口）");
    const call = lastCall();
    expect(call.messages).toEqual([{ role: "user", parts: [{ type: "text", text: `〔${markOf(call)} sam｜群成员〕${QUESTION}` }] }]);
    expect(await runsOf(w.agent.id, w.g)).toEqual([{ status: "done", error: null, lane: "others" }]);
    const posted = (await api(app, w.s, "GET", `/api/conversations/${w.g}/messages`)).json.messages.at(-1);
    expect(posted).toMatchObject({ senderId: w.agent.id, text: "（一条消息的窗口）" });
  });
});

// --- unchanged ---------------------------------------------------------------------------------------------------------

describe("what the rule does not change", () => {
  it("a question from a member who joined before the Agent, with a newcomer in the group, shows exactly what it showed: everything since the Agent joined", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    await say(w.v, w.g, "@helper_bot 帮大家总结一下");
    await answer("（总结）");
    const call = lastCall();
    const m = markOf(call);
    expect(call.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: `〔${m} mona｜群成员〕${SECRET.m}` },
          { type: "text", text: `〔${m} mike｜群成员〕${SECRET.m2}` },
          { type: "text", text: `〔${m} mike｜群成员〕` },
          { type: "text", text: `[文件：${FILE_NAME}]\n${SECRET.file}` },
          { type: "text", text: `〔${m} vivi｜你的主人〕@helper_bot 帮大家总结一下` },
        ],
      },
    ]);
  });

  it("the Agent's own conversation with its owner is as it was", async () => {
    const w = await world();
    await privateThings(w);
    await newcomerJoins(w);
    await say(w.v, w.agent.conversationId, "私下问一句：群里谁最近不方便？");
    await answer("我不清楚。");
    await say(w.v, w.agent.conversationId, "好的");
    await answer("嗯。");
    expect(lastCall().messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "私下问一句：群里谁最近不方便？" }] },
      { role: "assistant", parts: [{ type: "text", text: "我不清楚。" }] },
      { role: "user", parts: [{ type: "text", text: "好的" }] },
    ]);
  });
});
