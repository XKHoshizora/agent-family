import { afterEach, describe, expect, it } from "vitest";
import { NOTHING, type RunTicket } from "../src/agents/runtime/port.ts";
import { triggerFromAgent } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import { insertMessage } from "../src/messages/model.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * Who called for each run, and its lane (`agent_runs.caller_id`, `lane`; the limits plan, Task 1): `own` when the Agent's
 * owner called for it — themselves, or through one of their own Agents — and `others` when someone else did, with who
 * (an Agent's call is its owner's). The limits read these two columns; recording them changes nothing that is queued,
 * folded or refused. As in agents-group-trigger.test.ts, an Agent is put into a group by inserting its membership row,
 * and an Agent's own message is stored and handed to `triggerFromAgent` in one transaction, as `postAsAgent` does.
 */

const gateway = scriptedGateway();
// Runs are only queued here: no worker may pick them up.
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;

interface World {
  owner: Actor;
  member: Actor;
  third: Actor;
  /** A group of the three. */
  g: string;
}

async function world(): Promise<World> {
  const [owner, member, third] = [await signUp(app, "owner"), await signUp(app, "member"), await signUp(app, "third")];
  return { owner, member, third, g: await group(app, owner, "team", [member, third]) };
}

/** Puts principal `id` into conversation `conv` from its current seq on. */
const join = (conv: string, id: string) =>
  db.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1`, [
    conv,
    id,
  ]);

/** An Agent of `owner` with `handle` (also its name), answering on the site model, put into `conv` when given. */
async function agentOf(owner: Actor, handle: string, conv: string | null) {
  const agent = await mustCreateAgent(app, owner, { handle, name: handle, model: FAST, persona: "简短地回答。" });
  if (conv) await join(conv, agent.id);
  return agent as { id: string; handle: string; conversationId: string };
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ln${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

/** The Agent's own message in `conv`, stored and handed to the trigger in one transaction, as `postAsAgent` does. */
const agentSays = (agentId: string, conv: string, text: string) =>
  db.tx(async (t) => {
    const poster = await lockAgent(t, agentId, conv);
    const message = await insertMessage(t, conv, agentId, "text", { text }, null);
    return { message, ...(await triggerFromAgent(t, conv, message, poster, app.deps.config)) };
  });

/** The Agent's runs in `conv`, oldest first: each one's lane and who called for it. */
const laneOf = async (agentId: string, conv: string): Promise<Array<[string, string | null]>> =>
  (
    await db.query<{ lane: string; caller_id: string | null }>(
      "select lane, caller_id from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id",
      [agentId, conv],
    )
  ).rows.map((r) => [r.lane, r.caller_id]);

/** Ends every active run, so that the next trigger queues a new one instead of folding. */
const settleAll = () => db.query("update agent_runs set status = 'done', finished_at = now() where status in ('queued', 'running')");

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

/** Twenty replies of `agentId`'s, started half a minute ago in `conv`: its owner's replies a minute are used up. */
const useUpTheMinute = (conv: string, agentId: string, ownerId: string) =>
  db.query(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, created_at, finished_at)
     select 'reply', $1, $2, $3, 'done', 0, now() - interval '30 seconds', now() - interval '29 seconds' from generate_series(1, 20)`,
    [conv, agentId, ownerId],
  );

