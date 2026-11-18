import type { FastifyBaseLogger } from "fastify";
import { siteDay } from "../../accounts/store.ts";
import type { Config } from "../../config.ts";
import { lockConversation } from "../../conversations/store.ts";
import { appendSystem } from "../../conversations/system.ts";
import type { Db, Queryable, Tx } from "../../db.ts";
import { AppError } from "../../errors.ts";
import type { Answer, Judge } from "../../judge/client.ts";
import type { StoredMessage } from "../../messages/model.ts";
import { blockedEitherWay } from "../../social/relations.ts";
import { noneTriggered, overLaneLimit, proactiveSpentToday, queueRun, siteToday, type RunLimits, type Triggered } from "../runs.ts";
import { lockAgent, type AgentRow } from "../store.ts";
import { judgeable, NOBODY, optionsFor, PICK, quietKey, requestFor, type Option } from "./candidates.ts";
import { afterProactive, afterQuiet, NO_STATE, thresholdNow, type GroupState } from "./threshold.ts";

/**
 * Whether one Agent replies unasked to a person's message in a group (batch 2D, design rules 3–15), in three phases:
 * 1. read, without locks: the message is still one to judge, the Agents that may answer it, the site's judgements today
 *    under its daily limit (`judge_usage`), the transcript and questions (candidates.ts);
 * 2. ask the judgement model once, outside any transaction (bounded by its time limit), then count the call and stamp the
 *    options as judged, each in a statement of its own;
 * 3. unless nothing can come of the answers (the winner under the lowest threshold there is, no quiet answer raising
 *    anyone: nothing is locked), in one transaction holding the group's row (as a send does): if anything was written in
 *    the group since — a message of anyone's, a halt — nothing is done; else each Agent this touches is locked
 *    (`lockAgent`, id order) and read again, then its `agent_group_state` row (id order: `lockStates`), the quiet answers
 *    are applied (`afterQuiet`; a sure one tells the group once an hour, `agent_quieted`), and the winner — the Agent
 *    option with the highest pick probability, ties to the lowest id — replies when the message has led to no proactive
 *    reply yet, its probability reaches its threshold (`thresholdNow`), this message did not ask it to be quiet (the hush
 *    rule) and it can speak now; when it cannot, nobody does (there is no second choice). Its reply is queued in lane
 *    `proactive`, called for by nobody (a call folded into it while it is queued makes it that call's; a halt ends it
 *    while it is not, runs.ts), and its surcharge rises at once (`afterProactive`).
 * Every failure of the judgement — none configured, over the daily limit, an error, no answer in time, an answer missing
 * any option asked — means nobody replies. What it decides is returned, to act on after commit as a send does
 * (`actOnTriggered`, the notices published). Nothing of it reaches a wire shape; the log carries ids and reasons only.
 */

export interface DecideDeps {
  db: Db;
  judge: Judge | null;
  config: RunLimits & Pick<Config, "judge" | "proactive">;
  log: Pick<FastifyBaseLogger, "info" | "debug">;
}

/** Why the winner did not reply (`proactive_skipped`). */
type Skipped = "already_decided" | "hushed" | "under_threshold" | "active_run" | "fuse" | "budget" | "owner_minute";

/** An Agent's state in the group as stored: the threshold's, and the message its surcharge was stamped after. */
interface Stored {
  state: GroupState;
  surchargeSeq: number | null;
}

/** The site day the daily limit was last logged on: once per process and day. */
let limitLoggedOn: string | null = null;

