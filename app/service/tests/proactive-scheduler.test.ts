import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProactiveScheduler, type ProactiveScheduler } from "../src/agents/proactive/scheduler.ts";
import { noneTriggered, type Triggered } from "../src/agents/runs.ts";
import { buildApp } from "../src/app.ts";
import { lockConversation } from "../src/conversations/store.ts";
import type { Db } from "../src/db.ts";
import type { Question } from "../src/judge/client.ts";
import { insertMessage } from "../src/messages/model.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { scriptedJudge, type ScriptedAnswers } from "./helpers/judge.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * When a group's judgement is asked (batch 2D, Task 5; design rules 3–5, 13–14): after a person's message in a group
 * that names no Agent, the scheduler waits for people to stop (the debounce), then decides once — about the latest —
 * and acts on it as on a mention's outcome. First the scheduler alone, with a fake decision and fake timers; then through
 * the real app with the scripted judgement model: what the send route and an Agent's post tell it, what comes of a
 * decision (with the reply worker running), and that nothing of it exists without a judgement model.
 */

// --- the scheduler alone ---------------------------------------------------------------------------------------------

/** A promise settled from outside. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface Fake {
  scheduler: ProactiveScheduler;
  /** Every decision asked for, in order. */
  decided: Array<[string, number]>;
  /** What each decision returned, in order (the very objects `act` must get). */
  returned: Triggered[];
  acted: Array<[string, Triggered]>;
  /** What was logged at error: the fields and the message. */
  errors: Array<{ fields: Record<string, unknown>; msg: string }>;
  /** The decisions held (with `hold`), in the order they began: settle them by hand. */
  held: Array<Deferred<Triggered>>;
  /** The most decisions in flight at once for one conversation. */
  mostAtOnce: number;
}

const DELAY = 20;

/**
 * A scheduler over a recording `decide` and `act`. `hold`: each decision waits until the test settles it; `decide`
 * replaces the decision's outcome (thrown or returned) after it is recorded; `act` likewise.
 */
function fake(opts: { hold?: boolean; decide?: (call: number) => Triggered | Promise<Triggered>; act?: (call: number) => void | Promise<void> } = {}): Fake {
  const f = { decided: [], returned: [], acted: [], errors: [], held: [], mostAtOnce: 0 } as unknown as Fake;
  const inFlight = new Map<string, number>();
  const log = { error: (fields: Record<string, unknown>, msg: string) => void f.errors.push({ fields, msg }) } as unknown as Pick<FastifyBaseLogger, "error">;
  f.scheduler = createProactiveScheduler({
    delayMs: DELAY,
    log,
    decide: (conversationId, seq) => {
      f.decided.push([conversationId, seq]);
      const call = f.decided.length;
      inFlight.set(conversationId, (inFlight.get(conversationId) ?? 0) + 1);
      f.mostAtOnce = Math.max(f.mostAtOnce, inFlight.get(conversationId)!);
      const done = () => inFlight.set(conversationId, inFlight.get(conversationId)! - 1);
      const outcome = (): Promise<Triggered> => {
        if (opts.hold) {
          const d = deferred<Triggered>();
          f.held.push(d);
          return d.promise;
        }
        if (opts.decide) return Promise.resolve(opts.decide(call));
        return Promise.resolve(noneTriggered());
      };
      let pending: Promise<Triggered>;
      try {
        pending = outcome();
      } catch (err) {
        done();
        throw err; // a decision that throws at once
      }
      return pending.then(
        (t) => (done(), f.returned.push(t), t),
        (err: unknown) => {
          done();
          throw err;
        },
      );
    },
    act: (conversationId, triggered) => {
      f.acted.push([conversationId, triggered]);
      return opts.act?.(f.acted.length);
    },
  });
  return f;
}

/** Lets every promise chain already under way run on (microtasks only; the fake clock does not move). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Whether `promise` settles before the fake clock moves. */
async function settlesNow(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true));
  await flush();
  return settled;
}

