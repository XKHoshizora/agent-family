import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { createAgentWorker } from "../src/agents/runtime/worker.ts";
import type { ModelGateway } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { nextSiteMidnight } from "../src/accounts/store.ts";
import { grant, METER_ENV } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * Reminders to the owner (Task H, rule 6; README "Metering", Reminders; src/metering/reminders.ts): a whisper of kind
 * `allowance`, no button, in the replying Agent's own conversation, seen by its owner alone — when the day's free allowance
 * is 80 % used (`ALLOWANCE.warnAt`), when it is used up and the balance is at or below zero (it comes back at the site's
 * midnight), at most one of each per owner and site day, whichever Agent replied; and `余额用完了。` each time a reply takes
 * the balance from above zero to zero or below. Counters only in the log. On the real port and database with the meter
 * models (3 free points a day; 1 000 micro-points an output token).
 */

const lines: string[] = [];
/** The app's own model gateway: what persona drafts call. */
const drafts = scriptedGateway();
const { app, db } = useApp({ env: METER_ENV, models: drafts, agentWorker: false, logStream: { write: (line) => void lines.push(line) } });

afterEach(async () => {
  await closeAllSockets();
});

const FREE = { source: "site", id: "meter_free" } as const;
const PAID = { source: "site", id: "meter_paid" } as const;
const POINT = 1_000_000n;
const WARN = "这个周期的额度已经用了 80%。";
/**
 * When the allowance comes back, written as the web writes a date ("M月D日 HH:MM", app/web/src/data/errorTexts.js
 * `resetTimeText`), in the site's time zone: a whisper stays open for days, so never "明天".
 */
const resetText = (): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(nextSiteMidnight(new Date(), "Asia/Shanghai"))
      .map((x) => [x.type, x.value]),
  );
  return `${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`;
};
const EMPTY = `额度用完了，${resetText()} 恢复。`;
const BALANCE = "余额用完了。";
/** `n` output tokens: n × 1 000 micro-points on a meter model. */
const out = (n: number) => ({ inputTokens: 0, outputTokens: n });

function workerWith(gateway: ModelGateway) {
  const { db: pool, config, blobs, conversations, reads } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 16, background: false, log: app.log });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `mr${++txn}` });
  expect(sent.status).toBe(201);
};

/** The owner's whispers in `conv`, oldest first, as text. */
const whispersIn = async (who: Actor, conv: string): Promise<string[]> => {
  const res = await api(app, who, "GET", `/api/conversations/${conv}/whispers`);
  expect(res.status).toBe(200);
  return (res.json.whispers as Array<{ kind: string; text: string; actions: string[] }>)
    .map((w) => {
      expect(w).toMatchObject({ kind: "allowance", actions: [] });
      return w.text;
    })
    .reverse();
};
const metrics = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => typeof e.metric === "string" && /^(allowance_|balance_)/.test(e.metric as string));
const freeUsed = async (ownerId: string) =>
  (await db.query<{ used: string }>("select coalesce(sum(used_micro), 0)::text as used from free_usage where owner_id = $1", [ownerId])).rows[0]!.used;
/** Someone else's spending (a persona draft, say): today's free allowance used, set to `micro`. */
const setFreeUsed = (ownerId: string, micro: bigint) =>
  db.query(
    `insert into free_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, $2)
     on conflict (owner_id, day) do update set used_micro = $2`,
    [ownerId, micro.toString()],
  );

