import type { FastifyBaseLogger } from "fastify";
import type { BlobStore } from "../attachments/blob.ts";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import type { Db, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { admitRun } from "../metering/admit.ts";
import { settle } from "../metering/settle.ts";
import { markRead, type ReadEvents } from "../messages/read.ts";
import { resolveModel, type Resolved } from "../models/resolve.ts";
import { KeyUnreadableError } from "../providers/crypto.ts";
import type { Hub } from "../sync/hub.ts";
import { BlobStoreDown, buildContext, hasOwnerTurn, loadContext, type BuiltContext, type LoadedContext } from "./context.ts";
import { holdsNewest } from "./runtime/context.ts";
import { postAsAgent, RunNotRunning } from "./conversation.ts";
import type { AgentPort, Delta, Prepared, Reply, RunEnd, RunTicket, Usage } from "./runtime/port.ts";
import { systemPrompt } from "./runtime/prompt.ts";
import { queueRun, RUN_COLUMNS, toWireRun, type Announced, type Interruption, type RunRow } from "./runs.ts";
import { lockAgent, type AgentRow } from "./store.ts";

export interface AgentPortDeps {
  db: Db;
  config: Config;
  /** Where attachments are read from for what the model is shown (`buildContext`). */
  blobs: BlobStore;
  realtime: Pick<Hub, "pushRun" | "pushDelta" | "pushAgentChanged">;
  conversations: ConversationEvents;
  reads: ReadEvents;
  log: Pick<FastifyBaseLogger, "error" | "warn">;
}

const UNAVAILABLE: RunEnd = { status: "failed", error: "provider_unavailable" };
/**
 * The service's own trouble; here: a reply with nothing to answer and no reason why, or whose attachments could not be
 * read (the store is down, or reading took longer than the run may), which never reaches a model.
 */
const BUSY: RunEnd = { status: "failed", error: "busy" };
/** No tokens at all: what a run recovered at start-up is settled on. */
const NOTHING = { inputChars: 0, outputChars: 0 };
/** Everything the reply was to answer is before a new topic its owner started: nothing failed, nothing to retry. */
const STARTED_OVER: RunEnd = { status: "cancelled" };
/** The model's context cannot hold the owner's newest message (`holdsNewest`): no call is made. */
const TOO_SMALL: RunEnd = { status: "failed", error: "context_too_small" };

/** What `begin`, `finish` and recovery read of the run, under its row lock. */
interface RunState {
  status: string;
  covers_seq: string | null;
  pending_seq: string | null;
  interrupted: Interruption | null;
}
const RUN_STATE = "status, covers_seq::text, pending_seq::text, interrupted";

/**
 * The one rule for a follow-up (README "Agents and runs", Coalescing): a run that has ended is followed by a reply to
 * what its owner wrote meanwhile when something was noted on it (`pending_seq` beyond what it covered) and its Agent
 * can still answer (not paused, not deleted, has a model) — however the run itself ended. A pause or delete drops what
 * was noted (runs.ts `interruptRuns`) and nothing is noted while the Agent is paused, so what is noted on an
 * interrupted run came after the resume, and is answered.
 */
function followUpSeq(state: RunState, agent: AgentRow): number | null {
  const covers = Number(state.covers_seq ?? 0);
  const pending = Number(state.pending_seq ?? 0);
  return pending > covers && !agent.paused && !agent.deleted && agent.model !== null ? pending : null;
}

/**
 * A run's in-process flags, from its claim until it has finished. A delta waiting to be delivered keeps the flags it
 * was emitted under, so once `silenced` it stays dropped, however late the hub gets to it — also after `finish` has
 * forgotten the run.
 */
interface RunFlags {
  /** Its owner asked it to stop, or its Agent's pause or delete interrupted it. */
  stop: boolean;
  /** Its Agent's pause or delete interrupted it: nothing more of it is pushed. */
  silenced: boolean;
}

/**
 * How a run is recorded, from what is true under `lockAgent` rather than what the worker could tell (an owner's stop
 * and a pause look alike to it): a reply that was posted stands — `done`, or `stopped` by its owner — whatever happened
 * to the Agent after; a run its Agent's pause or delete interrupted, and that posted nothing, is `cancelled` with that
 * reason (also when the Agent was resumed meanwhile); a refused post is `cancelled` for the Agent's state.
 */
function recorded(end: RunEnd, s: { posted: boolean; interrupted: Interruption | null; agent: AgentRow }): RunEnd {
  if (s.posted) return end.status === "stopped" ? end : { status: "done" };
  if (s.interrupted) return { status: "cancelled", error: s.interrupted };
  if (end.status === "cancelled" && end.error === undefined) {
    return s.agent.deleted ? { status: "cancelled", error: "agent_deleted" } : s.agent.paused ? { status: "cancelled", error: "agent_paused" } : end;
  }
  return end;
}

/**
 * `AgentPort` over the database, the hub and the event registries: the one place the reply worker's work turns into
 * SQL. Besides the port it offers the routes what they need to reach a run in flight: `announce`, `requestStop`,
 * `interruptRuns` (called after their transactions commit, before they answer).
 */
export class DbAgentPort implements AgentPort {
  /**
   * The flags of the runs this process is working on, by id: made when a run is claimed (or first flagged), forgotten
   * once it has finished. They live in this process only, like the worker: a new start begins with none, and a run left
   * `running` by the previous one is recovered (`recoverRuns`) before anything could flag it.
   */
  private readonly flags = new Map<string, RunFlags>();
  private wakeWorker: () => void = () => {};

  constructor(private readonly deps: AgentPortDeps) {}

  private flagsOf(runId: string): RunFlags {
    let flags = this.flags.get(runId);
    if (!flags) {
      flags = { stop: false, silenced: false };
      this.flags.set(runId, flags);
    }
    return flags;
  }

  /** What to call when a run is queued: the worker's wake-up. */
  onQueued(fn: () => void): void {
    this.wakeWorker = fn;
  }

  /** After the transaction that changed it committed: the run goes to its owner's sockets; a queued one wakes the worker. */
  announce(a: Announced): void {
    this.deps.realtime.pushRun(a.ownerId, a.conversationId, a.run);
    if (a.run.status === "queued") this.wakeWorker();
  }

  /** The owner asked a running run to stop. */
  requestStop(runId: string): void {
    this.flagsOf(runId).stop = true;
  }

  /**
   * Runs the Agent's pause or delete has just marked `interrupted` (runs.ts `interruptRuns`): their calls are abandoned
   * and, from now on, none of their deltas reaches the owner — not even one already waiting in the hub's queue, also
   * when the hub delivers it after the run has finished.
   */
  interruptRuns(runIds: readonly string[]): void {
    for (const id of runIds) {
      const flags = this.flagsOf(id);
      flags.silenced = true;
      flags.stop = true;
    }
  }

  shouldStop(run: RunTicket): boolean {
    return this.flags.get(run.id)?.stop === true;
  }

  async claimNext(): Promise<RunTicket | null> {
    const { rows } = await this.deps.db.query<RunRow & { agent_id: string; owner_id: string; conversation_id: string }>(
      `with next as (
         select q.id from agent_runs q
          where q.status = 'queued' and q.purpose = 'reply'
            and (select count(*) from agent_runs x where x.owner_id = q.owner_id and x.status = 'running') < $1
          order by q.created_at, q.id
          limit 1
          for update of q skip locked
       )
       update agent_runs as r set status = 'running', started_at = now() from next where r.id = next.id
       returning ${RUN_COLUMNS}, r.agent_id, r.owner_id, r.conversation_id`,
      [this.deps.config.agentMaxConcurrentRuns],
    );
    const row = rows[0];
    if (!row) return null;
    const run: RunTicket = { id: row.id, agentId: row.agent_id, ownerId: row.owner_id, conversationId: row.conversation_id };
    this.flagsOf(run.id);
    this.announce({ ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(row) });
    return run;
  }

  /** Locks the Agent (its conversation row, then its `agents` row), then the run's row, and reads both. */
  private async lockRun(t: Tx, run: RunTicket): Promise<{ agent: AgentRow; state: RunState }> {
    const agent = await lockAgent(t, run.agentId);
    const state = await t.query<RunState>(`select ${RUN_STATE} from agent_runs where id = $1 for update`, [run.id]);
    if (state.rows[0]?.status !== "running") throw new Error(`begin: run ${run.id} is not running`);
    return { agent, state: state.rows[0] };
  }

  /**
   * Under `lockRun`: how the run ends instead of calling its model — interrupted by its Agent's pause or delete (even if
   * resumed since), the Agent paused or deleted, or a stop asked for — or null when it may go on.
   */
  private halted(run: RunTicket, agent: AgentRow, state: RunState): RunEnd | null {
    if (state.interrupted) return { status: "cancelled", error: state.interrupted };
    if (agent.deleted) return { status: "cancelled", error: "agent_deleted" };
    if (agent.paused) return { status: "cancelled", error: "agent_paused" };
    if (this.shouldStop(run)) return { status: "stopped" };
    return null;
  }

  /**
   * Three steps, so that no transaction is open while attachments are read:
   *
   * 1. A short transaction under `lockRun`: a run that is `halted` ends here, and so does one whose model does not
   *    resolve (`failed`, `provider_unavailable`). Otherwise the run takes on what came meanwhile (`covers_seq` =
   *    max(covers, pending)), and what the model may be shown is read (`loadContext`, SQL only). With no owner's message
   *    in it the run ends without a call: `cancelled` with no error when everything it was to answer is before a new
   *    topic (its owner started over), else `failed` `busy`; and so does one whose model's context cannot hold the
   *    owner's newest message, or 200 tokens of it (`failed`, `context_too_small`).
   * 2. No transaction: the attachments' bytes are read and the call's turns assembled (`buildContext`). A send to the
   *    conversation, a pause or a delete meanwhile does not wait for it. No further file is read once the run should
   *    stop (step 3 then ends it); a file that cannot be read is shown by its name; the store failing on two files
   *    before it has served one, or the step taking longer than `agentRunTimeoutMs`, ends the run `failed`, `busy`. When `closing`
   *    aborts (the service is closing) the read is abandoned and `begin` rejects with its reason before step 3: the run
   *    stays `running`, unadmitted, for `recoverRuns` at the next start.
   * 3. A short transaction under `lockRun` again: a run `halted` meanwhile ends as in step 1, with no call; when
   *    `closing` has aborted by the time the locks are held, the transaction rolls back and `begin` rejects with its
   *    reason, admitting nothing (as in step 2); otherwise
   *    the call is admitted on its input estimate (402 `no_quota` ends the run failed) and the Agent's read marker moves
   *    to what the run covers (announced after commit). The reasoning level is the Agent's when the model allows it,
   *    else `none`.
   */
  async begin(run: RunTicket, closing?: AbortSignal): Promise<Prepared | RunEnd> {
    const { db, config, blobs, log } = this.deps;
    const now = new Date();
    const first = await db.tx(async (t): Promise<{ end: RunEnd } | { resolved: Resolved; loaded: LoadedContext; covers: number }> => {
      const { agent, state } = await this.lockRun(t, run);
      const halted = this.halted(run, agent, state);
      if (halted) return { end: halted };

      let resolved;
      try {
        resolved = await resolveModel(t, config, agent);
      } catch (err) {
        if (!(err instanceof KeyUnreadableError)) throw err;
        log.error({ err, runId: run.id }, "agent run: the provider's key cannot be opened (PROVIDER_KEY_SECRET changed?)");
        return { end: UNAVAILABLE };
      }
      if (!resolved) return { end: UNAVAILABLE };

      const covers = Math.max(Number(state.covers_seq ?? 0), Number(state.pending_seq ?? 0));
      await t.query("update agent_runs set covers_seq = $2, pending_seq = null where id = $1", [run.id, covers]);
      const owner = await t.query<{ display_name: string }>("select display_name from principals where id = $1", [agent.ownerId]);
      const system = systemPrompt(
        agent,
        { displayName: owner.rows[0]!.display_name },
        now,
        agent.persona === "" ? "onboarding" : "normal",
        config.siteTimezone,
      );
      const loaded = await loadContext(
        t,
        { agentId: agent.id, ownerId: agent.ownerId, conversationId: run.conversationId, coversSeq: covers },
        resolved,
        system,
      );
      if (!hasOwnerTurn(loaded)) return { end: loaded.topicStart > 0 && covers <= loaded.topicStart ? STARTED_OVER : BUSY };
      if (!holdsNewest(loaded.entries, loaded.budget)) return { end: TOO_SMALL };
      return { resolved, loaded, covers };
    });
    if ("end" in first) return first.end;

    const deadline = AbortSignal.timeout(config.agentRunTimeoutMs);
    let context: BuiltContext;
    try {
      context = await buildContext(blobs, first.loaded, first.resolved, log, {
        signal: closing ? AbortSignal.any([closing, deadline]) : deadline,
        stop: () => this.shouldStop(run),
      });
    } catch (err) {
      if (closing?.aborted) throw closing.reason;
      if (!deadline.aborted && !(err instanceof BlobStoreDown)) throw err;
      log.error({ err, runId: run.id }, "agent run: its attachments could not be read");
      return BUSY;
    }
    if (closing?.aborted) throw closing.reason;

    const result = await db.tx(async (t): Promise<{ end: RunEnd } | { prepared: Prepared; read: number | null }> => {
      const { agent, state } = await this.lockRun(t, run);
      const halted = this.halted(run, agent, state);
      if (halted) return { end: halted };
      // The service may have started closing while this waited for the locks: then nothing is admitted (thrown, so the
      // transaction rolls back) and the run stays running, unadmitted, for the next start.
      if (closing?.aborted) throw closing.reason;
      const { resolved, loaded, covers } = first;
      try {
        await admitRun(t, config, run.id, run.ownerId, resolved, context.inputTokensEstimate, now);
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== "no_quota") throw err;
        const resetsAt = err.details.resetsAt;
        return { end: { status: "failed", error: "no_quota", ...(typeof resetsAt === "string" ? { resetsAt } : {}) } };
      }
      const marked = await markRead(t, agent.id, run.conversationId, covers);
      const reasoning = resolved.reasoningAllowed.includes(agent.reasoning) ? agent.reasoning : "none";
      return {
        prepared: { call: { ...resolved.call, system: loaded.system, messages: context.messages, reasoning }, inputChars: context.inputChars },
        read: marked && marked.readSeq > marked.previous ? marked.readSeq : null,
      };
    });
    if ("end" in result) return result.end;
    if (result.read !== null) this.deps.reads.publish({ conversationId: run.conversationId, principalId: run.agentId, seq: result.read }, log);
    return result.prepared;
  }

  emit(run: RunTicket, delta: Delta): void {
    // Checked now and again when the hub delivers it, against the flags it was emitted under: once the pause or delete
    // has answered, no delta goes out, however late it is delivered. A run that has finished emits nothing.
    const flags = this.flags.get(run.id);
    if (!flags || flags.silenced) return;
    this.deps.realtime.pushDelta(run.ownerId, run.conversationId, run.id, delta, () => !flags.silenced);
  }

  /**
   * `postAsAgent` in its own transaction, announced after commit; a reply that proposed a persona (and so superseded
   * the Agent's earlier open proposals) also tells the owner's sockets to look at the Agent's proposals again (`agent`).
   * "refused" also when the run is no longer `running` (`RunNotRunning`: another instance's recovery ended it while
   * this one answered); `finish` then finds it ended and leaves it as that recovery recorded it.
   */
  async post(run: RunTicket, out: Reply): Promise<"posted" | "refused" | "empty"> {
    try {
      const posted = await this.deps.db.tx((t) => postAsAgent(t, run.agentId, run.conversationId, run.id, out));
      if (!posted) return "empty";
      const { message, duplicate } = posted;
      if (!duplicate) this.deps.conversations.publish({ messages: [message], conversations: [] }, this.deps.log);
      if (!duplicate && typeof message.body.proposalId === "string") this.deps.realtime.pushAgentChanged(run.ownerId, run.agentId);
      return "posted";
    } catch (err) {
      if (err instanceof AppError && (err.code === "agent_paused" || err.code === "agent_deleted")) return "refused";
      if (err instanceof RunNotRunning) {
        this.deps.log.warn({ runId: run.id, status: err.status }, "agent run: ended elsewhere while it was answered (another instance's recovery); its reply is not posted");
        return "refused";
      }
      throw err;
    }
  }

  /**
   * One transaction under `lockAgent`: settles the call (it leaves `running` in the same transaction, so its hold
   * never stops counting before its cost lands) — at no charge when it failed on our side (`busy`: the reply could not
   * be stored) — records how the run ended (`recorded`), and queues the follow-up by `followUpSeq`. Announced after
   * commit; the run's flags are forgotten then (a delta still waiting keeps its own).
   */
  async finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: { inputChars: number; outputChars: number }): Promise<void> {
    const { db, config } = this.deps;
    const now = new Date();
    const result = await db.tx(async (t) => {
      const agent = await lockAgent(t, run.agentId);
      const state = await t.query<RunState>(`select ${RUN_STATE} from agent_runs where id = $1 for update`, [run.id]);
      if (state.rows[0]?.status !== "running") return null;
      const posted = await t.query("select 1 from messages where conversation_id = $1 and sender_id = $2 and client_txn = $3", [
        run.conversationId,
        run.agentId,
        run.id,
      ]);
      const final = recorded(end, { posted: posted.rowCount !== 0, interrupted: state.rows[0].interrupted, agent });
      const ours = final.status === "failed" && final.error === "busy";
      await settle(t, config, run.id, usage, fallback, final.status, now, { forgiveAll: ours });
      const error = final.status === "failed" || final.status === "cancelled" ? (final.error ?? null) : null;
      const resetsAt = final.status === "failed" && final.resetsAt !== undefined ? final.resetsAt : null;
      const updated = await t.query<RunRow>(
        `update agent_runs as r set status = $2, error = $3, resets_at = $4, finished_at = now() where r.id = $1 returning ${RUN_COLUMNS}`,
        [run.id, final.status, error, resetsAt],
      );
      const ended: Announced = { ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(updated.rows[0]!) };
      const next = followUpSeq(state.rows[0], agent);
      const followUp = next === null ? null : await queueRun(t, agent, next);
      return { ended, followUp, interrupted: state.rows[0].interrupted !== null };
    });
    // An interrupted run is silenced here too, whether or not the pause's own call (`interruptRuns`) came first.
    const flags = this.flags.get(run.id);
    if (flags && result?.interrupted) flags.silenced = true;
    this.flags.delete(run.id);
    if (!result) return;
    this.announce(result.ended);
    if (result.followUp) this.announce(result.followUp);
  }
}

