import { afterEach, describe, expect, it } from "vitest";
import { mentionedHandles, mentionsAtSend, mentionTokens, typedReading } from "../src/agents/mentions.ts";
import { MESSAGE_TEXT_MAX } from "../src/messages/send.ts";

import { namesAnAgent } from "../src/agents/proactive/candidates.ts";
import { NOTHING, type RunTicket } from "../src/agents/runtime/port.ts";
import { triggerFromAgent } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import { insertMessage } from "../src/messages/model.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { expectLinear, LOADED_TIMEOUT_MS } from "./helpers/linear.ts";
import { scriptedGateway } from "./helpers/models.ts";

/** The handles a text names, as the reading at send looks them up (its tokens, then their distinct handles). */
const handlesIn = (text: string): string[] => mentionedHandles(mentionTokens(text));

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
    // A dot followed by a word is a full handle, not punctuation: `@anna.Thanks` names `anna.thanks` (nobody), not anna.
    ["@anna.Thanks", ["anna.thanks"]],
    ["cc @jarvis.see above", ["jarvis.see"]],
  ])("%j → %j", (text, expected) => {
    expect(handlesIn(text)).toEqual(expected);
  });

  it("stays linear on dotted runs: 8 000 characters of @a.a.a…, @aaa.aaa.… and the like take about four times what 2 000 take", { timeout: LOADED_TIMEOUT_MS }, () => {
    const cases: Array<[(n: number) => string, string[]]> = [
      [(n) => "@a.".repeat(n * 0.34), []],
      [(n) => `@${"a.".repeat(n / 2)}`, []],
      [(n) => "@aaa.bb".repeat(n / 7), ["aaa.bb"]],
      [(n) => `@${"a".repeat(n / 2 - 1)}.${"b".repeat(n / 2)}`, []],
      [(n) => ".@xyz.".repeat(n / 6), ["xyz"]],
    ];
    for (const [make, expected] of cases) {
      expect(make(8000).length).toBeGreaterThanOrEqual(7900);
      // `expectLinear` (helpers/linear.ts) compares the two sizes with each other: four times the text, less than eight times the time.
      expectLinear({
        n: 2000,
        make,
        run: (text) => {
          if (JSON.stringify(handlesIn(text)) !== JSON.stringify(expected)) throw new Error(`handlesIn gave ${JSON.stringify(handlesIn(text))} for a text of ${text.length} characters`);
        },
      });
    }
  });
});