export async function decideProactive(deps: DecideDeps, conversationId: string, seq: number): Promise<Triggered> {
  const { db, judge, config, log } = deps;
  if (judge === null || config.judge === null) return noneTriggered();

  const message = await judgeable(db, conversationId, seq);
  if (message === null) return noneTriggered();
  const options = await optionsFor(db, conversationId, message.senderId);
  if (options.length === 0) return noneTriggered();
  const day = siteDay(new Date(), config.siteTimezone);
  if (await atDailyLimit(db, day, config.judge.dailyLimit, log)) return noneTriggered();
  const { state, questions } = await requestFor(db, conversationId, seq, options, config.proactive);

  let answers: Map<string, Answer> | null = null;
  try {
    // Each channel is tried for at most `timeoutMs`; nothing waits longer than all of them together.
    answers = await judge.ask(state, questions, AbortSignal.timeout(config.judge.timeoutMs * Math.max(1, config.judge.channels.length)));
  } catch {
    log.info({ metric: "judge_failed", conversationId }, "the judgement model gave no answer: no Agent replies unasked");
  }
  await counted(db, day, conversationId, options);
  if (answers === null) return noneTriggered();

  const P = config.proactive;
  const { winner, quiet, partial } = answered(options, answers, new Set(questions.map((q) => q.key)));
  if (partial) log.info({ metric: "judge_partial", conversationId }, "the judgement model left an option of the pick unanswered: no Agent replies unasked");
  // No threshold is below the lowest base (or the cap): a winner under that cannot reply, whatever its state, and when
  // no quiet answer raises anyone either, the group's row and the Agents' are not locked at all (the usual case).
  const contender = winner !== null && winner.p >= Math.min(P.cap, P.base.less, P.base.normal, P.base.more) ? winner : null;
  if (winner !== null && contender === null) logSkipped(log, "under_threshold", winner.option.agentId, conversationId);
  if (contender === null && !options.some((o) => (quiet.get(o.agentId) ?? 0) >= P.quietSmall.at)) return noneTriggered();
  return db.tx((t) => settle(t, { conversationId, seq, options, config, log, winner: contender, quiet }));
}

/**
 * One line for a winner that does not reply: at debug when its threshold stopped it (the usual case) or the message was
 * decided already, else at info.
 */
function logSkipped(log: DecideDeps["log"], reason: Skipped, agentId: string, conversationId: string): void {
  const line = { metric: "proactive_skipped", reason, agentId, conversationId };
  if (reason === "under_threshold" || reason === "already_decided") log.debug(line, "the winner does not reply: the usual case");
  else log.info(line, "the Agent the judgement picked cannot speak now: no Agent replies unasked");
}

/** Whether the site's judgements of site day `day` have reached `limit`; logged once a day when they have. */
async function atDailyLimit(q: Queryable, day: string, limit: number, log: DecideDeps["log"]): Promise<boolean> {
  const { rows } = await q.query<{ calls: number }>("select calls from judge_usage where day = $1::date", [day]);
  if ((rows[0]?.calls ?? 0) < limit) return false;
  if (limitLoggedOn !== day) {
    limitLoggedOn = day;
    log.info({ metric: "judge_daily_limit" }, "the site's judgements of the day are used up: no Agent replies unasked until the next site day");
  }
  return true;
}

/**
 * After a call, whatever came of it: one more judgement today, and each option stamped as judged now. The rows not there
 * yet are inserted first, on their own: a new row waits for the group's row (its foreign key) while holding no other.
 * Then every option's row is locked in id order — the one order `agent_group_state` rows are ever locked in (`lockStates`)
 * — and stamped.
 */
async function counted(db: Db, day: string, conversationId: string, options: readonly Option[]): Promise<void> {
  const ids = options.map((o) => o.agentId);
  await db.query("insert into judge_usage (day, calls) values ($1::date, 1) on conflict (day) do update set calls = judge_usage.calls + 1", [day]);
  await db.query(
    "insert into agent_group_state (agent_id, conversation_id, judged_at) select unnest($1::uuid[]), $2, now() on conflict (agent_id, conversation_id) do nothing",
    [ids, conversationId],
  );
  await db.query(
    `with locked as (select agent_id from agent_group_state where conversation_id = $2 and agent_id = any($1::uuid[]) order by agent_id for update)
     update agent_group_state s set judged_at = now() from locked where s.conversation_id = $2 and s.agent_id = locked.agent_id`,
    [ids, conversationId],
  );
}

/** What the judgement said that counts: the winner of the pick, if any, and each quiet answer by Agent. */
interface Answered {
  winner: { option: Option; p: number } | null;
  quiet: Map<string, number>;
}

