import { afterEach, describe, expect, it } from "vitest";
import { mentionedHandles } from "../src/agents/mentions.ts";
import { triggerFromAgent } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import { insertMessage } from "../src/messages/model.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * Family names in mentions (Task N): `@owner.name` always names that Agent; a bare `@name` names the one Agent member of
 * the conversation whose name part it is — unless a person member has that handle (people first), or two or more Agent
 * members have that name part (then nobody, as an unknown `@x`). The parse is pure; who is called is read per
 * conversation. Runs are only queued here: no worker picks them up.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(() => expect(gateway.pending()).toBe(0));

const FAST = { source: "site", id: "fast" } as const;

describe("mentionedHandles: the full form `owner.name` and the bare `name`", () => {
  it.each<[string, string[]]>([
    ["@xiaolin.jarvis 你好", ["xiaolin.jarvis"]],
    // A trailing dot not followed by a handle character is punctuation.
    ["ask @xiaolin.jarvis.", ["xiaolin.jarvis"]],
    ["问问 @xiaolin.jarvis。", ["xiaolin.jarvis"]],
    ["@anna.", ["anna"]],
    ["@anna..jarvis", ["anna"]],
    ["@anna. 你好", ["anna"]],
    // Case is ignored: lower-cased.
    ["@XiaoLin.JARVIS", ["xiaolin.jarvis"]],
    // One dot only: `@abc.def.ghi` is `abc.def`, then `.ghi` is text.
    ["@abc.def.ghi", ["abc.def"]],
    // The bare form: a name part may be 2 characters.
    ["@ai 帮个忙", ["ai"]],
    ["@jarvis", ["jarvis"]],
    // Too short or too long on either side of the dot: nobody.
    ["@a", []],
    ["@xiaolin.j", []],
    ["@ab.jarvis", []],
    [`@${"a".repeat(25)}.jarvis`, []],
    [`@xiaolin.${"b".repeat(25)}`, []],
    [`@${"a".repeat(24)}.${"b".repeat(24)}`, [`${"a".repeat(24)}.${"b".repeat(24)}`]],
    // Preceded by a word character: an address, not a mention — dotted or not.
    ["mail@xiaolin.jarvis x_@bob.bot", []],
    // Distinct, in order: the full form and the bare one are two different mentions.
    ["@xiaolin.jarvis @jarvis @XIAOLIN.JARVIS @Jarvis", ["xiaolin.jarvis", "jarvis"]],
    ["(@xiaolin.jarvis)，@bobby.jarvis！@carl_x.helper_2", ["xiaolin.jarvis", "bobby.jarvis", "carl_x.helper_2"]],
    ["@安娜.jarvis @xiaolin.安娜", ["xiaolin"]],
  ])("%j → %j", (text, expected) => {
    expect(mentionedHandles(text)).toEqual(expected);
  });

  it("stays linear on dotted runs: 8 000 characters of @a.a.a…, @aaa.aaa.… and the like", () => {
    const cases: Array<[string, string[]]> = [
      ["@a.".repeat(2700), []],
      [`@${"a.".repeat(4000)}`, []],
      ["@aaa.bb".repeat(1200), ["aaa.bb"]],
      [`@${"a".repeat(3999)}.${"b".repeat(4000)}`, []],
      [".@xyz.".repeat(1400), ["xyz"]],
    ];
    for (const [text, expected] of cases) {
      expect(text.length).toBeGreaterThanOrEqual(8000);
      expect(mentionedHandles(text)).toEqual(expected);
      const started = performance.now();
      for (let i = 0; i < 20; i++) mentionedHandles(text);
      expect((performance.now() - started) / 20).toBeLessThan(5);
    }
  });
});