describe("a run's lane and who called for it", () => {
  it("the owner's mention is own, another member's is others, with who called", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await say(w.owner, w.g, "@anna 你好");
    expect(await laneOf(anna.id, w.g)).toEqual([["own", w.owner.id]]);
    await settleAll();
    await say(w.member, w.g, "@anna 你好");
    expect(await laneOf(anna.id, w.g)).toEqual([
      ["own", w.owner.id],
      ["others", w.member.id],
    ]);
  });

  it("an Agent's mention carries its owner as the caller", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    const beta = await agentOf(w.member, "beta", w.g);
    await say(w.third, w.g, "开始吧");
    await agentSays(beta.id, w.g, "@anna 你来");
    expect(await laneOf(anna.id, w.g)).toEqual([["others", w.member.id]]);
    await agentSays(anna.id, w.g, "@carlbot 你也来");
    expect(await laneOf(carl.id, w.g)).toEqual([["own", w.owner.id]]);
  });

  it("its own conversation is own, and so is a follow-up there", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", null);
    await say(w.owner, anna.conversationId, "你好");
    expect(await laneOf(anna.id, anna.conversationId)).toEqual([["own", w.owner.id]]);
    const one = await claim(anna.id, anna.conversationId);
    await say(w.owner, anna.conversationId, "还有一件事");
    await finish(one);
    expect(await laneOf(anna.id, anna.conversationId)).toEqual([
      ["own", w.owner.id],
      ["own", w.owner.id],
    ]);
  });

  it("folding: the owner's mention makes a queued others run own; another member's leaves it others with the first caller", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    await say(w.member, w.g, "@anna 一");
    await say(w.third, w.g, "@anna 二");
    expect(await laneOf(anna.id, w.g)).toEqual([["others", w.member.id]]);
    await say(w.owner, w.g, "@anna 三");
    expect(await laneOf(anna.id, w.g)).toEqual([["own", w.owner.id]]);
    // Own it stays, whoever's mention is folded in next.
    await say(w.third, w.g, "@anna 四");
    expect(await laneOf(anna.id, w.g)).toEqual([["own", w.owner.id]]);

    // An Agent of the owner's folds in as the owner does.
    await settleAll();
    await say(w.member, w.g, "@anna 五");
    await agentSays(carl.id, w.g, "@anna 补充");
    expect((await laneOf(anna.id, w.g)).at(-1)).toEqual(["own", w.owner.id]);

    // A running run is not folded into: the owner's mention is noted for its follow-up, and the run stays the member's.
    await settleAll();
    await say(w.member, w.g, "@anna 六");
    await claim(anna.id, w.g);
    await say(w.owner, w.g, "@anna 七");
    expect((await laneOf(anna.id, w.g)).at(-1)).toEqual(["others", w.member.id]);
  });

  it("a follow-up takes its lane from what it answers", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", w.g);
    const beta = await agentOf(w.third, "beta", w.g);

    // A member's reply under way; its owner mentions it meanwhile: the follow-up is the owner's own.
    await say(w.member, w.g, "@anna 一");
    const one = await claim(anna.id, w.g);
    await say(w.owner, w.g, "@anna 我也问");
    await say(w.member, w.g, "@anna 还有");
    await finish(one);
    expect(await laneOf(anna.id, w.g)).toEqual([
      ["others", w.member.id],
      ["own", w.owner.id],
    ]);

    // Only the member mentions it meanwhile: others, the member's.
    await settleAll();
    await say(w.member, w.g, "@anna 二");
    const two = await claim(anna.id, w.g);
    await say(w.member, w.g, "@anna 再问");
    await finish(two);
    expect((await laneOf(anna.id, w.g)).slice(2)).toEqual([
      ["others", w.member.id],
      ["others", w.member.id],
    ]);

    // Several others: the earliest of them, an Agent counted as its owner.
    await settleAll();
    await say(w.member, w.g, "@anna 三");
    const three = await claim(anna.id, w.g);
    await agentSays(beta.id, w.g, "@anna 补充");
    await say(w.member, w.g, "@anna 再问");
    await finish(three);
    expect((await laneOf(anna.id, w.g)).slice(4)).toEqual([
      ["others", w.member.id],
      ["others", w.third.id],
    ]);

    // One of the owner's Agents among them: own.
    await settleAll();
    await say(w.member, w.g, "@anna 四");
    const four = await claim(anna.id, w.g);
    await say(w.third, w.g, "@anna 我问");
    await agentSays(carl.id, w.g, "@anna 也看看");
    await finish(four);
    expect((await laneOf(anna.id, w.g)).slice(6)).toEqual([
      ["others", w.member.id],
      ["own", w.owner.id],
    ]);
  });

  it("a follow-up whose callers are no longer visible to it is its owner's own", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await say(w.third, w.g, "@anna 一");
    const one = await claim(anna.id, w.g);
    await say(w.member, w.g, "@anna 我也问");
    // The owner blocks the member before the reply ends: the member's mention no longer counts for the follow-up (which
    // is still queued, as before this change).
    expect((await api(app, w.owner, "PUT", `/api/blocks/${w.member.id}`)).status).toBe(200);
    await finish(one);
    expect(await laneOf(anna.id, w.g)).toEqual([
      ["others", w.third.id],
      ["own", w.owner.id],
    ]);
  });

  it("a rate-limited record carries them too", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const carl = await agentOf(w.owner, "carlbot", null);
    await useUpTheMinute(carl.conversationId, carl.id, w.owner.id);
    const errors = async (conv: string) =>
      (await db.query<{ error: string | null }>("select error from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id", [anna.id, conv])).rows.map(
        (r) => r.error,
      );

    await say(w.member, w.g, "@anna 一");
    expect(await errors(w.g)).toEqual(["rate_limited"]);
    expect(await laneOf(anna.id, w.g)).toEqual([["others", w.member.id]]);
    // The same record covers the next mentions: another member's leaves it the first caller's, the owner's makes it own.
    await say(w.third, w.g, "@anna 二");
    expect(await laneOf(anna.id, w.g)).toEqual([["others", w.member.id]]);
    await say(w.owner, w.g, "@anna 三");
    expect(await laneOf(anna.id, w.g)).toEqual([["own", w.owner.id]]);
    expect(await errors(w.g)).toEqual(["rate_limited"]);

    // In its own conversation: own.
    await say(w.owner, anna.conversationId, "你好");
    expect(await errors(anna.conversationId)).toEqual(["rate_limited"]);
    expect(await laneOf(anna.id, anna.conversationId)).toEqual([["own", w.owner.id]]);
  });

  it("a retry is its owner's own, whoever called for the run that failed", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    const fail = (agentId: string, conv: string) =>
      db.query("update agent_runs set status = 'failed', error = 'provider_unavailable', finished_at = now() where agent_id = $1 and conversation_id = $2 and status = 'queued'", [
        agentId,
        conv,
      ]);

    await say(w.member, w.g, "@anna 一");
    await fail(anna.id, w.g);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/runs/retry`, { agentId: anna.id })).status).toBe(201);
    expect(await laneOf(anna.id, w.g)).toEqual([
      ["others", w.member.id],
      ["own", w.owner.id],
    ]);

    await say(w.owner, anna.conversationId, "你好");
    await fail(anna.id, anna.conversationId);
    expect((await api(app, w.owner, "POST", `/api/conversations/${anna.conversationId}/runs/retry`)).status).toBe(201);
    expect(await laneOf(anna.id, anna.conversationId)).toEqual([
      ["own", w.owner.id],
      ["own", w.owner.id],
    ]);
  });

  it("a persona draft is its owner's own", async () => {
    const owner = await signUp(app, "drafter");
    gateway.reply("你是小橘，一个温和的读书伙伴。");
    expect((await api(app, owner, "POST", "/api/agents/draft-persona", { name: "小橘", model: FAST })).status).toBe(200);
    expect((await db.query("select purpose, lane, caller_id from agent_runs where owner_id = $1", [owner.id])).rows).toEqual([
      { purpose: "draft", lane: "own", caller_id: owner.id },
    ]);
  });

  it("is never on the wire: a run's owner and the other members see no lane and no caller", async () => {
    const w = await world();
    const anna = await agentOf(w.owner, "anna", w.g);
    await say(w.member, w.g, "@anna 你好");
    await db.query("update agent_runs set status = 'failed', error = 'provider_unavailable', finished_at = now() where agent_id = $1", [anna.id]);
    for (const who of [w.owner, w.member]) {
      const seen = JSON.stringify((await api(app, who, "GET", `/api/conversations/${w.g}/runs`)).json);
      expect([who.id, seen.includes("unavailable"), /lane|caller/i.test(seen)]).toEqual([who.id, true, false]);
    }
  });
});
