import type { FastifyBaseLogger } from "fastify";
import type { Triggered } from "../runs.ts";
import { createHourlyCap } from "./hourly.ts";

/**
 * When a group's judgement is asked (batch 2D, design rules 3–5): after a person's message in a group that calls no Agent,
 * the scheduler waits for people to stop writing — `delayMs` after the group's latest such message, the debounce — then
 * decides once, about that latest message (`decide`: decide.ts `decideProactive`), and acts on what it decided as the send
 * route does on a mention's outcome after commit (`act`: its notices published, its runs announced). One wait per group: a
 * newer message replaces the one waiting, so several quick messages lead to one judgement. A message that calls an Agent
 * cancels what was waiting (an explicit call is under way, rule 3), and so does an Agent's post (the group moved on; the
 * decision would refuse the older message anyway — this only saves asking). Never two judgements of one group at once: a
 * message while one is in flight waits for it to settle, then for a fresh debounce. At most `maxAtOnce` decisions are in
 * flight, all groups together: a group whose debounce is over while that many are waits its turn, oldest first. No group
 * and no sender may use up the site's judgements of the day: once the judgement model has been asked `perGroupHour`
 * times within the last hour about the group, or `perSenderHour` times about messages of the latest one's sender, its
 * decision is skipped — neither queued nor judged — and that is logged once an hour of each group and each sender
 * (`judge_capped`, ids only). Only a decision that asks counts (it says so, `decide`'s `asked`): one that ends before —
 * no Agent to ask about, a message no longer to judge — counts for nothing.
 *
 * In memory, in this one process (plan ruling: a restart loses at most the judgements of the last debounce, which is
 * "nobody replies"). It never throws and never rejects: what `decide` or `act` throws is logged with the group's id, never
 * a message's text. `close()` cancels every wait and ignores what comes after; a decision in flight finishes, but what it
 * decided is dropped (nothing is published into a closing app). Its timers never hold the process open.
 */
export interface ProactiveScheduler {
  /**
   * After commit: person `senderId`'s message at `seq` in group `conversationId`; `namesAgent` when it called an Agent
   * (the send route: its trigger acted on or refused a call). A note about a message no newer than the one the group
   * waits with or decides about changes nothing (two sends' steps after commit may run out of order); once nothing waits
   * there that is forgotten, and a late note about an older message starts a wait whose decision refuses it — a decision
   * judges only the group's latest message.
   */
  noted(conversationId: string, seq: number, senderId: string, namesAgent: boolean): void;
  /** After commit: an Agent posted in group `conversationId`. */
  cancelled(conversationId: string): void;
  /** Cancels every wait, and forgets what the hourly caps counted. */
  close(): void;
  /** Resolves once nothing waits and no decision is in flight (tests; the app's stop waits for it). */
  idle(): Promise<void>;
  /** How many groups and senders the hourly caps remember (tests: nothing outlives its hour, nor `close()`). */
  remembered(): number;
}

/**
 * The decisions in flight at once by default, all groups together. Each holds a database connection for its reads and
 * may wait on the judgement model, whose client takes 32 calls at once and refuses the rest outright (a refusal still
 * counts toward the site's daily judgements and means "nobody replies"): this stays well under both.
 */
export const MAX_DECISIONS_AT_ONCE = 8;

export interface ProactiveSchedulerDeps {
  /** Decides about message `seq` of the group; calls `asked` as it asks the judgement model (at most once). */
  decide(conversationId: string, seq: number, asked: () => void): Promise<Triggered>;
  act(conversationId: string, triggered: Triggered): void | Promise<void>;
  delayMs: number;
  /** Default `MAX_DECISIONS_AT_ONCE`. */
  maxAtOnce?: number;
  /** The most times within an hour the judgement model is asked about one group (`PROACTIVE.perGroupHour`). */
  perGroupHour: number;
  /** The most times within an hour it is asked about one sender's messages, in any group (`PROACTIVE.perSenderHour`). */
  perSenderHour: number;
  log: Pick<FastifyBaseLogger, "error" | "info">;
}

/** A group with a judgement waiting (on its debounce, or for a place) or in flight; a group with none has no entry. */
interface Group {
  timer: NodeJS.Timeout | null;
  /** The message the next judgement is about, and its sender; null when none waits. */
  seq: number | null;
  sender: string | null;
  /** Its debounce is over and it waits for a decision's place (it is in the queue). */
  queued: boolean;
  /** The message the decision in flight is about; null when none is. */
  deciding: number | null;
}

