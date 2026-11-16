import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { VISIBLE_JOIN } from "../conversations/store.ts";
import type { Db, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { admitRun } from "../metering/admit.ts";
import { estimateTokens } from "../metering/prices.ts";
import { settle } from "../metering/settle.ts";
import type { MessageBody } from "../messages/model.ts";
import { markRead, type ReadEvents } from "../messages/read.ts";
import type { ModelCall } from "../models/gateway.ts";
import { resolveModel } from "../models/resolve.ts";
import { KeyUnreadableError } from "../providers/crypto.ts";
import type { Hub } from "../sync/hub.ts";
import { postAsAgent } from "./conversation.ts";
import type { AgentPort, Delta, Prepared, Reply, RunEnd, RunTicket, Usage } from "./runtime/port.ts";
import { systemPrompt } from "./runtime/prompt.ts";
import { queueRun, RUN_COLUMNS, toWireRun, type Announced, type RunRow } from "./runs.ts";
import { lockAgent, type AgentRow } from "./store.ts";

export interface AgentPortDeps {
  db: Db;
  config: Config;
  realtime: Pick<Hub, "pushRun" | "pushDelta">;
  conversations: ConversationEvents;
  reads: ReadEvents;
  log: Pick<FastifyBaseLogger, "error">;
}

const UNAVAILABLE: RunEnd = { status: "failed", error: "provider_unavailable" };

/**
 * How an interrupted run is recorded: the worker cannot tell its owner's stop from a pause or a delete (both make
 * `shouldStop` true, and a refused post looks the same), so the Agent's state decides, read under `lockAgent`.
 */
function recorded(end: RunEnd, agent: AgentRow): RunEnd {
  if (end.status === "stopped" || (end.status === "cancelled" && end.error === undefined)) {
    if (agent.deleted) return { status: "cancelled", error: "agent_deleted" };
    if (agent.paused) return { status: "cancelled", error: "agent_paused" };
  }
  return end;
}

/**
 * `AgentPort` over the database, the hub and the event registries: the one place the reply worker's work turns into
 * SQL. Besides the port it offers the routes what they need to reach a run in flight: `announce`, `requestStop`,
 * `interruptAgent` (called after their transactions commit).
 */
export class DbAgentPort implements AgentPort {
  /** Runs that should stop: their owner asked, or their Agent was paused or deleted. Kept until they finish. */
  private readonly stopping = new Set<string>();
  /** Runs claimed in this process and not finished yet. */
  private readonly active = new Map<string, RunTicket>();
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

  /** The Agent was paused or deleted: whatever of it runs here stops (and is then recorded `cancelled`). */
  interruptAgent(agentId: string): void {
    for (const run of this.active.values()) if (run.agentId === agentId) this.stopping.add(run.id);
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
    this.active.set(run.id, run);
    this.announce({ ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(row) });
    return run;
  }

  /**
   * In one transaction under `lockAgent`: a paused or deleted Agent, a stop already asked for, or a model that does not
   * resolve end the run here. Otherwise the run takes on what came meanwhile (`covers_seq` = max(covers, pending)), the
   * model is shown every message the Agent can see up to now (Task 8 replaces this plain context), the call is admitted
   * (402 `no_quota` ends the run failed), and the Agent's read marker moves to what it covers (announced after commit).
   */
  async begin(run: RunTicket): Promise<Prepared | RunEnd> {
    const { db, config, log } = this.deps;
    const now = new Date();
    const result = await db.tx(async (t): Promise<{ end: RunEnd } | { prepared: Prepared; read: number | null }> => {
      const agent = await lockAgent(t, run.agentId);
      const state = await t.query<{ status: string; covers_seq: string | null; pending_seq: string | null }>(
        "select status, covers_seq::text, pending_seq::text from agent_runs where id = $1 for update",
        [run.id],
      );
      if (state.rows[0]?.status !== "running") throw new Error(`begin: run ${run.id} is not running`);
      if (agent.deleted) return { end: { status: "cancelled", error: "agent_deleted" } };
      if (agent.paused) return { end: { status: "cancelled", error: "agent_paused" } };
      if (this.shouldStop(run)) return { end: { status: "stopped" } };

      let resolved;
      try {
        resolved = await resolveModel(t, config, agent);
      } catch (err) {
        if (!(err instanceof KeyUnreadableError)) throw err;
        log.error({ err, runId: run.id }, "agent run: the provider's key cannot be opened (PROVIDER_KEY_SECRET changed?)");
        return { end: UNAVAILABLE };
      }
      if (!resolved) return { end: UNAVAILABLE };

      const covers = Math.max(Number(state.rows[0].covers_seq ?? 0), Number(state.rows[0].pending_seq ?? 0));
      await t.query("update agent_runs set covers_seq = $2, pending_seq = null where id = $1", [run.id, covers]);
      const turns = await this.turns(t, agent.id, run.conversationId);
      const owner = await t.query<{ display_name: string }>("select display_name from principals where id = $1", [agent.ownerId]);
      const system = systemPrompt(
        agent,
        { displayName: owner.rows[0]!.display_name },
        now,
        agent.persona === "" ? "onboarding" : "normal",
        config.siteTimezone,
      );
      const inputChars = estimateTokens(system) + turns.reduce((n, turn) => n + turn.parts.reduce((m, p) => m + (p.type === "text" ? estimateTokens(p.text) : 0), 0), 0);
      try {
        await admitRun(t, config, run.id, run.ownerId, resolved, inputChars, now);
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== "no_quota") throw err;
        const resetsAt = err.details.resetsAt;
        return { end: { status: "failed", error: "no_quota", ...(typeof resetsAt === "string" ? { resetsAt } : {}) } };
      }
      const marked = await markRead(t, agent.id, run.conversationId, covers);
      const reasoning = resolved.reasoningAllowed.includes(agent.reasoning) ? agent.reasoning : "none";
      return {
        prepared: { call: { ...resolved.call, system, messages: turns, reasoning }, inputChars },
        read: marked && marked.readSeq > marked.previous ? marked.readSeq : null,
      };
    });
    if ("end" in result) return result.end;
    if (result.read !== null) this.deps.reads.publish({ conversationId: run.conversationId, principalId: run.agentId, seq: result.read }, log);
    return result.prepared;
  }

  /**
   * What the model is shown in this task: every message the Agent can see, in order, as text — the owner's as `user`,
   * the Agent's as `assistant`. System notices, the fixed greeting and messages without text are left out.
   */
  private async turns(t: Tx, agentId: string, conversationId: string): Promise<ModelCall["messages"]> {
    const { rows } = await t.query<{ sender_id: string; kind: string; body: MessageBody }>(
      `select m.sender_id, m.kind, m.body from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 order by m.seq`,
      [agentId, conversationId],
    );
    return rows.flatMap((r) => {
      const text = typeof r.body.text === "string" ? r.body.text : "";
      if (r.kind === "system" || r.body.fixed === true || text === "") return [];
      return [{ role: r.sender_id === agentId ? ("assistant" as const) : ("user" as const), parts: [{ type: "text" as const, text }] }];
    });
  }

  emit(run: RunTicket, delta: Delta): void {
    this.deps.realtime.pushDelta(run.ownerId, run.conversationId, run.id, delta);
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
   * never stops counting before its cost lands), records how the run ended, and queues the follow-up when the owner
   * wrote meanwhile (`pending_seq` beyond `covers_seq`) and the Agent can still answer. Announced after commit.
   */
  async finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: { inputChars: number; outputChars: number }): Promise<void> {
    const { db, config } = this.deps;
    const now = new Date();
    const result = await db.tx(async (t) => {
      const agent = await lockAgent(t, run.agentId);
      const state = await t.query<{ status: string; covers_seq: string | null; pending_seq: string | null }>(
        "select status, covers_seq::text, pending_seq::text from agent_runs where id = $1 for update",
        [run.id],
      );
      if (state.rows[0]?.status !== "running") return null;
      const final = recorded(end, agent);
      await settle(t, config, run.id, usage, fallback, final.status, now);
      const error = final.status === "failed" || final.status === "cancelled" ? (final.error ?? null) : null;
      const resetsAt = final.status === "failed" && final.resetsAt !== undefined ? final.resetsAt : null;
      const updated = await t.query<RunRow>(
        `update agent_runs as r set status = $2, error = $3, resets_at = $4, finished_at = now() where r.id = $1 returning ${RUN_COLUMNS}`,
        [run.id, final.status, error, resetsAt],
      );
      const ended: Announced = { ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(updated.rows[0]!) };
      const covers = Number(state.rows[0].covers_seq ?? 0);
      const pending = Number(state.rows[0].pending_seq ?? 0);
      const followUp = pending > covers && !agent.paused && !agent.deleted && agent.model !== null ? await queueRun(t, agent, pending) : null;
      return { ended, followUp };
    });
    this.active.delete(run.id);
    this.stopping.delete(run.id);
    if (!result) return;
    this.announce(result.ended);
    if (result.followUp) this.announce(result.followUp);
  }
}

export function createAgentPort(deps: AgentPortDeps): DbAgentPort {
  return new DbAgentPort(deps);
}