/**
 * The answers to what was `asked`, nothing else. The winner: the Agent option with the highest pick probability (ties:
 * the lowest id — options are in id order); none unless every option asked, `nobody` too, has a probability — a maximum
 * over part of them is no answer (`partial`: the pick missing, or part of it).
 */
function answered(options: readonly Option[], answers: ReadonlyMap<string, Answer>, asked: ReadonlySet<string>): Answered & { partial: boolean } {
  const quiet = new Map<string, number>();
  for (const o of options) {
    const a = asked.has(quietKey(o)) ? answers.get(quietKey(o)) : undefined;
    if (a?.type === "noul") quiet.set(o.agentId, a.p);
  }
  const pick = answers.get(PICK);
  if (pick?.type !== "choice") return { winner: null, quiet, partial: true };
  const p = pick.probabilities;
  if (!p.has(NOBODY) || options.some((o) => !p.has(o.key))) return { winner: null, quiet, partial: true };
  let winner: Answered["winner"] = null;
  for (const option of options) {
    const probability = p.get(option.key)!;
    if (winner === null || probability > winner.p) winner = { option, p: probability };
  }
  return { winner, quiet, partial: false };
}

interface Judged extends Answered {
  conversationId: string;
  seq: number;
  options: readonly Option[];
  config: DecideDeps["config"];
  log: DecideDeps["log"];
}

/** Phase 3 (see the top): under the group's row, apply what the judgement said, if the group is as it was. */
async function settle(t: Tx, j: Judged): Promise<Triggered> {
  const { conversationId, seq, config, log } = j;
  const P = config.proactive;
  if (!(await lockConversation(t, conversationId))) return noneTriggered();
  const still = await judgeable(t, conversationId, seq);
  if (still === null) return noneTriggered();
  const now = new Date();

  // Touched: the Agents a quiet answer raises (`afterQuiet` does from `quietSmall.at` on), and the winner.
  const raised = j.options.filter((o) => (j.quiet.get(o.agentId) ?? 0) >= P.quietSmall.at).map((o) => o.agentId);
  const touched = [...new Set([...raised, ...(j.winner ? [j.winner.option.agentId] : [])])].sort();
  const agents = await lockOptions(t, conversationId, touched, still.senderId);
  const states = await lockStates(t, conversationId, [...agents.keys()]);

  const notices: StoredMessage[] = [];
  for (const id of agents.keys()) {
    const q = j.quiet.get(id);
    const stored = states.get(id)!;
    const raise = q === undefined ? null : afterQuiet(stored.state, q, now, P);
    if (raise === null) continue;
    stored.state = raise.state;
    await save(t, id, conversationId, stored);
    if (raise.big && !(await quietedLastHour(t, conversationId, id))) {
      notices.push(await appendSystem(t, conversationId, { event: "agent_quieted", actorId: id, agentId: id }));
    }
  }
  const told: Triggered = { ...noneTriggered(), notices };

  const agent = j.winner ? agents.get(j.winner.option.agentId) : undefined;
  if (!j.winner || !agent) return told;
  const stored = states.get(agent.id)!;
  // Others' messages since its surcharge was stamped: what its threshold now, and its surcharge stamped again, decay by.
  stored.state = { ...stored.state, othersSince: await othersSinceSurcharge(t, conversationId, agent.id, stored, seq, P.surchargeHalfMessages) };
  const skipped = await whyNot(t, agent, conversationId, seq, j.winner.p, j.quiet.get(agent.id), stored.state, now, config);
  if (skipped !== null) {
    logSkipped(log, skipped, agent.id, conversationId);
    return told;
  }
  const run = await queueRun(t, agent, conversationId, seq, "human", { id: null, lane: "proactive" });
  await save(t, agent.id, conversationId, { state: afterProactive(stored.state, now, P), surchargeSeq: seq });
  return { ...told, runs: [run] };
}