describe("reminders of the day's free allowance and of the balance", () => {
  it("at 80 % once, used up once (the balance at zero), not again the same day — whichever Agent replies —, and a new day starts over", async () => {
    const gateway = scriptedGateway();
    for (const n of [1000, 1000, 500, 400, 1000, 500]) gateway.reply("好。", { usage: out(n) });
    const worker = workerWith(gateway);
    const owner = await signUp(app, "warned");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const bob = await mustCreateAgent(app, owner, { model: FREE, name: "Bob", persona: "简短地回答。" });
    lines.length = 0;
    const reply = async (conv: string) => {
      await say(owner, conv, "你好");
      expect(await worker.runOnce()).toBe(true);
    };

    await reply(ann.conversationId); // 1 of 3 points
    await reply(ann.conversationId); // 2
    expect(await whispersIn(owner, ann.conversationId)).toEqual([]);
    await reply(ann.conversationId); // 2.5: past 80 %
    expect(await whispersIn(owner, ann.conversationId)).toEqual([WARN]);
    await reply(bob.conversationId); // 2.9: Bob's reply, the same owner and day — nothing again
    expect(await whispersIn(owner, bob.conversationId)).toEqual([]);
    await reply(bob.conversationId); // 3 (the rest forgiven), and no balance: used up
    expect(await freeUsed(owner.id)).toBe("3000000");
    expect(await whispersIn(owner, bob.conversationId)).toEqual([EMPTY]);
    // Refused now: nothing settles, nothing more is said.
    await say(owner, bob.conversationId, "还在吗");
    await worker.runOnce();
    expect(await whispersIn(owner, bob.conversationId)).toEqual([EMPTY]);
    expect(await whispersIn(owner, ann.conversationId)).toEqual([WARN]);
    expect(metrics().map((m) => m.metric)).toEqual(["allowance_warn_80", "allowance_empty"]);
    // Counters only: no owner, Agent, conversation or amount with them.
    for (const m of metrics()) expect(Object.keys(m).filter((k) => !["level", "time", "pid", "hostname", "msg", "metric"].includes(k))).toEqual([]);

    // The next site day: what today used and was told moves to yesterday; today starts over.
    await db.query("update free_usage set day = day - 1 where owner_id = $1", [owner.id]);
    await db.query("update allowance_reminders set day = day - 1 where owner_id = $1", [owner.id]);
    await setFreeUsed(owner.id, 2n * POINT);
    await reply(ann.conversationId); // 2.5 of today's 3
    expect(await whispersIn(owner, ann.conversationId)).toEqual([WARN, WARN]);
    // Yesterday's are gone: one row, today's warning.
    expect((await db.query("select threshold from allowance_reminders where owner_id = $1", [owner.id])).rows).toEqual([{ threshold: "warn" }]);
    expect(gateway.pending()).toBe(0);
  });

  it("余额用完了 each time a reply takes the balance from above zero to zero or below — and not while it stays there", async () => {
    const gateway = scriptedGateway();
    for (let i = 0; i < 4; i++) gateway.reply("好。", { usage: out(1000) });
    const worker = workerWith(gateway);
    const owner = await signUp(app, "spender");
    const tess = await mustCreateAgent(app, owner, { model: PAID, name: "Tess", persona: "简短地回答。" });
    const conv = tess.conversationId as string;
    const reply = async () => {
      await say(owner, conv, "你好");
      expect(await worker.runOnce()).toBe(true);
    };
    await grant(app.deps.db, owner.id, (3n * POINT) / 2n);
    lines.length = 0;
    await reply(); // 0.5 left
    expect(await whispersIn(owner, conv)).toEqual([]);
    await reply(); // −0.5: crossed
    expect(await whispersIn(owner, conv)).toEqual([BALANCE]);
    await reply(); // refused: nothing settles
    expect(await whispersIn(owner, conv)).toEqual([BALANCE]);
    await grant(app.deps.db, owner.id, 2n * POINT); // 1.5
    await reply(); // 0.5
    await reply(); // −0.5: crossed again
    expect(await whispersIn(owner, conv)).toEqual([BALANCE, BALANCE]);
    // The free allowance was never touched: no allowance reminder.
    expect(metrics().map((m) => m.metric)).toEqual(["balance_empty", "balance_empty"]);
    expect(gateway.pending()).toBe(0);
  });

  it("in a group: a reply someone else called for that crosses 80 % tells the Agent's owner in the Agent's own conversation; the group and its other members see nothing of it", async () => {
    const gateway = scriptedGateway().reply("好的。", { usage: out(500) });
    const worker = workerWith(gateway);
    const owner = await signUp(app, "groupowner");
    const mia = await signUp(app, "groupmia");
    const ned = await signUp(app, "groupned");
    const agent = await mustCreateAgent(app, owner, { model: FREE, handle: "warn_bot", name: "Warn Bot", persona: "简短地回答。" });
    const g = await group(app, owner, "team", [mia, ned]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await setFreeUsed(owner.id, 2n * POINT);
    const [miaSocket, ownerSocket] = [await connect(app, mia), await connect(app, owner)];
    const readsOf = async (who: Actor) => {
      const out: unknown[] = [];
      for (const url of ["/api/sync", `/api/conversations/${g}`, `/api/conversations/${g}/messages`, `/api/conversations/${g}/runs`]) out.push((await api(app, who, "GET", url)).json);
      out.push((await api(app, who, "POST", "/api/sync/catchup", { positions: { [g]: 0 } })).json);
      return out;
    };
    await say(mia, g, "@warn_bot 你好");
    expect(await worker.runOnce()).toBe(true);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.kind === "allowance" && e.whisper.conversationId === agent.conversationId);
    expect(await whispersIn(owner, agent.conversationId)).toEqual([WARN]);
    expect((await api(app, owner, "GET", `/api/conversations/${g}/whispers`)).json.whispers).toEqual([]);
    // Mia: no whisper frame, nothing of it in any frame or anything she reads.
    await vi.waitFor(() => expect(miaSocket.events.some((e) => e.type === "message" && e.message.senderId === agent.id)).toBe(true));
    for (const e of miaSocket.events) {
      expect(e.type).not.toBe("whisper");
      expect(JSON.stringify(e)).not.toMatch(/额度|allowance|余额/);
    }
    for (const body of await readsOf(mia)) expect(JSON.stringify(body)).not.toMatch(/额度|allowance|余额/);
    expect(gateway.pending()).toBe(0);
  });

  it("two replies of one owner settling at once, both finding 80 % passed, behind a third holder of the account row: both end, no deadlock, one reminder", async () => {
    const gateway = scriptedGateway();
    const [one, two] = [gateway.hang(), gateway.hang()];
    const worker = workerWith(gateway);
    const owner = await signUp(app, "twosettle");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const bob = await mustCreateAgent(app, owner, { model: FREE, name: "Bob", persona: "简短地回答。" });
    await say(owner, ann.conversationId, "你好");
    await say(owner, bob.conversationId, "你好");
    // Both start on today's 3 points (their holds fit together); then someone else's spending takes the day to 2.4 used.
    const runs = [worker.runOnce(), worker.runOnce()];
    await Promise.all([one.reached, two.reached]);
    await setFreeUsed(owner.id, (12n * POINT) / 5n);
    const holder = await db.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from accounts where principal_id = $1 for update", [owner.id]);
      one.release("一。", { usage: out(100) });
      two.release("二。", { usage: out(100) });
      await vi.waitFor(
        async () =>
          expect(
            (await db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from accounts where principal_id = $1 for update%'"))
              .rows[0]!.n,
          ).toBe(2),
        { timeout: 5_000 },
      );
      await holder.query("commit");
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    await Promise.all(runs);
    expect([...(await whispersIn(owner, ann.conversationId)), ...(await whispersIn(owner, bob.conversationId))]).toEqual([WARN]);
    expect((await db.query("select threshold from allowance_reminders where owner_id = $1", [owner.id])).rows).toEqual([{ threshold: "warn" }]);
    expect(gateway.pending()).toBe(0);
  });

  it("a persona draft that takes the allowance past 80 % tells its owner too: in the conversation of the Agent they used last, in the same transaction as the draft's settlement", async () => {
    const owner = await signUp(app, "draftwarn");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const bob = await mustCreateAgent(app, owner, { model: FREE, name: "Bob", persona: "简短地回答。" });
    await say(owner, ann.conversationId, "早");
    await say(owner, bob.conversationId, "晚");
    await setFreeUsed(owner.id, (23n * POINT) / 10n);
    drafts.reply("你是一个助手。", { usage: out(200) });
    lines.length = 0;
    expect((await api(app, owner, "POST", "/api/agents/draft-persona", { name: "Cai", model: FREE })).status).toBe(200);
    expect(await whispersIn(owner, bob.conversationId)).toEqual([WARN]);
    expect(await whispersIn(owner, ann.conversationId)).toEqual([]);
    expect(metrics().map((m) => m.metric)).toEqual(["allowance_warn_80"]);
    expect(drafts.pending()).toBe(0);
  });

  it("a reply whose Agent was deleted while it ran still tells its owner, in the conversation of the Agent they used last of those left", async () => {
    const gateway = scriptedGateway().reply("早。", { usage: out(0) });
    const call = gateway.hang();
    const worker = workerWith(gateway);
    const owner = await signUp(app, "deletedwarn");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const bob = await mustCreateAgent(app, owner, { model: FREE, name: "Bob", persona: "简短地回答。" });
    const cai = await mustCreateAgent(app, owner, { model: FREE, name: "Cai", persona: "简短地回答。" });
    // Cai was used before Bob was; Ann's conversation, used last of all, goes with Ann.
    await say(owner, cai.conversationId, "早");
    expect(await worker.runOnce()).toBe(true);
    await say(owner, bob.conversationId, "也早");
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where conversation_id = $1 and status = 'queued'", [bob.conversationId]);
    await setFreeUsed(owner.id, (12n * POINT) / 5n - 1n);
    await say(owner, ann.conversationId, "你好");
    const running = worker.runOnce();
    await call.reached;
    expect((await api(app, owner, "DELETE", `/api/agents/${ann.id}`)).status).toBe(200);
    call.release("好。", { usage: out(100) });
    await running;
    expect(BigInt(await freeUsed(owner.id))).toBeGreaterThanOrEqual((12n * POINT) / 5n);
    expect(await whispersIn(owner, bob.conversationId)).toEqual([WARN]);
    expect(await whispersIn(owner, cai.conversationId)).toEqual([]);
    expect(gateway.pending()).toBe(0);
  });
});