export function createProactiveScheduler({
  decide,
  act,
  delayMs,
  maxAtOnce = MAX_DECISIONS_AT_ONCE,
  perGroupHour,
  perSenderHour,
  log,
}: ProactiveSchedulerDeps): ProactiveScheduler {
  const groups = new Map<string, Group>();
  /** The judgements asked for within the last hour, by group and by the sender of the message judged. */
  const byGroup = createHourlyCap(perGroupHour);
  const bySender = createHourlyCap(perSenderHour);
  /** The groups waiting for a decision's place, oldest first. */
  const queue: string[] = [];
  const idlers: Array<() => void> = [];
  let running = 0;
  let closed = false;

  /** Forgets group `id` once nothing waits or is in flight there; tells `idle()` when no group is left. */
  const tidy = (id: string, g: Group): void => {
    if (g.timer === null && g.seq === null && g.deciding === null) groups.delete(id);
    if (groups.size === 0) for (const done of idlers.splice(0)) done();
  };

  /** (Re)starts the group's debounce for `g.seq`. */
  const wait = (id: string, g: Group): void => {
    if (g.timer !== null) clearTimeout(g.timer);
    g.timer = setTimeout(() => ready(id, g), delayMs);
    g.timer.unref();
  };

  /** Whatever waited in the group (on its debounce or for a place) is dropped; a decision in flight there goes on. */
  const drop = (id: string, g: Group): void => {
    if (g.timer !== null) clearTimeout(g.timer);
    g.timer = null;
    if (g.queued) queue.splice(queue.indexOf(id), 1);
    g.queued = false;
    g.seq = null;
    g.sender = null;
    tidy(id, g);
  };

  /**
   * Whether the group, or the sender of the message it waits with, has had its judgements of the hour: then nothing waits
   * there any more (`drop`). Logged once an hour of each group and each sender.
   */
  const capped = (id: string, g: Group): boolean => {
    const now = Date.now();
    const sender = g.sender!;
    if (byGroup.full(id, now)) {
      if (byGroup.tell(id, now)) log.info({ metric: "judge_capped", scope: "group", conversationId: id }, "a group's judgements of the hour are used up: its messages are not judged for now");
    } else if (bySender.full(sender, now)) {
      if (bySender.tell(sender, now)) {
        log.info({ metric: "judge_capped", scope: "sender", conversationId: id, senderId: sender }, "a sender's judgements of the hour are used up: their messages are not judged for now");
      }
    } else {
      return false;
    }
    drop(id, g);
    return true;
  };

  /** The debounce is over: decided now if there is a place, else in turn — unless the group or the sender is capped. */
  const ready = (id: string, g: Group): void => {
    g.timer = null;
    if (capped(id, g)) return;
    if (running < maxAtOnce) judge(id, g);
    else {
      g.queued = true;
      queue.push(id);
    }
  };

  /**
   * One decision about the message the group waits with — counted for the group and for the message's sender if, and as,
   * it asks the judgement model — acted on unless the scheduler closed meanwhile.
   */
  const judge = (id: string, g: Group): void => {
    const seq = g.seq!;
    const sender = g.sender!;
    g.seq = null;
    g.sender = null;
    g.queued = false;
    g.deciding = seq;
    running++;
    const asked = (): void => {
      if (closed) return;
      const now = Date.now();
      byGroup.count(id, now);
      bySender.count(sender, now);
    };
    void decideAndAct(id, seq, asked)
      .finally(() => settled(id, g))
      // Only a logger that throws gets here; nothing is left to tell, and nothing may go unhandled.
      .catch(() => {});
  };

  const decideAndAct = async (id: string, seq: number, asked: () => void): Promise<void> => {
    let triggered: Triggered | null = null;
    try {
      triggered = await decide(id, seq, asked);
    } catch (err) {
      log.error({ err, conversationId: id }, "a proactive judgement failed: no Agent replies unasked to that message");
    }
    if (triggered === null || closed) return;
    try {
      await act(id, triggered);
    } catch (err) {
      log.error({ err, conversationId: id }, "what a proactive judgement decided could not be published");
    }
  };

  /**
   * A decision ended: a message noted meanwhile gets a fresh debounce, and the oldest group waiting takes the place —
   * unless it is capped by now.
   */
  const settled = (id: string, g: Group): void => {
    running--;
    g.deciding = null;
    if (!closed && g.seq !== null) wait(id, g);
    tidy(id, g);
    while (!closed && running < maxAtOnce && queue.length > 0) {
      const next = queue.shift()!;
      const waiting = groups.get(next)!;
      waiting.queued = false;
      if (!capped(next, waiting)) judge(next, waiting);
    }
  };

  return {
    noted(conversationId, seq, senderId, namesAgent) {
      if (closed) return;
      const known = groups.get(conversationId);
      if (known && seq <= Math.max(known.seq ?? 0, known.deciding ?? 0)) return;
      if (namesAgent) {
        if (known) drop(conversationId, known);
        return;
      }
      const g = known ?? { timer: null, seq: null, sender: null, queued: false, deciding: null };
      groups.set(conversationId, g);
      g.seq = seq;
      g.sender = senderId;
      // A group waiting for a place keeps it, with the newer message; while a decision is in flight, the fresh debounce
      // starts once it settles (`settled`).
      if (g.deciding === null && !g.queued) wait(conversationId, g);
    },
    cancelled(conversationId) {
      if (closed) return;
      const g = groups.get(conversationId);
      if (g) drop(conversationId, g);
    },
    close() {
      closed = true;
      for (const [id, g] of groups) drop(id, g);
      byGroup.clear();
      bySender.clear();
    },
    idle() {
      return groups.size === 0 ? Promise.resolve() : new Promise((done) => idlers.push(done));
    },
    remembered: () => byGroup.size() + bySender.size(),
  };
}