/**
 * Each of `ids` (in id order) locked (`lockAgent`; the caller holds the group's row), kept while it is still an option:
 * a current member with proactive replies on, not paused or deleted, with a model, its owner and the sender with no
 * block between them. One no longer found at all (`lockAgent`'s 404, a query that failed nothing) is gone: no option.
 */
async function lockOptions(t: Tx, conversationId: string, ids: readonly string[], senderId: string): Promise<Map<string, AgentRow>> {
  if (ids.length === 0) return new Map();
  const locked: AgentRow[] = [];
  for (const id of ids) {
    try {
      locked.push(await lockAgent(t, id, conversationId));
    } catch (err) {
      if (!(err instanceof AppError && err.status === 404)) throw err;
    }
  }
  const { rows } = await t.query<{ id: string }>(
    `select m.principal_id as id from memberships m join principals p on p.id = m.principal_id
      where m.conversation_id = $1 and m.left_seq is null and m.principal_id = any($2::uuid[]) and not ${blockedEitherWay("p.owner_id", "$3::uuid")}`,
    [conversationId, ids, senderId],
  );
  const members = new Set(rows.map((r) => r.id));
  return new Map(locked.filter((a) => members.has(a.id) && a.proactive && !a.paused && !a.deleted && a.model !== null).map((a) => [a.id, a]));
}

/**
 * The state of each of `ids` (in id order) in the group, its row locked before anything is written: every row in id
 * order, as `counted` does (rows are written in other orders — the winner's last — so locking them only as each is
 * written could deadlock with a `counted` of another decision). `counted` inserted them; one missing (none stored:
 * `NO_STATE`) is inserted first, in the same order.
 */
async function lockStates(t: Tx, conversationId: string, ids: readonly string[]): Promise<Map<string, Stored>> {
  if (ids.length === 0) return new Map();
  await t.query("insert into agent_group_state (agent_id, conversation_id) select unnest($1::uuid[]), $2 on conflict (agent_id, conversation_id) do nothing", [
    ids,
    conversationId,
  ]);
  const { rows } = await t.query<{
    agent_id: string;
    surcharge: number;
    surcharge_at: Date | null;
    surcharge_seq: string | null;
    quiet: number;
    quiet_half_life_s: number | null;
    quiet_at: Date | null;
  }>(
    `select agent_id, surcharge, surcharge_at, surcharge_seq::text as surcharge_seq, quiet, quiet_half_life_s, quiet_at
       from agent_group_state where conversation_id = $1 and agent_id = any($2::uuid[])
      order by agent_id
        for update`,
    [conversationId, ids],
  );
  const found = new Map(
    rows.map((r): [string, Stored] => [
      r.agent_id,
      {
        state: { surcharge: r.surcharge, surchargeAt: r.surcharge_at, othersSince: 0, quiet: r.quiet, quietHalfLifeS: r.quiet_half_life_s, quietAt: r.quiet_at },
        surchargeSeq: r.surcharge_seq === null ? null : Number(r.surcharge_seq),
      },
    ]),
  );
  return new Map(ids.map((id) => [id, found.get(id) ?? { state: NO_STATE, surchargeSeq: null }]));
}

/** Writes the Agent's state in the group (all but `judged_at`, which `counted` alone writes). */
async function save(t: Tx, agentId: string, conversationId: string, s: Stored): Promise<void> {
  await t.query(
    `insert into agent_group_state (agent_id, conversation_id, surcharge, surcharge_at, surcharge_seq, quiet, quiet_half_life_s, quiet_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (agent_id, conversation_id) do update
       set surcharge = excluded.surcharge, surcharge_at = excluded.surcharge_at, surcharge_seq = excluded.surcharge_seq,
           quiet = excluded.quiet, quiet_half_life_s = excluded.quiet_half_life_s, quiet_at = excluded.quiet_at`,
    [agentId, conversationId, s.state.surcharge, s.state.surchargeAt, s.surchargeSeq, s.state.quiet, s.state.quietHalfLifeS, s.state.quietAt],
  );
}