describe("the scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("several messages in quick succession: one decision, about the latest, `delayMs` after it; its outcome is acted on", async () => {
    const f = fake();
    f.scheduler.noted("g", 3, false);
    f.scheduler.noted("g", 4, false);
    f.scheduler.noted("g", 5, false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(f.decided).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await f.scheduler.idle();
    expect(f.decided).toEqual([["g", 5]]);
    expect(f.acted).toHaveLength(1);
    expect(f.acted[0]![0]).toBe("g");
    expect(f.acted[0]![1]).toBe(f.returned[0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("each message starts the wait again: people are waited for until they stop", async () => {
    const f = fake();
    f.scheduler.noted("g", 1, false);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    f.scheduler.noted("g", 2, false);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    f.scheduler.noted("g", 3, false);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(f.decided).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await f.scheduler.idle();
    expect(f.decided).toEqual([["g", 3]]);
  });

  it("a message naming an Agent cancels what was waiting and starts nothing", async () => {
    const f = fake();
    f.scheduler.noted("g", 1, false);
    f.scheduler.noted("g", 2, true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await settlesNow(f.scheduler.idle())).toBe(true);
    // Naming an Agent with nothing waiting: nothing either.
    f.scheduler.noted("g", 3, true);
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(f.decided).toEqual([]);
    expect(f.acted).toEqual([]);
  });

  it("`cancelled` (an Agent posted) drops what was waiting; for a group with nothing waiting it does nothing", async () => {
    const f = fake();
    f.scheduler.cancelled("nowhere");
    f.scheduler.noted("g", 1, false);
    f.scheduler.cancelled("g");
    expect(vi.getTimerCount()).toBe(0);
    expect(await settlesNow(f.scheduler.idle())).toBe(true);
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(f.decided).toEqual([]);
  });

  it("a message while a decision is in flight starts no second one; once it settles, a fresh wait, then one decision about the newest", async () => {
    const f = fake({ hold: true });
    f.scheduler.noted("g", 1, false);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.decided).toEqual([["g", 1]]);
    f.scheduler.noted("g", 2, false);
    f.scheduler.noted("g", 3, false);
    expect(vi.getTimerCount()).toBe(0); // nothing waits while it is in flight
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(f.decided).toEqual([["g", 1]]);
    expect(await settlesNow(f.scheduler.idle())).toBe(false);

    const first = noneTriggered();
    f.held[0]!.resolve(first);
    await flush();
    expect(f.acted).toEqual([["g", first]]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(f.decided).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.decided).toEqual([
      ["g", 1],
      ["g", 3],
    ]);
    const second = noneTriggered();
    f.held[1]!.resolve(second);
    await f.scheduler.idle();
    expect(f.acted).toEqual([
      ["g", first],
      ["g", second],
    ]);
    expect(f.mostAtOnce).toBe(1);
  });

  it("while a decision is in flight, a message naming an Agent or an Agent's post leaves nothing to follow it; what it decided is still acted on", async () => {
    for (const drop of [(s: ProactiveScheduler) => s.noted("g", 3, true), (s: ProactiveScheduler) => s.cancelled("g")]) {
      const f = fake({ hold: true });
      f.scheduler.noted("g", 1, false);
      await vi.advanceTimersByTimeAsync(DELAY);
      f.scheduler.noted("g", 2, false);
      drop(f.scheduler);
      const outcome = noneTriggered();
      f.held[0]!.resolve(outcome);
      await f.scheduler.idle();
      await vi.advanceTimersByTimeAsync(DELAY * 5);
      expect(f.decided).toEqual([["g", 1]]);
      expect(f.acted).toEqual([["g", outcome]]);
    }
  });

  it("a note about an older message than the one waiting or in flight changes nothing (after-commit steps may run out of order)", async () => {
    const f = fake();
    f.scheduler.noted("g", 5, false);
    f.scheduler.noted("g", 4, false);
    f.scheduler.noted("g", 4, true);
    await vi.advanceTimersByTimeAsync(DELAY);
    await f.scheduler.idle();
    expect(f.decided).toEqual([["g", 5]]);
  });

  it("a decision that throws or rejects is logged with the conversation's id only; later messages are still decided", async () => {
    const thrown = new Error("thrown at once");
    const rejected = new Error("rejected");
    const f = fake({
      decide: (call) => {
        if (call === 1) throw thrown;
        if (call === 2) return Promise.reject(rejected);
        return noneTriggered();
      },
    });
    for (const seq of [1, 2, 3]) {
      expect(() => f.scheduler.noted("g", seq, false)).not.toThrow();
      await vi.advanceTimersByTimeAsync(DELAY);
      await f.scheduler.idle();
    }
    expect(f.decided).toEqual([
      ["g", 1],
      ["g", 2],
      ["g", 3],
    ]);
    expect(f.errors.map((e) => e.fields)).toEqual([
      { err: thrown, conversationId: "g" },
      { err: rejected, conversationId: "g" },
    ]);
    expect(f.acted).toHaveLength(1);
  });

  it("acting that throws or rejects is logged; later messages are still decided and acted on", async () => {
    const thrown = new Error("publish failed");
    const rejected = new Error("announce failed");
    const f = fake({
      act: (call) => {
        if (call === 1) throw thrown;
        if (call === 2) return Promise.reject(rejected);
      },
    });
    for (const seq of [1, 2, 3]) {
      f.scheduler.noted("g", seq, false);
      await vi.advanceTimersByTimeAsync(DELAY);
      await f.scheduler.idle();
    }
    expect(f.acted).toHaveLength(3);
    expect(f.errors.map((e) => e.fields)).toEqual([
      { err: thrown, conversationId: "g" },
      { err: rejected, conversationId: "g" },
    ]);
  });

  it("close(): no timer is left, later notes do nothing, and what a decision in flight decides is dropped", async () => {
    // A wait under way.
    const waiting = fake();
    waiting.scheduler.noted("g", 1, false);
    waiting.scheduler.noted("h", 1, false);
    waiting.scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(await settlesNow(waiting.scheduler.idle())).toBe(true);
    waiting.scheduler.noted("g", 2, false);
    waiting.scheduler.cancelled("g");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(waiting.decided).toEqual([]);

    // A decision in flight: it finishes, nothing is acted on, nothing follows it.
    const flying = fake({ hold: true });
    flying.scheduler.noted("g", 1, false);
    await vi.advanceTimersByTimeAsync(DELAY);
    flying.scheduler.noted("g", 2, false);
    flying.scheduler.close();
    const idle = flying.scheduler.idle();
    expect(await settlesNow(idle)).toBe(false);
    flying.held[0]!.resolve(noneTriggered());
    await idle;
    await vi.advanceTimersByTimeAsync(DELAY * 5);
    expect(flying.decided).toEqual([["g", 1]]);
    expect(flying.acted).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("conversations are independent: each has its own wait and its own decision, at the same time", async () => {
    const f = fake({ hold: true });
    f.scheduler.noted("a", 1, false);
    f.scheduler.noted("b", 7, false);
    f.scheduler.noted("c", 4, false);
    f.scheduler.cancelled("c");
    f.scheduler.noted("b", 8, true); // naming an Agent in b cancels b only
    f.scheduler.noted("b", 9, false);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.decided).toEqual([
      ["a", 1],
      ["b", 9],
    ]);
    // a is in flight; a message in b is decided meanwhile.
    f.held[1]!.resolve(noneTriggered());
    await flush();
    f.scheduler.noted("b", 10, false);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(f.decided).toEqual([
      ["a", 1],
      ["b", 9],
      ["b", 10],
    ]);
    f.held[0]!.resolve(noneTriggered());
    f.held[2]!.resolve(noneTriggered());
    await f.scheduler.idle();
    expect(f.acted.map(([c]) => c)).toEqual(["b", "a", "b"]);
  });

  it("idle() resolves at once when nothing waits", async () => {
    expect(await settlesNow(fake().scheduler.idle())).toBe(true);
  });

  it("its timers never hold the process open (unref'd)", () => {
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const f = fake();
      f.scheduler.noted("g", 1, false);
      const ours = spy.mock.results.filter((_, i) => spy.mock.calls[i]![1] === DELAY).map((r) => r.value as NodeJS.Timeout);
      expect(ours).toHaveLength(1);
      expect(ours[0]!.hasRef()).toBe(false);
      f.scheduler.close();
    } finally {
      spy.mockRestore();
    }
  });
});

// --- through the app -------------------------------------------------------------------------------------------------

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 4000,
  dailyLimit: 20_000,
};
const judge = scriptedJudge();
const gateway = scriptedGateway();
const FAST = { source: "site", id: "fast" } as const;

