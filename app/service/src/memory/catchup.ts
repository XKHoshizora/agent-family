import { siteDay } from "../accounts/store.ts";
import { requestFor } from "../agents/proactive/candidates.ts";
import { askJudgement, flagged, mayListen } from "../agents/proactive/decide.ts";
import { listenersFor, writeFlags, type Listener } from "../agents/proactive/listeners.ts";
import type { Queryable } from "../db.ts";
import { noCallCanStart } from "./call.ts";
import { reviewableAgent, type PipelineDeps } from "./pipeline.ts";
import { count } from "./stats.ts";

/**
 * 也回顾一下 in a group (`catchUp: true`, the product owner's decision of 2026-11-21: "as if memory had never been off"). Switching an
 * Agent's memory on with catchUp queues, in the switch's transaction, one catch-up per group it is in (`memory_catchups`, pipeline.ts
 * `memorySwitched`): the lines of the group after its heard position — where switching off left it, never before its join — up to the
 * group's latest at the switch. The job (`runCatchUp`, the reviewer's `catchup` kind; queued after the switch's commit, and again by
 * `resume` after a restart) asks the group's own judgement (agents/proactive/candidates.ts `requestFor`, decide.ts `askJudgement`) the
 * listener questions of this one Agent alone, over those lines, oldest first, a window (`PROACTIVE.transcriptMessages`) at a time:
 * no pick, no other owner's question, the group's `judged_seq` and every other Agent's state untouched, and no line shown at or before
 * the start of the range. What it flags is written as any flag (listeners.ts `writeFlags`) and acted on by the reviewer as any (the
 * owner's own remarks reviewed, the hearsay call: hearsay.ts, which reads nothing at or below the Agent's heard position).
 *
 * Bounds: the most recent `MEMORY.catchUpLines` lines of the range and none older than `MEMORY.catchUpDays` days; older lines are not
 * caught up. It stops quietly — the rest of the range is not caught up — when the owner's memory allowance is used up, the judgement
 * cannot be asked (the day's limit, listening's share of it) or does not answer. A catch-up whose row is gone or was replaced (memory
 * switched again since it was queued) does nothing more: every step it takes is recorded together with its flags, under the condition
 * that the row is still the one it read (`token`), so a job run twice, or after a restart, never judges or flags a line twice.
 *
 * The range is the catch-up's alone: until the Agent's memory is switched again, the group's normal judgements flag nothing for this
 * Agent at or below its end (listeners.ts `listenersFor`, `writeFlags`), so a line is never flagged for it twice, by the catch-up and by
 * a judgement that finds the same line still new.
 */

export interface CatchUpJob {
  kind: "catchup";
  agentId: string;
  /** The group. */
  conversationId: string;
}

export interface CatchUpContext {
  closing: AbortSignal;
  /** After the flags' rows are written: the reviewer acts on them as on any (its `flagged`). */
  flagged(agentId: string, conversationId: string, kind: "hearsay" | "own"): void;
}

/** A pair's catch-up as stored: lines after `from` up to `to`, the next one to judge `next` (done once past `to`), `token` the row's instance. */
interface Row {
  from: number;
  to: number;
  next: number;
  token: string;
}

async function rowOf(q: Queryable, job: CatchUpJob): Promise<Row | null> {
  const { rows } = await q.query<{ from_seq: string; to_seq: string; next_seq: string; token: string }>(
    "select from_seq::text, to_seq::text, next_seq::text, token from memory_catchups where agent_id = $1 and conversation_id = $2",
    [job.agentId, job.conversationId],
  );
  const r = rows[0];
  return r ? { from: Number(r.from_seq), to: Number(r.to_seq), next: Number(r.next_seq), token: r.token } : null;
}

/** Moves the catch-up on to `next`, only while it is the row read and still at `was`: false when it was replaced, ended or moved. */
async function advance(q: Queryable, job: CatchUpJob, row: Row, was: number, next: number): Promise<boolean> {
  const { rowCount } = await q.query("update memory_catchups set next_seq = $5 where agent_id = $1 and conversation_id = $2 and token = $3 and next_seq = $4", [
    job.agentId,
    job.conversationId,
    row.token,
    was,
    next,
  ]);
  return rowCount === 1;
}