/** Whether the group was told within the last hour that Agent `agentId` keeps quiet (`agent_quieted`). */
async function quietedLastHour(t: Tx, conversationId: string, agentId: string): Promise<boolean> {
  const { rowCount } = await t.query(
    `select 1 from messages
      where conversation_id = $1 and kind = 'system' and body ->> 'event' = 'agent_quieted' and body ->> 'agentId' = $2
        and created_at > now() - interval '1 hour'
      limit 1`,
    [conversationId, agentId],
  );
  return rowCount !== 0;
}

/**
 * Why the winner `agent` (pick probability `p`, quiet probability `quiet` for this message, its threshold's `state` with
 * the others' messages since its surcharge) does not reply, or null when it does: the message at `seq` already led to a
 * proactive reply here — of any Agent: a surcharge was stamped after it (`already_decided`; at most one reply per
 * message, however often it is decided; the stamp stays when a call takes the reply over); this message asked it to be
 * quiet, if only a little (`hushed`: the judgement tends to pick the very Agent a mild complaint is about); `p` is under
 * its threshold now (`under_threshold`); a reply of it is queued or running in the group (`active_run`: a proactive reply
 * is never folded into one); the fuse — a proactive reply of it in the group within `fuse.perSeconds`, or `fuse.perHour`
 * of them within the hour (`fuse`); its proactive budget is spent: what its proactive replies were charged today, settled
 * charges only, has reached it (`budget`); its owner has started the others' replies a minute (`owner_minute`, the
 * others' lane's own check, which locks the owner's `accounts` row: the lock order's last step).
 */
async function whyNot(
  t: Tx,
  agent: AgentRow,
  conversationId: string,
  seq: number,
  p: number,
  quiet: number | undefined,
  state: GroupState,
  now: Date,
  config: DecideDeps["config"],
): Promise<Skipped | null> {
  const P = config.proactive;
  // Every writer of `surcharge_seq` holds the group's row, as this does.
  const decided = await t.query("select 1 from agent_group_state where conversation_id = $1 and surcharge_seq >= $2 limit 1", [conversationId, seq]);
  if (decided.rowCount) return "already_decided";
  if (quiet !== undefined && quiet >= P.quietSmall.at) return "hushed";
  if (p < thresholdNow(agent.proactiveLevel, state, now, P)) return "under_threshold";
  const active = await t.query("select 1 from agent_runs where agent_id = $1 and conversation_id = $2 and status in ('queued', 'running') limit 1", [
    agent.id,
    conversationId,
  ]);
  if (active.rowCount) return "active_run";
  const fuse = await t.query<{ recent: number; hour: number }>(
    `select count(*) filter (where created_at > now() - make_interval(secs => $3))::int as recent, count(*)::int as hour
       from agent_runs
      where agent_id = $1 and conversation_id = $2 and purpose = 'reply' and lane = 'proactive' and created_at > now() - interval '1 hour'`,
    [agent.id, conversationId, P.fuse.perSeconds],
  );
  if (fuse.rows[0]!.recent > 0 || fuse.rows[0]!.hour >= P.fuse.perHour) return "fuse";
  if ((await proactiveSpentToday(t, agent.id, siteToday(config))) >= agent.proactiveBudgetMicro) return "budget";
  if (await overLaneLimit(t, agent.ownerId, "proactive", config)) return "owner_minute";
  return null;
}

/**
 * Messages that are not notices, by anyone but Agent `agentId`, after its surcharge was stamped, up to `seq`: what halves
 * its surcharge every `halfMessages`. Not counted past 20 halvings (a millionth is left); nothing to count without one.
 */
async function othersSinceSurcharge(t: Tx, conversationId: string, agentId: string, stored: Stored, seq: number, halfMessages: number): Promise<number> {
  if (stored.surchargeSeq === null || !(stored.state.surcharge > 0)) return 0;
  const { rows } = await t.query<{ n: number }>(
    `select count(*)::int as n from (
       select 1 from messages
        where conversation_id = $1 and seq > $2 and seq <= $3 and kind <> 'system' and sender_id <> $4
        limit $5) x`,
    [conversationId, stored.surchargeSeq, seq, agentId, halfMessages * 20],
  );
  return rows[0]!.n;
}