beforeEach(() => {
  judge.calls.splice(0);
  judge.answer(() => ({}));
});

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Whether the scheduler has nothing waiting and nothing in flight (it settles within a few milliseconds). */
const idleNow = (scheduler: ProactiveScheduler) => Promise.race([scheduler.idle().then(() => true), sleep(30).then(() => false)]);

/** Counts the timers set from now on with exactly `delay` ms (the scheduler's debounce), and hands them out. */
function debounces(delay: number) {
  const spy = vi.spyOn(globalThis, "setTimeout");
  const ours = () => spy.mock.results.filter((_, i) => spy.mock.calls[i]![1] === delay).map((r) => r.value as NodeJS.Timeout);
  return { count: () => ours().length, timers: ours, stop: () => spy.mockRestore() };
}

interface World {
  owner: Actor;
  member: Actor;
  third: Actor;
  g: string;
}
async function world(app: FastifyInstance): Promise<World> {
  const [owner, member, third] = [await signUp(app, "owner"), await signUp(app, "member"), await signUp(app, "third")];
  return { owner, member, third, g: await group(app, owner, "team", [member, third]) };
}

/** An Agent of `owner` named `handle` on the site model (proactive unless `over` says otherwise), added to `conv` by its owner. */
async function agentIn(app: FastifyInstance, owner: Actor, handle: string, conv: string | null, over: Record<string, unknown> = {}) {
  const agent = (await mustCreateAgent(app, owner, { handle, name: handle, model: FAST, persona: "简短地回答。", proactive: true, ...over })) as {
    id: string;
    conversationId: string;
  };
  if (conv) {
    const added = await api(app, owner, "POST", `/api/conversations/${conv}/members`, { principalId: agent.id });
    if (added.status !== 201) throw new Error(`agentIn: ${added.status} ${JSON.stringify(added.json)}`);
  }
  return agent;
}

