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
import { buildContext, hasOwnerTurn, loadContext, type LoadedContext } from "./context.ts";
import { holdsNewest } from "./runtime/context.ts";
import { postAsAgent } from "./conversation.ts";
import type { AgentPort, Delta, Prepared, Reply, RunEnd, RunTicket, Usage } from "./runtime/port.ts";
import { systemPrompt } from "./runtime/prompt.ts";
import { queueRun, RUN_COLUMNS, toWireRun, type Announced, type Interruption, type RunRow } from "./runs.ts";
import { lockAgent, type AgentRow } from "./store.ts";

export interface AgentPortDeps {
  db: Db;
  config: Config;
  /** Where attachments are read from for what the model is shown (`buildContext`). */
  blobs: BlobStore;
  realtime: Pick<Hub, "pushRun" | "pushDelta">;
  conversations: ConversationEvents;
  reads: ReadEvents;
  log: Pick<FastifyBaseLogger, "error">;
}

const UNAVAILABLE: RunEnd = { status: "failed", error: "provider_unavailable" };
/** The service's own trouble; here: a reply with nothing to answer and no reason why, which never reaches a model. */
const BUSY: RunEnd = { status: "failed", error: "busy" };
/** Everything the reply was to answer is before a new topic its owner started: nothing failed, nothing to retry. */
const STARTED_OVER: RunEnd = { status: "cancelled" };
/** The model's context cannot hold the owner's newest message (`holdsNewest`): no call is made. */
const TOO_SMALL: RunEnd = { status: "failed", error: "context_too_small" };

/**
 * Whether a run that ended so may be followed by a reply to what its owner wrote meanwhile (`pending_seq`): every
 * ending but a cancel by its Agent's pause or delete, which ends the reply for good (nothing written meanwhile is
 * answered). A run cancelled because its owner started over is followed: what came after the new topic is to answer.
 */
function followsUp(end: RunEnd): boolean {
  switch (end.status) {
    case "done":
    case "stopped":
    case "failed":
      return true;
    case "cancelled":
      return end.error === undefined;
  }
}

/** What `begin` and `finish` read of the run, under its row lock. */
interface RunState {
  status: string;
  covers_seq: string | null;
  pending_seq: string | null;
  interrupted: Interruption | null;
}
const RUN_STATE = "status, covers_seq::text, pending_seq::text, interrupted";

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
  /** Runs that should stop: their owner asked, or their Agent was paused or deleted. Kept until they finish. */
  private readonly stopping = new Set<string>();
  /** Runs their Agent's pause or delete interrupted: nothing more of them is pushed. Kept until they finish. */
  private readonly silenced = new Set<string>();
  private wakeWorker: () => void = () => {};

  constructor(private readonly deps: AgentPortDeps) {}

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
    this.stopping.add(runId);
  }

  /**
   * Runs the Agent's pause or delete has just marked `interrupted` (runs.ts `interruptRuns`): their calls are abandoned
   * and, from now on, none of their deltas reaches the owner — not even one already waiting in the hub's queue.
   */
  interruptRuns(runIds: readonly string[]): void {
    for (const id of runIds) {
      this.silenced.add(id);
      this.stopping.add(id);
    }
  }

  shouldStop(run: RunTicket): boolean {
    return this.stopping.has(run.id);
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
   *    conversation, a pause or a delete meanwhile does not wait for it.
   * 3. A short transaction under `lockRun` again: a run `halted` meanwhile ends as in step 1, with no call; otherwise
   *    the call is admitted on its input estimate (402 `no_quota` ends the run failed) and the Agent's read marker moves
   *    to what the run covers (announced after commit). The reasoning level is the Agent's when the model allows it,
   *    else `none`.
   */
  async begin(run: RunTicket): Promise<Prepared | RunEnd> {
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

    const context = await buildContext(blobs, first.loaded, first.resolved, log);

    const result = await db.tx(async (t): Promise<{ end: RunEnd } | { prepared: Prepared; read: number | null }> => {
      const { agent, state } = await this.lockRun(t, run);
      const halted = this.halted(run, agent, state);
      if (halted) return { end: halted };
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
    // Checked now and again when the hub delivers it: once the pause or delete has answered, no delta goes out.
    const wanted = () => !this.silenced.has(run.id);
    if (wanted()) this.deps.realtime.pushDelta(run.ownerId, run.conversationId, run.id, delta, wanted);
  }

  async post(run: RunTicket, out: Reply): Promise<"posted" | "refused"> {
    try {
      const { message, duplicate } = await this.deps.db.tx((t) => postAsAgent(t, run.agentId, run.conversationId, run.id, out));
      if (!duplicate) this.deps.conversations.publish({ messages: [message], conversations: [] }, this.deps.log);
      return "posted";
    } catch (err) {
      if (err instanceof AppError && (err.code === "agent_paused" || err.code === "agent_deleted")) return "refused";
      throw err;
    }
  }

  /**
   * One transaction under `lockAgent`: settles the call (it leaves `running` in the same transaction, so its hold
   * never stops counting before its cost lands) — at no charge when it failed on our side (`busy`: the reply could not
   * be stored) — records how the run ended (`recorded`), and queues the follow-up when the owner wrote meanwhile
   * (`pending_seq` beyond `covers_seq`), the run was not cancelled and the Agent can still answer. Announced after commit.
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
      const covers = Number(state.rows[0].covers_seq ?? 0);
      const pending = Number(state.rows[0].pending_seq ?? 0);
      const answers = pending > covers && followsUp(final) && !agent.paused && !agent.deleted && agent.model !== null;
      const followUp = answers ? await queueRun(t, agent, pending) : null;
      return { ended, followUp };
    });
    this.stopping.delete(run.id);
    this.silenced.delete(run.id);
    if (!result) return;
    this.announce(result.ended);
    if (result.followUp) this.announce(result.followUp);
  }
}

export function createAgentPort(deps: AgentPortDeps): DbAgentPort {
  return new DbAgentPort(deps);
}
