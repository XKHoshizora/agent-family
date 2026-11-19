import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { errInfo, reviewableAgent, reviewedSeq, type ReviewContext, type ReviewJob } from "./pipeline.ts";
import { EXPLICIT } from "./review.ts";

/**
 * When a review runs (what it does is pipeline.ts): after an Agent's reply, once the conversation has been quiet
 * `MEMORY.quietMs`, at once after `maxReplies` replies since the last review or when the owner's latest message asks for
 * something to be remembered, forgotten or locked, and at once when the owner starts a new topic. A trigger never fires
 * unless the owner said something after what the last attempt looked at, so a review that failed is not asked again for the
 * same words. One job per Agent at a time (a trigger meanwhile waits and runs once after it), at most
 * `MAX_REVIEWS_AT_ONCE` overall.
 *
 * In memory, in this one process, as the proactive scheduler is: it never throws and never rejects (what goes wrong is
 * logged with ids, never a note or an answer). `close()` cancels every timer and waiting job and abandons calls under way.
 * The job type is open (`kind`) for the jobs a later batch adds. Timers come from the caller, so tests never sleep.
 */

export const MAX_REVIEWS_AT_ONCE = 4;

export type SetTimer = (fn: () => void, ms: number) => { clear(): void };

/** `setTimeout` that never holds the process open. */
export const realTimer: SetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return { clear: () => clearTimeout(timer) };
};

export type Job = ReviewJob;

export interface ReviewerDeps {
  db: Db;
  config: Pick<Config, "memory">;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info">;
  /** The service is stopping: a job under way is told (its `closing`). `close()` ends them too. */
  closing?: AbortSignal;
  setTimer: SetTimer;
  /** Does one job (pipeline.ts `runReview`); may reject: it is logged. */
  run(job: Job, ctx: ReviewContext): Promise<void>;
}

export interface Reviewer {
  /** After commit: Agent `agentId` posted a reply in `conversationId` (its own, or a group). */
  noted(agentId: string, conversationId: string): void;
  /** After commit: the owner started a new topic in the Agent's own conversation. */
  topicReset(agentId: string, conversationId: string): void;
  /** After commit: a message of `conversationId` was flagged for the Agent (a later batch fills this in). */
  flagged(agentId: string, conversationId: string, kind: "hearsay" | "own"): void;
  /** At start: arms a quiet timer for every pair whose Agent replied in the last day and has replies after `reviewed_seq`; how many. */
  resume(): Promise<number>;
  close(): void;
  /** Resolves once nothing is being looked at, nothing waits and no job is under way (timers do not count). */
  idle(): Promise<void>;
}

/** How far back a restart looks for replies nobody reviewed. */
const RESUME_WINDOW = "24 hours";

const keyOf = (agentId: string, conversationId: string): string => `${agentId}|${conversationId}`;