let txn = 0;
async function say(app: FastifyInstance, who: Actor, conv: string, text: string): Promise<number> {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ps${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
}

/** A message of the Agent stored as `postAsAgent` stores one (the group's row held), without the worker. */
const agentSays = (db: Db, agentId: string, conv: string, text: string) =>
  db.tx(async (t) => {
    await lockConversation(t, conv);
    return (await insertMessage(t, conv, agentId, "text", { text }, null)).seq;
  });

const runsOf = async (db: Db, agentId: string, conv: string) =>
  (
    await db.query(`select status, lane, covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id`, [
      agentId,
      conv,
    ])
  ).rows;

/** The name an option's description starts with (`nobody` for nobody's). */
const nameOf = (key: string, description: string) => (key === "nobody" ? "nobody" : description.slice(0, description.indexOf("：")));
/** Answers by name: every option of the pick with `pick[name]` (0 when not given), each quiet question `quiet` names. */
const byName =
  (pick: Record<string, number>, quiet: Record<string, number> = {}) =>
  (_state: string, questions: readonly Question[]): ScriptedAnswers => {
    const out: ScriptedAnswers = {};
    for (const q of questions) {
      if (q.type === "choice") out[q.key] = Object.fromEntries(Object.entries(q.options).map(([k, d]) => [k, pick[nameOf(k, d)] ?? 0]));
      else {
        const name = /「(.+?)」/.exec(q.instructions)![1]!;
        if (quiet[name] !== undefined) out[q.key] = quiet[name];
      }
    }
    return out;
  };

describe("what is noted: the send route and an Agent's post", () => {
  // Nothing here waits for a debounce to end: whether one is waiting is read from the scheduler (`idleNow`).
  const LONG = 2_345;
  const { app, db } = useApp({ env: SITE_ENV, judge, models: gateway, agentWorker: false, config: { judge: JUDGE }, proactive: { delayMs: LONG } });
  const scheduler = () => app.deps.proactive!;

  afterEach(() => {
    vi.restoreAllMocks();
    expect(gateway.pending()).toBe(0);
  });

  it("a person's message in a group naming no Agent starts one debounce of the configured wait (unref'd); the next replaces it", async () => {
    const w = await world(app);
    await agentIn(app, w.owner, "anna", w.g);
    const noted = vi.spyOn(scheduler(), "noted");
    const timers = debounces(LONG);
    const first = await say(app, w.member, w.g, "今晚做什么菜好？");
    expect(timers.count()).toBe(1);
    expect(await idleNow(scheduler())).toBe(false);
    const second = await say(app, w.owner, w.g, "我也想知道");
    expect(noted.mock.calls).toEqual([
      [w.g, first, false],
      [w.g, second, false],
    ]);
    expect(timers.count()).toBe(2);
    expect(timers.timers().every((t) => !t.hasRef())).toBe(true);
    scheduler().cancelled(w.g);
    expect(await idleNow(scheduler())).toBe(true);
    expect(judge.calls).toEqual([]);
  });

  it("a message naming an Agent — in the group or not — cancels what was waiting and starts nothing; naming a person does not", async () => {
    const w = await world(app);
    await agentIn(app, w.owner, "anna", w.g);
    await agentIn(app, w.third, "bobbot", null, { proactive: false });
    const noted = vi.spyOn(scheduler(), "noted");
    await say(app, w.member, w.g, "今晚做什么菜好？");
    expect(await idleNow(scheduler())).toBe(false);
    const toAnna = await say(app, w.member, w.g, "@anna 你觉得呢？");
    expect(await idleNow(scheduler())).toBe(true);
    const toBob = await say(app, w.member, w.g, "@BobBot 你会做饭吗？");
    expect(await idleNow(scheduler())).toBe(true);
    const toThird = await say(app, w.member, w.g, `@${w.third.handle} 你呢？`);
    expect(await idleNow(scheduler())).toBe(false);
    expect(noted.mock.calls.slice(1)).toEqual([
      [w.g, toAnna, true],
      [w.g, toBob, true],
      [w.g, toThird, false],
    ]);
    scheduler().cancelled(w.g);
    expect(judge.calls).toEqual([]);
  });

  it("a message in a direct chat or in an Agent's own conversation is never noted, and sets no timer", async () => {
    const w = await world(app);
    const anna = await agentIn(app, w.owner, "anna", null);
    const { conversationId: direct } = await befriend(app, w.member, (await signUp(app, "friend")));
    const noted = vi.spyOn(scheduler(), "noted");
    const timers = debounces(LONG);
    await say(app, w.member, direct, "今晚做什么菜好？");
    await say(app, w.owner, anna.conversationId, "今晚做什么菜好？");
    expect(noted).not.toHaveBeenCalled();
    expect(timers.count()).toBe(0);
    expect(await idleNow(scheduler())).toBe(true);
  });

  it("an Agent's post in the group cancels the judgement waiting there", async () => {
    const w = await world(app);
    const anna = await agentIn(app, w.owner, "anna", w.g);
    const cancelled = vi.spyOn(scheduler(), "cancelled");
    await say(app, w.owner, w.g, "@anna 帮我看看菜单");
    await say(app, w.member, w.g, "今晚做什么菜好？");
    expect(await idleNow(scheduler())).toBe(false);
    gateway.reply("番茄炒蛋。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await runsOf(db, anna.id, w.g)).map((r) => r.status)).toEqual(["done"]);
    expect(cancelled).toHaveBeenCalledWith(w.g);
    expect(await idleNow(scheduler())).toBe(true);
    expect(judge.calls).toEqual([]);
  });

  it("the app closing with a judgement waiting leaves nothing running, and nothing is noted after", async () => {
    const SHORT = 40;
    const own = await buildApp(
      { config: app.deps.config, db, judge, models: gateway },
      { answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false, agentWorker: false, proactive: { delayMs: SHORT } },
    );
    let closed = false;
    try {
      await own.ready();
      const w = await world(own);
      const anna = await agentIn(own, w.owner, "anna", w.g);
      judge.answer(byName({ anna: 0.9 }));
      const timers = debounces(SHORT);
      await say(own, w.member, w.g, "今晚做什么菜好？");
      expect(timers.count()).toBe(1);
      const ownScheduler = own.deps.proactive!;
      expect(await idleNow(ownScheduler)).toBe(false);
      await own.close();
      closed = true;
      expect(await idleNow(ownScheduler)).toBe(true);
      ownScheduler.noted(w.g, 999, false);
      expect(timers.count()).toBe(1);
      await sleep(SHORT * 4);
      expect(judge.calls).toEqual([]);
      expect(await runsOf(db, anna.id, w.g)).toEqual([]);
    } finally {
      if (!closed) await own.close();
    }
  });
});

describe("what comes of it, with the reply worker running", () => {
  const SHORT = 60;
  const { app, db } = useApp({ env: SITE_ENV, judge, models: gateway, config: { judge: JUDGE }, proactive: { delayMs: SHORT } });

  afterEach(async () => {
    await closeAllSockets();
    await app.deps.proactive!.idle();
    expect(gateway.pending()).toBe(0);
  });

  it("a member's on-topic message: once people stop, the Agent's run is queued and announced, and its reply reaches every member", async () => {
    const w = await world(app);
    const anna = await agentIn(app, w.owner, "anna", w.g, { intro: "会做饭的助手", field: "家常菜" });
    const sockets = [await connect(app, w.owner), await connect(app, w.member), await connect(app, w.third)];
    let judgedAt = 0;
    judge.answer((state, questions) => {
      judgedAt = performance.now();
      return byName({ anna: 0.9, nobody: 0.05 })(state, questions);
    });
    gateway.reply("番茄炒蛋，十分钟就好。");
    const before = performance.now();
    const asked = await say(app, w.member, w.g, "今晚做什么菜好？");
    for (const s of sockets) {
      const pushed = await s.next((e) => e.type === "message" && e.message.senderId === anna.id);
      expect(pushed.message.text).toBe("番茄炒蛋，十分钟就好。");
    }
    // Once, about that message, and not before the wait was over.
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]!.state).toContain("今晚做什么菜好？");
    expect(judgedAt - before).toBeGreaterThanOrEqual(SHORT - 5);
    // Announced to its owner as a mention's run is: queued, then the worker's own pushes, to its end.
    await sockets[0]!.waitFor((e) => e.type === "run" && e.conversationId === w.g && e.run?.status === "done");
    expect(sockets[0]!.events.some((e) => e.type === "run" && e.conversationId === w.g && e.agentId === anna.id && e.run?.status === "queued")).toBe(true);
    expect(await runsOf(db, anna.id, w.g)).toEqual([{ status: "done", lane: "proactive", covers: asked }]);
  });

  it("the notice that an Agent keeps quiet, from a decision, is published to every member", async () => {
    const w = await world(app);
    const anna = await agentIn(app, w.owner, "anna", w.g);
    await agentSays(db, anna.id, w.g, "我来说两句");
    const sockets = [await connect(app, w.owner), await connect(app, w.member), await connect(app, w.third)];
    judge.answer(byName({ nobody: 0.9 }, { anna: 0.95 }));
    await say(app, w.member, w.g, "anna 你先别插话了");
    for (const s of sockets) {
      const pushed = await s.next((e) => e.type === "message" && e.message.system?.event === "agent_quieted");
      expect(pushed.message.text).toBe("「anna」暂时不主动发言，需要时可以 @ 它");
    }
    expect(judge.calls).toHaveLength(1);
    expect(await runsOf(db, anna.id, w.g)).toEqual([]);
  });

  it("a message naming an Agent is never judged, though a proactive Agent is there", async () => {
    const w = await world(app);
    const anna = await agentIn(app, w.owner, "anna", w.g);
    await agentIn(app, w.third, "bobbot", null, { proactive: false });
    judge.answer(byName({ anna: 0.9 }));
    await say(app, w.member, w.g, "@bobbot 今晚做什么菜好？");
    await sleep(SHORT * 4);
    await app.deps.proactive!.idle();
    expect(judge.calls).toEqual([]);
    expect(await runsOf(db, anna.id, w.g)).toEqual([]);
  });
});

describe("without a judgement model", () => {
  const DELAY_ASKED = 4_321;
  const { app } = useApp({ env: SITE_ENV, config: { judge: null }, proactive: { delayMs: DELAY_ASKED } });

  it("there is no scheduler: a person's message in a group sets no timer", async () => {
    expect(app.deps.judge).toBeNull();
    expect(app.deps.proactive).toBeNull();
    const w = await world(app);
    const timers = debounces(DELAY_ASKED);
    try {
      await say(app, w.member, w.g, "今晚做什么菜好？");
      expect(timers.count()).toBe(0);
    } finally {
      timers.stop();
    }
  });
});