export function createAgentPort(deps: AgentPortDeps): DbAgentPort {
  return new DbAgentPort(deps);
}

/**
 * Recovery at start-up, before the worker starts (README "Agents and runs"; spec 6.4, 6.5): every run the previous
 * process left `running` — its call, if it had one, died with it — is ended without a model call, each in a
 * transaction of its own under the locks `finish` takes (the Agent's conversation and `agents` rows, then the run's,
 * then the account's; a persona draft has no Agent: its run row, then the account). A draft has no message either, so
 * it always ends as the last case:
 * - its reply had been posted (the stop fell between post and finish): `done`, or `stopped` when the message says so;
 * - else, its Agent's pause or delete had interrupted it: `cancelled` with that reason;
 * - else `failed`, `provider_unavailable`, retryable.
 * In the same transaction its hold is released by a settlement that costs nothing (whatever the upstream reported died
 * with the process: no tokens, all forgiven) — unless it already has its usage record: it is never settled twice. A
 * posted or cancelled run is followed up by the one rule (`followUpSeq`: queued, for the worker about to start); a
 * failed one is not, so nothing is called again on its own (spec 6.5) and a retry answers everything. Queued runs are
 * left as they are. Nothing is pushed (no socket can be open yet): a client learns the state from `GET …/run`. A run
 * that cannot be recovered is logged and left for the next start. Returns how many were recovered.
 */