/** The lines a catch-up may judge: what a judgement is shown (text and files). */
const LINES = "conversation_id = $1 and kind in ('text', 'file')";

/**
 * Where the catch-up starts, its bounds applied: after the newest line older than `days` days, and after all but the most recent
 * `lines` lines of the range, whichever is later (and never before `next`).
 */
async function boundedNext(q: Queryable, conversationId: string, row: Row, lines: number, days: number): Promise<number> {
  const { rows } = await q.query<{ floor: string }>(
    `select greatest($2::bigint,
              coalesce((select seq from messages where ${LINES} and seq > $2 and seq <= $3 order by seq desc offset $4 limit 1), $2),
              coalesce((select max(seq) from messages where ${LINES} and seq > $2 and seq <= $3 and created_at < now() - make_interval(days => $5)), $2))::text as floor`,
    [conversationId, row.next - 1, row.to, lines, days],
  );
  return Number(rows[0]!.floor) + 1;
}

/** One catch-up (see above). Never throws for a step that only cannot go on: it stops. */
export async function runCatchUp(deps: PipelineDeps, job: CatchUpJob, ctx: CatchUpContext): Promise<void> {
  const { db, config } = deps;
  if (deps.judge === null || config.judge === null) return;
  const agent = await reviewableAgent(db, job.agentId);
  if (agent === null) return;
  const row = await rowOf(db, job);
  if (row === null || row.next > row.to) return;
  // Stopping: the rest of the range is not caught up (the row stays, done, so the range stays the catch-up's).
  const stop = async (at: number): Promise<void> => void (await advance(db, job, row, at, row.to + 1));
  let next = await boundedNext(db, job.conversationId, row, config.memory.catchUpLines, config.memory.catchUpDays);
  if (next !== row.next && !(await advance(db, job, row, row.next, next))) return;
  count(db, "catchup_group_jobs");
  const P = config.proactive;
  for (;;) {
    if (ctx.closing.aborted) return;
    const { rows } = await db.query<{ seq: string }>(`select seq::text from messages where ${LINES} and seq >= $2 and seq <= $3 order by seq limit $4`, [
      job.conversationId,
      next,
      row.to,
      P.transcriptMessages,
    ]);
    if (rows.length === 0) return stop(next);
    const end = Number(rows.at(-1)!.seq);
    // This owner's listener there, narrowed to this Agent: its questions alone, about lines after the range's start only.
    const mine = (await listenersFor(db, job.conversationId, end + 1, { ownerId: agent.ownerId }))[0];
    if (mine === undefined || !mine.agentIds.includes(agent.id)) return stop(next);
    const listener: Listener = { ...mine, key: "h1", agentIds: [agent.id], heardFrom: { [agent.id]: row.from }, joinedSeq: row.from, reviewerId: mine.reviewerId === agent.id ? agent.id : null };
    const request = await requestFor(db, job.conversationId, end, [], P, [listener], { after: row.from, newAfter: next - 1 });
    if (request === null) {
      if (!(await advance(db, job, row, next, end + 1))) return;
      next = end + 1;
      continue;
    }
    // The owner's memory allowance, and the judgement's day: when either is used up, it stops here.
    const day = siteDay(new Date(deps.now()), config.siteTimezone);
    if ((await noCallCanStart(db, config, agent.ownerId, new Date(deps.now()))) || !(await mayListen(db, day, config, deps.log))) return stop(next);
    const answers = await askJudgement({ db, judge: deps.judge, config, log: deps.log }, request, job.conversationId, day);
    if (answers === null) return stop(next);
    const raised = flagged(request.flaggable, answers, config.memory, job.conversationId);
    // The step and its flags together, only while the catch-up is still this one and here.
    const written = await db.tx(async (t) => ((await advance(t, job, row, next, end + 1)) ? writeFlags(t, raised, { catchUp: true }) : null));
    if (written === null) return;
    count(db, "catchup_lines_judged", rows.length);
    count(db, "catchup_flags", written.length);
    for (const kind of new Set(written.map((f) => f.kind))) ctx.flagged(agent.id, job.conversationId, kind);
    next = end + 1;
  }
}