describe("the reading at send is linear in the text, at the longest a message may be (fix round 2, I-4; tidy round, m-1)", () => {
  it("code, addresses and tokens of 16 000 code units (MESSAGE_TEXT_MAX code points, each up to two units) take about four times what 4 000 take, whatever the text holds", () => {
    expect(MESSAGE_TEXT_MAX).toBe(8000);
    // The reading works on UTF-16 code units: a text of MESSAGE_TEXT_MAX code points holds up to twice as many.
    const longest = MESSAGE_TEXT_MAX * 2;
    const cases: Array<[string, (n: number) => string]> = [
      ["@ and a run of letters", (n) => `@${"a".repeat(n - 1)}`],
      ["a run of letters, dots and dashes", (n) => `@x ${"a.b-c+".repeat(n / 6)}`.slice(0, n)],
      ["www. again and again", (n) => `@x ${"www.".repeat(n / 4)}`.slice(0, n)],
      ["schemes without //", (n) => `@x ${"http:".repeat(n / 5)}`.slice(0, n)],
      ["link targets", (n) => `@x ${"](".repeat(n / 2)}`.slice(0, n)],
      ["backticks", (n) => `@x ${"`a``".repeat(n / 4)}`.slice(0, n)],
      ["mentions after slashes", (n) => "/@anna ".repeat(n / 7)],
      ["URLs between spaces", (n) => `@x ${"http://x/@y ".repeat(n / 12)}`.slice(0, n)],
      // Short lines of text between fences: many paragraphs, no blank line between them (m-1).
      ["fences between short lines", (n) => `@x\n${"```\n```\na\n".repeat(n / 10)}`.slice(0, n)],
      ["list fences between short lines", (n) => `@x\n${"- ```\n  ```\na\n".repeat(n / 14)}`.slice(0, n)],
      ["blank lines between short paragraphs", (n) => `@x\n${"a `b\n\n".repeat(n / 6)}`.slice(0, n)],
    ];
    for (const [name, make] of cases) {
      expect(make(longest).length, name).toBeGreaterThanOrEqual(longest - 14);
      // Linear: four times the text, less than eight times the time (a quadratic reading takes sixteen).
      expectLinear({
        n: longest / 4,
        make,
        run: (text) => {
          if (typedReading(text).tokens === undefined) throw new Error(`${name}: no reading`);
        },
      });
    }
    // (Eleven shapes, each about a second of measuring: more than the usual limit of a test.)
  }, 120_000);
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
/** Who the message at `seq` names, as stored when it was sent (Task M). */
const storedMentions = async (conv: string, seq: number) =>
  (await db.query<{ mentions: Array<{ id: string; start: number; length: number }> | null }>("select mentions from messages where conversation_id = $1 and seq = $2", [conv, seq])).rows[0]!
    .mentions;
const notices = async (conv: string) => Number((await db.query("select count(*) n from messages where conversation_id = $1 and kind = 'system'", [conv])).rows[0].n);
const settleAll = () => db.query("update agent_runs set status = 'done', finished_at = now() where status in ('queued', 'running')");

/** The Agent's own message in `conv`, stored and handed to the trigger in one transaction, as `postAsAgent` does. */
const agentSays = (agentId: string, conv: string, text: string) =>
  db.tx(async (t) => {
    const poster = await lockAgent(t, agentId, conv);
    const message = await insertMessage(t, conv, agentId, "text", { text }, null, await mentionsAtSend(t, { id: conv, type: "group" }, text));
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
    // Its handle and name part as whole mentions only (fix round 1, M5): not inside a longer one.
    const runs = await allRuns();
    for (const text of ["@jarvis_2 在吗", "@xiaolin.jarvis2 在吗", "@jarvisx"]) await say(owner, conv, text);
    expect(await allRuns()).toBe(runs);
  });

  it("a full handle two live Agents would have (only a write that skipped the owner's lock could make one) calls nobody (fix round 1, M1)", async () => {
    const w = await world();
    await agentOf(w.xiaolin, "jarvis", w.g);
    const twin = (
      await db.query<{ id: string }>("insert into principals (kind, handle, display_name, owner_id) values ('agent', 'jarvis', 'Twin', $1) returning id", [w.xiaolin.id])
    ).rows[0]!.id;
    await db.query("insert into agents (principal_id, model_source, site_model_id) values ($1, 'site', 'fast')", [twin]);
    await join(w.g, twin);
    const runs = await allRuns();
    await say(w.anna, w.g, "@xiaolin.jarvis 你好");
    expect(await allRuns()).toBe(runs);
  });
});

describe("a person member's display name is a person first (fix round 1, I2)", () => {
  it("the person 「Jarvis」 (handle tony) and the Agent xiaolin.jarvis in one group: @Jarvis calls nobody and costs nothing, @xiaolin.jarvis calls it; without that person @jarvis calls it", async () => {
    const w = await world();
    const tony = await signUp(app, "tony");
    expect((await api(app, tony, "PATCH", "/api/me", { displayName: "Jarvis" })).status).toBe(200);
    await join(w.g, tony.id);
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    const runs = await allRuns();
    const named = await say(w.anna, w.g, "@Jarvis 你好");
    expect(await allRuns()).toBe(runs);
    expect(Number((await db.query("select count(*) n from usage_records")).rows[0].n)).toBe(0);
    // Nor does it name an Agent for the proactive judgement: it named the person (as stored when it was sent, Task M).
    expect(await namesAnAgent(db, await storedMentions(w.g, named))).toBe(false);
    // The full form is never a person's.
    const one = await say(w.anna, w.g, "@xiaolin.jarvis 你好");
    expect(await covered(jarvis.id, w.g)).toEqual([one]);
    expect(await namesAnAgent(db, await storedMentions(w.g, one))).toBe(true);
    await settleAll();
    const elsewhere = await group(app, w.xiaolin, "elsewhere", [w.bobby, w.anna]);
    await join(elsewhere, jarvis.id);
    const two = await say(w.anna, elsewhere, "@jarvis 你好");
    expect(await covered(jarvis.id, elsewhere)).toEqual([two]);
    expect(await namesAnAgent(db, await storedMentions(elsewhere, two))).toBe(true);
  });
});

/** The Agent's queued run in `conv`, made running as the worker's claim makes it. */
const claim = async (agentId: string, conv: string): Promise<RunTicket> => {
  const { rows } = await db.query<{ id: string; owner_id: string }>(
    "update agent_runs set status = 'running', started_at = now() where agent_id = $1 and conversation_id = $2 and status = 'queued' returning id, owner_id",
    [agentId, conv],
  );
  return { id: rows[0]!.id, agentId, ownerId: rows[0]!.owner_id, conversationId: conv };
};

/** Ends a running run as the worker ends one that answered: `finish`, which follows it up. */
const finish = (ticket: RunTicket) => app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);

/** The Agent's latest run in `conv`: who and what it answers. */
const latestRun = async (agentId: string, conv: string) =>
  (
    await db.query<{ status: string; by: string; lane: string; caller: string | null; askers: string[] | null; calls: number[] | null }>(
      `select status, triggered_by as by, lane, caller_id as caller, asker_ids as askers, call_seqs::int[] as calls
         from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc, id desc limit 1`,
      [agentId, conv],
    )
  ).rows[0];

describe("a follow-up answers the calls its run recorded, as they were read when sent (fix round 1, I1)", () => {
  it("a member's call by full handle noted while the reply runs is still theirs after the owner renames and the group is halted", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    await say(w.anna, w.g, "@xiaolin.jarvis 一");
    const ticket = await claim(jarvis.id, w.g);
    const noted = await say(w.bobby, w.g, "@xiaolin.jarvis 帮我查一下");
    expect((await api(app, w.xiaolin, "PATCH", "/api/me", { handle: "lin" })).status).toBe(200);
    expect((await api(app, w.anna, "POST", `/api/conversations/${w.g}/agents/halt`)).status).toBe(200);
    await finish(ticket);
    const next = await latestRun(jarvis.id, w.g);
    expect(next).toMatchObject({ status: "queued", by: "human", lane: "others", caller: w.bobby.id });
    expect(next!.askers).toContain(w.bobby.id);
    expect(next!.calls).toContain(noted);
  });

  it("a bare call noted while it named one Agent stays that member's call after a second Agent of that name part joins", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    await say(w.anna, w.g, "@jarvis 一");
    const ticket = await claim(jarvis.id, w.g);
    const noted = await say(w.bobby, w.g, "@jarvis 二");
    await agentOf(w.bobby, "jarvis", w.g);
    await finish(ticket);
    const next = await latestRun(jarvis.id, w.g);
    expect(next).toMatchObject({ status: "queued", by: "human", lane: "others", caller: w.bobby.id });
    expect(next!.calls).toContain(noted);
  });

  it("a message that only now reads as a call of it, but called nobody when sent, is not one", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    const other = await agentOf(w.bobby, "jarvis", w.g);
    await say(w.anna, w.g, "@xiaolin.jarvis 一");
    const ticket = await claim(jarvis.id, w.g);
    // Two jarvises: the bare form calls nobody, so nothing is noted for it.
    const ambiguous = await say(w.bobby, w.g, "@jarvis 二");
    await db.query("update memberships set left_seq = (select seq from conversations where id = $1) where conversation_id = $1 and principal_id = $2", [w.g, other.id]);
    const noted = await say(w.anna, w.g, "@xiaolin.jarvis 三");
    await finish(ticket);
    const next = await latestRun(jarvis.id, w.g);
    // anna's call alone: hers, not bobby's (whose message would be the earlier caller if it were read as a call now).
    expect(next).toMatchObject({ status: "queued", by: "human", lane: "others", caller: w.anna.id });
    expect(next!.calls).toContain(noted);
    expect(next!.calls).not.toContain(ambiguous);
  });
});