/** Puts principal `id` into conversation `conv` from its current seq on. */
const join = (conv: string, id: string) =>
  db.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1`, [
    conv,
    id,
  ]);

/** An Agent of `owner` with name part `namePart`, answering on the site model, put into `conv` when given. */
async function agentOf(owner: Actor, namePart: string, conv: string | null) {
  const agent = await mustCreateAgent(app, owner, { namePart, name: `${namePart}的名字`, model: FAST, persona: "简短地回答。" });
  if (conv) await join(conv, agent.id);
  return agent as { id: string; handle: string; conversationId: string };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `mt${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

/** The seqs the Agent's runs in `conv` cover, oldest first. */
const covered = async (agentId: string, conv: string): Promise<number[]> =>
  (await db.query<{ covers: number }>("select covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id", [agentId, conv])).rows.map(
    (r) => r.covers,
  );

const allRuns = async () => Number((await db.query("select count(*) n from agent_runs")).rows[0].n);
const notices = async (conv: string) => Number((await db.query("select count(*) n from messages where conversation_id = $1 and kind = 'system'", [conv])).rows[0].n);
const settleAll = () => db.query("update agent_runs set status = 'done', finished_at = now() where status in ('queued', 'running')");

/** The Agent's own message in `conv`, stored and handed to the trigger in one transaction, as `postAsAgent` does. */
const agentSays = (agentId: string, conv: string, text: string) =>
  db.tx(async (t) => {
    const poster = await lockAgent(t, agentId, conv);
    const message = await insertMessage(t, conv, agentId, "text", { text }, null);
    return triggerFromAgent(t, conv, message, poster, null, app.deps.config, null);
  });

interface World {
  xiaolin: Actor;
  bobby: Actor;
  anna: Actor;
  g: string;
}

async function world(): Promise<World> {
  const [xiaolin, bobby, anna] = [await signUp(app, "xiaolin"), await signUp(app, "bobby"), await signUp(app, "anna")];
  return { xiaolin, bobby, anna, g: await group(app, xiaolin, "family", [bobby, anna]) };
}

describe("who a mention calls in a group", () => {
  it("`@owner.name` calls that Agent, case ignored, a trailing dot left out; two owners' Agents of one name part are told apart", async () => {
    const w = await world();
    const mine = await agentOf(w.xiaolin, "jarvis", w.g);
    const theirs = await agentOf(w.bobby, "jarvis", w.g);
    expect([mine.handle, theirs.handle]).toEqual(["xiaolin.jarvis", "bobby.jarvis"]);

    const one = await say(w.anna, w.g, "@xiaolin.jarvis 你好");
    expect([await covered(mine.id, w.g), await covered(theirs.id, w.g)]).toEqual([[one], []]);
    await settleAll();
    const two = await say(w.anna, w.g, "那问问 @BOBBY.Jarvis.");
    expect([await covered(mine.id, w.g), await covered(theirs.id, w.g)]).toEqual([[one], [two]]);
    await settleAll();
    // Both by their full handles: both.
    const three = await say(w.xiaolin, w.g, "@xiaolin.jarvis 和 @bobby.jarvis 一起");
    expect([await covered(mine.id, w.g), await covered(theirs.id, w.g)]).toEqual([
      [one, three],
      [two, three],
    ]);
  });

  it("a bare `@name` calls the one Agent member of that name part; with two of them it calls nobody, exactly as an unknown `@x`", async () => {
    const w = await world();
    const mine = await agentOf(w.xiaolin, "jarvis", w.g);
    const helper = await agentOf(w.bobby, "helper", w.g);
    const one = await say(w.anna, w.g, "@jarvis 在吗");
    const two = await say(w.anna, w.g, "@helper 你呢");
    expect([await covered(mine.id, w.g), await covered(helper.id, w.g)]).toEqual([[one], [two]]);
    await settleAll();

    // A second jarvis: the bare form names nobody — no run, no notice, nothing told — as `@nobody_here` does.
    const theirs = await agentOf(w.bobby, "jarvis", w.g);
    const [runs, told] = [await allRuns(), await notices(w.g)];
    const sent = await api(app, w.anna, "POST", `/api/conversations/${w.g}/messages`, { text: "@jarvis 你好", clientTxn: "bare-two" });
    const unknown = await api(app, w.anna, "POST", `/api/conversations/${w.g}/messages`, { text: "@nobody_here 你好", clientTxn: "bare-none" });
    expect([sent.status, Object.keys(sent.json).sort()]).toEqual([unknown.status, Object.keys(unknown.json).sort()]);
    expect([await allRuns(), await notices(w.g)]).toEqual([runs, told]);
    // The full form still reaches each.
    const three = await say(w.anna, w.g, "@bobby.jarvis 你来");
    expect([await covered(mine.id, w.g), await covered(theirs.id, w.g)]).toEqual([[one], [three]]);
    // One of the two left: the bare form is the other's again.
    await settleAll();
    await db.query("update memberships set left_seq = (select seq from conversations where id = $1) where conversation_id = $1 and principal_id = $2", [w.g, theirs.id]);
    const four = await say(w.anna, w.g, "@Jarvis 你还在吗");
    expect(await covered(mine.id, w.g)).toEqual([one, four]);
  });

  it("people first: a bare `@name` that is a person member's handle calls no Agent of that name part; once no such person is a member, it does", async () => {
    const w = await world();
    const named = await agentOf(w.xiaolin, "anna", w.g);
    const before = await allRuns();
    await say(w.bobby, w.g, "@anna 你好");
    expect(await allRuns()).toBe(before);
    // The full form is never a person's.
    const one = await say(w.bobby, w.g, "@xiaolin.anna 你好");
    expect(await covered(named.id, w.g)).toEqual([one]);
    await settleAll();
    // Elsewhere, where the person anna is not a member, the bare form is the Agent's.
    const other = await group(app, w.xiaolin, "elsewhere", [w.bobby, await signUp(app, "dora")]);
    await join(other, named.id);
    const two = await say(w.bobby, other, "@anna 你好");
    expect(await covered(named.id, other)).toEqual([two]);
  });

  it("an Agent of another group, a deleted one and a name part nobody here has call nobody; a person's handle with a dot is no Agent", async () => {
    const w = await world();
    const elsewhere = await group(app, w.xiaolin, "elsewhere", [w.bobby, w.anna]);
    await agentOf(w.xiaolin, "far", elsewhere);
    const gone = await agentOf(w.xiaolin, "gone", w.g);
    expect((await api(app, w.xiaolin, "DELETE", `/api/agents/${gone.id}`)).status).toBe(200);
    const before = await allRuns();
    await say(w.anna, w.g, "@far @xiaolin.far @gone @xiaolin.gone @nobody @anna.jarvis @xiaolin.");
    expect(await allRuns()).toBe(before);
  });

  it("an Agent's reply that writes `@owner.name` calls that Agent as a person's would; its bare form follows the one-match rule, itself counted", async () => {
    const w = await world();
    const mine = await agentOf(w.xiaolin, "jarvis", w.g);
    const theirs = await agentOf(w.bobby, "jarvis", w.g);
    const helper = await agentOf(w.bobby, "helper", w.g);
    // A person spoke first: the chain is a person's.
    await say(w.anna, w.g, "大家好");

    const called = await agentSays(mine.id, w.g, "我请 @bobby.jarvis 来回答。");
    expect(called.runs.map((r) => r.run.status)).toEqual(["queued"]);
    expect((await covered(theirs.id, w.g)).length).toBe(1);
    await settleAll();
    // Two jarvises here, the poster one of them: the bare form calls nobody.
    const runs = await allRuns();
    expect((await agentSays(mine.id, w.g, "@jarvis 你说呢")).runs).toEqual([]);
    expect(await allRuns()).toBe(runs);
    // One helper: the bare form is that one.
    expect((await agentSays(mine.id, w.g, "@helper 帮忙")).runs.map((r) => r.run.status)).toEqual(["queued"]);
    expect((await covered(helper.id, w.g)).length).toBe(1);
    // Its own full handle calls nobody: an Agent never calls itself.
    await settleAll();
    const after = await allRuns();
    expect((await agentSays(mine.id, w.g, "我是 @xiaolin.jarvis")).runs).toEqual([]);
    expect(await allRuns()).toBe(after);
  });

  it("in its own conversation an Agent that answers only when called answers to its full handle, its name part and its name", async () => {
    const owner = await signUp(app, "xiaolin");
    const agent = await mustCreateAgent(app, owner, { namePart: "jarvis", name: "贾维斯", model: FAST, persona: "简短地回答。", replyMode: "mention" });
    const conv = agent.conversationId as string;
    await say(owner, conv, "随便聊聊");
    expect(await covered(agent.id, conv)).toEqual([]);
    for (const text of ["@xiaolin.jarvis 在吗", "@jarvis 在吗", "@贾维斯 在吗"]) {
      const seq = await say(owner, conv, text);
      expect([text, (await covered(agent.id, conv)).at(-1)]).toEqual([text, seq]);
      await settleAll();
    }
  });
});