export async function recoverRuns(db: Db, config: Config, log: Pick<FastifyBaseLogger, "error">): Promise<number> {
  const { rows } = await db.query<{ id: string; agent_id: string | null }>(
    "select id, agent_id from agent_runs where status = 'running' order by started_at, id",
  );
  let recovered = 0;
  for (const run of rows) {
    try {
      if (await db.tx((t) => recoverRun(t, config, run.id, run.agent_id))) recovered++;
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not be recovered at start-up; it stays running until the next start");
    }
  }
  return recovered;
}

/** One run of `recoverRuns`; false when it was no longer running. */
async function recoverRun(t: Tx, config: Config, runId: string, agentId: string | null): Promise<boolean> {
  // A reply has its Agent; a persona draft has none.
  const agent = agentId === null ? null : await lockAgent(t, agentId);
  const state = (await t.query<RunState>(`select ${RUN_STATE} from agent_runs where id = $1 for update`, [runId])).rows[0];
  if (state?.status !== "running") return false;
  const posted =
    agent === null
      ? null
      : (
          await t.query<{ stopped: boolean | null }>(
            "select (body ->> 'stopped') = 'true' as stopped from messages where conversation_id = $1 and sender_id = $2 and client_txn = $3",
            [agent.conversationId, agent.id, runId],
          )
        ).rows[0];
  const end: RunEnd = posted
    ? { status: posted.stopped === true ? "stopped" : "done" }
    : state.interrupted
      ? { status: "cancelled", error: state.interrupted }
      : UNAVAILABLE;
  // A run settled already had its hold released with its record.
  const settled = (await t.query("select 1 from usage_records where run_id = $1", [runId])).rowCount !== 0;
  if (!settled) await settle(t, config, runId, null, NOTHING, end.status, new Date(), { forgiveAll: true });
  const error = end.status === "failed" || end.status === "cancelled" ? (end.error ?? null) : null;
  await t.query("update agent_runs set status = $2, error = $3, finished_at = now() where id = $1", [runId, end.status, error]);
  const next = agent !== null && end.status !== "failed" ? followUpSeq(state, agent) : null;
  if (agent !== null && next !== null) await queueRun(t, agent, next);
  return true;
}
