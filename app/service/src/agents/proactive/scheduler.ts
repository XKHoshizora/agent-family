import type { FastifyBaseLogger } from "fastify";
import type { Triggered } from "../runs.ts";

/**
 * When a group's judgement is asked (batch 2D, design rules 3–5): after a person's message in a group that names no Agent,
 * the scheduler waits for people to stop writing — `delayMs` after the group's latest such message, the debounce — then
 * decides once, about that latest message (`decide`: decide.ts `decideProactive`), and acts on what it decided as the send
 * route does on a mention's outcome after commit (`act`: its notices published, its runs announced). One wait per group: a
 * newer message replaces the one waiting, so several quick messages lead to one judgement. A message naming an Agent
 * cancels what was waiting (an explicit call is under way, rule 3), and so does an Agent's post (the group moved on; the
 * decision would refuse the older message anyway — this only saves asking). Never two judgements of one group at once: a
 * message while one is in flight waits for it to settle, then for a fresh debounce. Groups do not wait for each other.
 *
 * In memory, in this one process (plan ruling: a restart loses at most the judgements of the last debounce, which is
 * "nobody replies"). It never throws and never rejects: what `decide` or `act` throws is logged with the group's id, never
 * a message's text. `close()` cancels every wait and ignores what comes after; a decision in flight finishes, but what it
 * decided is dropped (nothing is published into a closing app). Its timers never hold the process open.
 */
export interface ProactiveScheduler {
  /**
   * After commit: a person's message at `seq` in group `conversationId`; `namesAgent` when its text names an Agent
   * (candidates.ts `namesAnAgent`). A note about an older message than the one waiting or in flight changes nothing: two
   * sends' steps after commit may run out of order.
   */
  noted(conversationId: string, seq: number, namesAgent: boolean): void;
  /** After commit: an Agent posted in group `conversationId`. */
  cancelled(conversationId: string): void;
  close(): void;
  /** Resolves once nothing waits and no decision is in flight (tests; the app's stop waits for it). */
  idle(): Promise<void>;
}

export interface ProactiveSchedulerDeps {
  decide(conversationId: string, seq: number): Promise<Triggered>;
  act(conversationId: string, triggered: Triggered): void | Promise<void>;
  delayMs: number;
  log: Pick<FastifyBaseLogger, "error">;
}

/** A group with a judgement waiting or in flight; a group with neither has no entry. */
interface Group {
  timer: NodeJS.Timeout | null;
  /** The message the next judgement is about: the debounce's, or the one to wait for once the decision in flight settles. */
  seq: number | null;
  /** The message the decision in flight is about; null when none is. */
  deciding: number | null;
}

export function createProactiveScheduler({ decide, act, delayMs, log }: ProactiveSchedulerDeps): ProactiveScheduler {
  const groups = new Map<string, Group>();
  const idlers: Array<() => void> = [];
  let closed = false;

  /** Forgets group `id` once nothing waits or is in flight there; tells `idle()` when no group is left. */
  const tidy = (id: string, g: Group): void => {
    if (g.timer === null && g.seq === null && g.deciding === null) groups.delete(id);
    if (groups.size === 0) for (const done of idlers.splice(0)) done();
  };

  /** (Re)starts the group's debounce for `g.seq`. */
  const wait = (id: string, g: Group): void => {
    if (g.timer !== null) clearTimeout(g.timer);
    g.timer = setTimeout(() => void judge(id, g), delayMs);
    g.timer.unref();
  };

  /** Whatever waited in the group is dropped; a decision in flight there goes on. */
  const drop = (id: string, g: Group): void => {
    if (g.timer !== null) clearTimeout(g.timer);
    g.timer = null;
    g.seq = null;
    tidy(id, g);
  };

  /** The debounce is over: one decision about the message waiting, acted on unless the scheduler closed meanwhile. */
  const judge = async (id: string, g: Group): Promise<void> => {
    const seq = g.seq!;
    g.timer = null;
    g.seq = null;
    g.deciding = seq;
    let triggered: Triggered | null = null;
    try {
      triggered = await decide(id, seq);
    } catch (err) {
      log.error({ err, conversationId: id }, "a proactive judgement failed: no Agent replies unasked to that message");
    }
    if (triggered !== null && !closed) {
      try {
        await act(id, triggered);
      } catch (err) {
        log.error({ err, conversationId: id }, "what a proactive judgement decided could not be published");
      }
    }
    g.deciding = null;
    if (!closed && g.seq !== null) wait(id, g);
    tidy(id, g);
  };

  return {
    noted(conversationId, seq, namesAgent) {
      if (closed) return;
      const known = groups.get(conversationId);
      if (known && seq <= Math.max(known.seq ?? 0, known.deciding ?? 0)) return;
      if (namesAgent) {
        if (known) drop(conversationId, known);
        return;
      }
      const g = known ?? { timer: null, seq: null, deciding: null };
      groups.set(conversationId, g);
      g.seq = seq;
      // While a decision is in flight, the fresh debounce starts once it settles (`judge`).
      if (g.deciding === null) wait(conversationId, g);
    },
    cancelled(conversationId) {
      if (closed) return;
      const g = groups.get(conversationId);
      if (g) drop(conversationId, g);
    },
    close() {
      closed = true;
      for (const [id, g] of groups) drop(id, g);
    },
    idle() {
      return groups.size === 0 ? Promise.resolve() : new Promise((done) => idlers.push(done));
    },
  };
}