export function createReviewer(deps: ReviewerDeps): Reviewer {
  const { db, config, log } = deps;
  const stop = new AbortController();
  const closing = deps.closing ? AbortSignal.any([deps.closing, stop.signal]) : stop.signal;
  const timers = new Map<string, { clear(): void }>();
  /** The newest seq the last attempt of each pair looked at (a failed call is not asked again for the same words). */
  const attempted = new Map<string, number>();
  let waiting: Job[] = [];
  const running = new Set<string>();
  /** Evaluations of a trigger under way (they read the database before deciding). */
  let looking = 0;
  const idlers: Array<() => void> = [];
  let closed = false;

  const settleIdle = (): void => {
    if (looking === 0 && running.size === 0 && waiting.length === 0) for (const done of idlers.splice(0)) done();
  };

  const pump = (): void => {
    if (closed) return;
    for (const job of [...waiting]) {
      if (running.size >= MAX_REVIEWS_AT_ONCE) return;
      if (running.has(job.agentId)) continue;
      waiting = waiting.filter((j) => j !== job);
      running.add(job.agentId);
      const key = keyOf(job.agentId, job.conversationId);
      void deps
        .run(job, { closing, attempted: (seq) => attempted.set(key, Math.max(seq, attempted.get(key) ?? 0)) })
        .catch((err: unknown) => log.error({ ...errInfo(err), agentId: job.agentId, conversationId: job.conversationId }, "a memory review failed; nothing was changed"))
        .finally(() => {
          running.delete(job.agentId);
          pump();
          settleIdle();
        })
        .catch(() => {});
    }
    settleIdle();
  };

  const enqueue = (job: Job): void => {
    if (closed) return;
    if (!waiting.some((j) => j.agentId === job.agentId && j.conversationId === job.conversationId)) waiting.push(job);
    pump();
  };

  const track = async (work: () => Promise<void>): Promise<void> => {
    looking++;
    try {
      await work();
    } catch (err) {
      log.error(errInfo(err), "a memory trigger could not be read; it is dropped");
    } finally {
      looking--;
      settleIdle();
    }
  };

  /** The owner's latest message after what was reviewed or attempted; null when there is none. */
  const ownerSince = async (agentId: string, conversationId: string, after: number): Promise<{ seq: number; text: string } | null> => {
    const { rows } = await db.query<{ seq: string; text: string | null }>(
      `select m.seq::text, m.body ->> 'text' as text from messages m
        where m.conversation_id = $1 and m.kind in ('text', 'file') and m.seq > $3
          and m.sender_id = (select owner_id from principals where id = $2)
        order by m.seq desc limit 1`,
      [conversationId, agentId, after],
    );
    return rows[0] ? { seq: Number(rows[0].seq), text: rows[0].text ?? "" } : null;
  };

  /** The seq below which nothing is asked again: reviewed, or attempted. */
  const floorOf = async (agentId: string, conversationId: string): Promise<number> =>
    Math.max(await reviewedSeq(db, agentId, conversationId), attempted.get(keyOf(agentId, conversationId)) ?? 0);

  /** A job to run now, unless the owner said nothing since the last attempt. */
  const enqueueIfNew = (job: Job): Promise<void> =>
    track(async () => {
      if (closed || (await ownerSince(job.agentId, job.conversationId, await floorOf(job.agentId, job.conversationId))) === null) return;
      enqueue(job);
    });

  const arm = (job: Job): void => {
    if (closed) return;
    const key = keyOf(job.agentId, job.conversationId);
    timers.get(key)?.clear();
    timers.set(
      key,
      deps.setTimer(() => {
        timers.delete(key);
        void enqueueIfNew(job);
      }, config.memory.quietMs),
    );
  };

  const disarm = (job: Job): void => {
    const key = keyOf(job.agentId, job.conversationId);
    timers.get(key)?.clear();
    timers.delete(key);
  };

  /** Decides what a reply means for the pair: review at once, or (re)arm its quiet timer. */
  async function considerReply(agentId: string, conversationId: string): Promise<void> {
    if (closed || (await reviewableAgent(db, agentId)) === null) return;
    const job: Job = { kind: "review", agentId, conversationId };
    const reviewed = await reviewedSeq(db, agentId, conversationId);
    const fresh = await ownerSince(agentId, conversationId, Math.max(reviewed, attempted.get(keyOf(agentId, conversationId)) ?? 0));
    const { rows } = await db.query<{ replies: number }>(
      "select count(*)::int as replies from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' and seq > $3",
      [conversationId, agentId, reviewed],
    );
    if (fresh !== null && ((rows[0]?.replies ?? 0) >= config.memory.maxReplies || EXPLICIT.test(fresh.text))) {
      disarm(job);
      enqueue(job);
    } else {
      arm(job);
    }
  }

  return {
    noted(agentId, conversationId) {
      if (closed) return;
      void track(() => considerReply(agentId, conversationId));
    },
    topicReset(agentId, conversationId) {
      if (closed) return;
      const job: Job = { kind: "review", agentId, conversationId };
      disarm(job);
      void enqueueIfNew(job);
    },
    flagged() {
      // Filled in by the group listeners' batch: nothing is reviewed for a flag yet.
    },
    async resume() {
      let armed = 0;
      await track(async () => {
        const { rows } = await db.query<{ agent_id: string; conversation_id: string }>(
          `select distinct m.sender_id as agent_id, m.conversation_id
             from messages m
             join agents a on a.principal_id = m.sender_id and a.memory and not a.paused and a.deleted_at is null
             left join memory_review_state s on s.agent_id = m.sender_id and s.conversation_id = m.conversation_id
            where m.kind = 'text' and m.created_at > now() - interval '${RESUME_WINDOW}' and (m.body -> 'fixed') is distinct from 'true'::jsonb
              and m.seq > coalesce(s.reviewed_seq, 0)`,
        );
        for (const r of rows) {
          arm({ kind: "review", agentId: r.agent_id, conversationId: r.conversation_id });
          armed++;
        }
      });
      return armed;
    },
    close() {
      closed = true;
      for (const timer of timers.values()) timer.clear();
      timers.clear();
      waiting = [];
      stop.abort();
      settleIdle();
    },
    idle() {
      return looking === 0 && running.size === 0 && waiting.length === 0 ? Promise.resolve() : new Promise((done) => idlers.push(done));
    },
  };
}
