import type { FastifyBaseLogger } from "fastify";
import { MICRO_PER_POINT } from "../accounts/store.ts";
import type { BlobStore } from "../attachments/blob.ts";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import { currentMembership } from "../conversations/store.ts";
import type { Db, Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { admitRun, raiseHold, type ChargeTo } from "../metering/admit.ts";
import { assertCount, costMicro, isCount, type Price } from "../metering/prices.ts";
import { settle } from "../metering/settle.ts";
import { correctedEstimate, estimateTokens, holdTokens, planRatio, ratioKey, readRatio, TOOL_PREAMBLE_TOKENS } from "../metering/tokens.ts";
import { loadNotes } from "../memory/passage.ts";
import { markRead, type ReadEvents } from "../messages/read.ts";
import type { ToolCall, ToolSpec } from "../models/gateway.ts";
import { resolveModel, type Resolved } from "../models/resolve.ts";
import { KeyUnreadableError } from "../providers/crypto.ts";
import { markToolsOff } from "../providers/store.ts";
import { blockedEitherWay } from "../social/relations.ts";
import type { Hub } from "../sync/hub.ts";
import { createWhisper, type WhisperBody } from "../whispers/store.ts";
import { toWireWhisper } from "../whispers/wire.ts";
import {
  askerLine,
  BlobStoreDown,
  buildContext,
  callsSeen,
  GROUP_CONTEXT_MESSAGES,
  hasOwnerTurn,
  loadContext,
  loadGroupScene,
  withRoster,
  type BuiltContext,
  type LoadedContext,
  type Speaker,
} from "./context.ts";
import { contextBudget, holdsNewest } from "./runtime/context.ts";
import { FINAL_LINE } from "./runtime/loop.ts";
import { postAsAgent } from "./conversation.ts";
import type { Reviewer } from "../memory/reviewer.ts";
import type { ProactiveScheduler } from "./proactive/scheduler.ts";
import {
  BUSY,
  NOTHING,
  RunNotRunning,
  UNAVAILABLE,
  type Activity,
  type AgentPort,
  type Delta,
  type Estimated,
  type Prepared,
  type Reply,
  type RunEnd,
  type RunTicket,
  type ToolOutcome,
  type Usage,
} from "./runtime/port.ts";
import { fitNotes, groupSystemText, NO_NOTES, passageBudget, systemText, systemTokens, type SystemText } from "./runtime/prompt.ts";
import {
  actOnTriggered,
  budgetReachedWith,
  followUp,
  followUpOf,
  hearFrom,
  noneTold,
  pushBudgetReached,
  refusedAtAdmission,
  RUN_COLUMNS,
  toWireRun,
  type Announced,
  type FollowUp,
  type Interruption,
  type Lane,
  type RunRow,
  type Told,
} from "./runs.ts";
import { lockAgent, type AgentRow } from "./store.ts";

export interface AgentPortDeps {
  db: Db;
  config: Config;
  /** Where attachments are read from for what the model is shown (`buildContext`). */
  blobs: BlobStore;
  realtime: Pick<Hub, "pushRun" | "pushDelta" | "pushActivity" | "pushAgentChanged" | "pushChargedReply" | "pushWhisper">;
  conversations: ConversationEvents;
  reads: ReadEvents;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info">;
  /** How a candidate for a group run's mark is drawn (`loadContext`, `newMark`); default prompt.ts `drawMark`. Tests fix it. */
  drawMark?: () => string;
  /** The proactive scheduler (proactive/scheduler.ts), when there is one: an Agent's post drops the judgement waiting there. */
  proactive?: Pick<ProactiveScheduler, "cancelled"> | null;
  /** The reviewer (memory/reviewer.ts), when there is one: told after a reply was posted, so it can look at the conversation once it is quiet. */
  memory?: Pick<Reviewer, "noted"> | null;
  /** The tools a reply may be offered and how they run; none (the default): no reply is offered any. */
  toolbox?: Toolbox | null;
}

/**
 * Where a reply's tools come from (`AgentPortDeps.toolbox`): what a run is offered, with at most how many calls of each
 * tool one reply may run (`ToolRun.perTool`) and what each tool's work is (`ToolRun.kinds`: the status while it runs,
 * what it is counted under), and how a call runs (`AgentPort.tool`: never rejecting for a call it cannot answer, its
 * signal honoured; what it found and searched for in its outcome, `ToolOutcome`). Nothing is offered while
 * `TOOLS.enabled` is false. `offer` is asked once per run, in `begin`'s first step (inside its transaction, under the
 * run's locks), before the context is planned.
 */
export interface Toolbox {
  offer(run: RunTicket): { tools: ToolSpec[]; perTool: Record<string, number>; kinds: Record<string, Activity> };
  run(run: RunTicket, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
}

/** What a toolbox offers a run. */
type Offer = ReturnType<Toolbox["offer"]>;

/**
 * Tokens a reply offered tools keeps in its context plan for what they bring back (`begin`): two results of
 * `resultMaxWeight` at the plan's `ratio`, but at most a third of `conversation`, what the plan gives the conversation
 * beside the system text and the tools' definitions. Planned only: nothing is held or charged for it.
 */
const resultReserve = (resultMaxWeight: number, ratio: number, conversation: number): number =>
  Math.min(Math.ceil(2 * resultMaxWeight * ratio), Math.floor(conversation / 3));

/**
 * What a provider model's owner is told, once, when a reply finds it cannot use tools (`toolsUnusable`): a whisper in
 * that reply's conversation, offering no button (nothing to answer).
 */
export const TOOLS_OFF: WhisperBody = { text: "这个模型不支持查东西，已改为普通聊天。可以在模型设置里重新打开再试。", actions: [] };

/** The model a run's call went to, kept from `begin` in this process (`RunFlags.model`): what `toolsUnusable` marks. */
type RunModel = { source: "site"; id: string } | { source: "provider"; providerId: string; name: string };

/** What `extend` prices a reply's later calls by, kept from `begin` in this process (`RunFlags.money`). */
interface RunMoney {
  /** The site model's price; null for a provider's model, which costs nothing. */
  price: Price | null;
  /** The call's output limit, which every call of the reply is held for whole. */
  maxOutputTokens: number;
}

/** Everything the reply was to answer is before a new topic its owner started: nothing failed, nothing to retry. */
const STARTED_OVER: RunEnd = { status: "cancelled" };
/**
 * In a group, none of the messages that called for the reply is one its Agent can see (context.ts `callsSeen`): nothing is
 * left to answer — nothing failed, nothing to retry.
 */
const NOTHING_LEFT: RunEnd = { status: "cancelled" };
/**
 * A block made since the call, either way, between the Agent's owner and the person who called for the reply (its
 * `caller_id`; none for a reply nobody called for): that call would be refused now (runs.ts `triggerInGroup`,
 * `triggerFromAgent`), so the reply ends before any call — nothing held or charged, no message, nothing to retry.
 */
const BLOCKED_SINCE: RunEnd = { status: "cancelled" };
/** The model's context cannot hold the owner's newest message (`holdsNewest`): no call is made. */
const TOO_SMALL: RunEnd = { status: "failed", error: "context_too_small" };
/** The provider's saved key cannot be opened (`KeyUnreadableError`): as a refused key, its owner must save it again. */
const KEY_UNREADABLE: RunEnd = { status: "failed", error: "provider_rejected" };
/** The Agent's model does not resolve (`resolveModel` null: off its provider's list, no longer configured): not retryable. */
const MODEL_GONE: RunEnd = { status: "failed", error: "model_gone" };
/** The Agent is no longer a member of the run's group: nothing is called or posted there. */
const REMOVED: RunEnd = { status: "cancelled", error: "agent_removed" };
/**
 * Ended quietly before any call: refused as it was admitted (runs.ts `refusedAtAdmission`: someone else's call found the
 * Agent's others' daily budget spent, or a reply nobody asked for found its owner's switch off or its proactive budget
 * spent), or a reply nobody asked for that someone called after its claim (`begin`'s first step). No call, nothing held
 * or charged — nothing failed and there is nothing to retry, as for such a call refused when it was made (of which
 * nothing is recorded); the group is told only by the others' budget's notice.
 */
const ENDED_QUIETLY: RunEnd = { status: "cancelled" };

/** Why `postAsAgent` refuses a run's reply (409): the Agent's state, or what interrupted the run. */
const REFUSED: ReadonlySet<string> = new Set(["agent_paused", "agent_deleted", "agent_removed", "halted"]);

/** What `begin`, `finish` and recovery read of the run, under its row lock. */
interface RunState {
  status: string;
  covers_seq: string | null;
  pending_seq: string | null;
  interrupted: Interruption | null;
  lane: Lane;
}
const RUN_STATE = "status, covers_seq::text, pending_seq::text, interrupted, lane";

/**
 * The one rule for a follow-up (README "Agents and runs", Coalescing): a run that has ended is followed by a reply to
 * what its owner wrote meanwhile when something was noted on it (`pending_seq` beyond what it covered) and its Agent
 * can still answer (not paused, not deleted, has a model) — however the run itself ended. A pause or delete drops what
 * was noted (runs.ts `interruptRuns`), and so does the Agent's leaving the run's group (group-leave.ts
 * `endRunsInGroup`); nothing is noted while the Agent is paused or out of that group, so what is noted on an
 * interrupted run came after the resume, and is answered. A run that ended `agent_removed` (its Agent is no longer a
 * member of the run's group, however that was found) is followed by nothing: what was noted on it is dropped
 * (`droppedOnEnd`). Whether it is queued, as whose, and how it meets the owner's replies a minute is runs.ts
 * `followUp`'s.
 */
function followUpSeq(state: RunState, agent: AgentRow, end: RunEnd): number | null {
  if (droppedOnEnd(end)) return null;
  const covers = Number(state.covers_seq ?? 0);
  const pending = Number(state.pending_seq ?? 0);
  return pending > covers && !agent.paused && !agent.deleted && agent.model !== null ? pending : null;
}

/** A run that ends so is followed by nothing, and what was noted on it (`pending_seq`) is cleared as it ends. */
const droppedOnEnd = (end: RunEnd): boolean => end.status === "cancelled" && end.error === "agent_removed";

/**
 * A run's in-process flags, from its claim until it has finished. A delta waiting to be delivered keeps the flags it
 * was emitted under, so once `silenced` it stays dropped, however late the hub gets to it — also after `finish` has
 * forgotten the run.
 */
interface RunFlags {
  /** Its owner asked it to stop, or its Agent's pause, delete or leaving the run's group interrupted it. */
  stop: boolean;
  /** Its Agent's pause, delete or leaving the run's group interrupted it: nothing more of it is pushed. */
  silenced: boolean;
  /**
   * Its conversation is a group (decided at `begin`, from the run's conversation and its Agent's own): none of it is
   * streamed (plan ruling 2) — its reply arrives whole, with its message.
   */
  group: boolean;
  /**
   * In a group, the run's mark (prompt.ts `newMark`), kept from the moment `begin` hands over the call that carries it:
   * `post` takes this copy, never one the worker could hand it, out of the reply. Null until then, and in the Agent's own
   * conversation. A run this process did not begin has none — after a restart, every run the previous process left
   * running is ended by recovery before the worker starts, its model's output gone with that process, so no such run
   * is ever posted. Never stored, pushed or logged.
   */
  mark: string | null;
  /** What `extend` prices the reply's later calls by, from `begin` once the call is admitted; null until then. */
  money: RunMoney | null;
  /** The model the reply calls, from `begin` once the call is admitted (with `money`); null until then. */
  model: RunModel | null;
}

/**
 * How a run is recorded, from what is true under `lockAgent` rather than what the worker could tell (an owner's stop
 * and a pause look alike to it): a reply that was posted stands — `done`, or `stopped` by its owner — whatever happened
 * to the Agent after; a run its Agent's pause, delete or leaving the run's group (`agent_removed`) interrupted, and that
 * posted nothing, is `cancelled` with that
 * reason (also when the Agent was resumed meanwhile); a refused post is `cancelled` for the Agent's state — deleted,
 * paused, or no longer a member of the run's group (`removed`).
 */
function recorded(end: RunEnd, s: { posted: boolean; interrupted: Interruption | null; agent: AgentRow; removed: boolean }): RunEnd {
  if (s.posted) return end.status === "stopped" ? end : { status: "done" };
  if (s.interrupted) return { status: "cancelled", error: s.interrupted };
  if (end.status === "cancelled" && end.error === undefined) {
    if (s.agent.deleted) return { status: "cancelled", error: "agent_deleted" };
    if (s.agent.paused) return { status: "cancelled", error: "agent_paused" };
    if (s.removed) return REMOVED;
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
      flags = { stop: false, silenced: false, group: false, mark: null, money: null, model: null };
      this.flags.set(runId, flags);
    }
    return flags;
  }

  /** What to call when a run is queued: the worker's wake-up. */
  onQueued(fn: () => void): void {
    this.wakeWorker = fn;
  }

  /**
   * After the transaction that changed it committed: the run goes to its owner's sockets (the hub reads who that is
   * from the run's row, `Hub.pushRun`); a queued one wakes the worker.
   */
  announce(a: Announced): void {
    this.deps.realtime.pushRun(a.conversationId, a.run);
    if (a.run.status === "queued") this.wakeWorker();
  }

  /** The owner asked a running run to stop. */
  requestStop(runId: string): void {
    this.flagsOf(runId).stop = true;
  }

  /**
   * Runs the Agent's pause or delete (runs.ts `interruptRuns`), or its leaving the run's group (group-leave.ts
   * `endRunsInGroup`), has just marked `interrupted`: their calls are abandoned
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
    const { rows } = await this.deps.db.query<RunRow & { agent_id: string; owner_id: string; conversation_id: string; lane: string; wait_ms: number }>(
      `with next as (
         select q.id from agent_runs q
          where q.status = 'queued' and q.purpose = 'reply'
            and (select count(*) from agent_runs x where x.owner_id = q.owner_id and x.status = 'running') < $1
            and (q.lane = 'own'
              or (select count(*) from agent_runs x where x.owner_id = q.owner_id and x.status = 'running' and x.lane <> 'own') < $2)
          order by q.created_at, q.id
          limit 1
          for update of q skip locked
       )
       update agent_runs as r set status = 'running', started_at = now() from next where r.id = next.id
       returning ${RUN_COLUMNS}, r.agent_id, r.owner_id, r.conversation_id, r.lane,
                 (extract(epoch from (r.started_at - r.created_at)) * 1000)::int as wait_ms`,
      [this.deps.config.agentMaxConcurrentRuns, this.deps.config.agentMaxConcurrentOthersRuns],
    );
    const row = rows[0];
    if (!row) return null;
    this.deps.log.info({ metric: "run_wait_ms", lane: row.lane, ms: row.wait_ms }, "agent run: claimed");
    const run: RunTicket = { id: row.id, agentId: row.agent_id, ownerId: row.owner_id, conversationId: row.conversation_id };
    this.flagsOf(run.id);
    this.announce({ ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(row) });
    return run;
  }

  /** Locks the run's conversation row, then the Agent's `agents` row (`lockAgent`), then the run's row, and reads them. */
  private async lockRun(t: Tx, run: RunTicket): Promise<{ agent: AgentRow; state: RunState }> {
    const agent = await lockAgent(t, run.agentId, run.conversationId);
    const state = await t.query<RunState>(`select ${RUN_STATE} from agent_runs where id = $1 for update`, [run.id]);
    // Ended elsewhere meanwhile (another instance's recovery, or the stale-run sweep): nothing more of it is done here.
    if (state.rows[0]?.status !== "running") throw new RunNotRunning(run.id, state.rows[0]?.status ?? null);
    return { agent, state: state.rows[0] };
  }

  /**
   * Under `lockRun`: how the run ends instead of calling its model — interrupted by its Agent's pause or delete (even if
   * resumed since) or by its leaving the run's group (even if back since), the Agent paused or deleted, or a stop asked
   * for — or null when it may go on.
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
   * 1. A short transaction under `lockRun`: a run that is `halted` ends here, and so does one in a group its Agent is no
   *    longer a member of (`cancelled`, `agent_removed`) and one whose model does not resolve (`failed`,
   *    `model_gone`). A run in a group is flagged so that none of it is streamed (`emit`). A reply nobody asked
   *    for (lane `proactive`) that a mention was noted on since its claim ends here quietly (`ENDED_QUIETLY`): the moment
   *    for an unasked remark has passed, and its follow-up answers the mention, noted still, in the caller's lane.
   *    Otherwise the run takes on what came meanwhile (`covers_seq` = max(covers, pending)), and what the model may be
   *    shown is read: the
   *    system text — its own conversation's (`systemPrompt`, with what the Agent calls its owner), or the group's
   *    (`groupSystemPrompt`, with the group's title, other Agents and roster, `loadGroupScene`; the roster's speakers
   *    are those of what `loadContext` read, `withRoster`) — and the conversation (`loadContext`, SQL only; in a group at
   *    most `agentGroupContextTokens` tokens of its latest `GROUP_CONTEXT_MESSAGES` messages, nothing at or before the
   *    run's asker's line (context.ts `askerLine`: the latest joining of its askers — those whose questions it answers,
   *    and everyone who wrote since what it covered before, recorded first, runs.ts `hearFrom`) but the calls it answers
   *    (context.ts `callsSeen`), each of someone else's
   *    labelled with the run's mark, which `loadContext` draws with `deps.drawMark` and the roster carries too; the
   *    port keeps it for `post` once the call is handed over, `RunFlags.mark`). In a group, a run none of whose calls its
   *    Agent can see ends there, before the conversation is read: `cancelled` with no error (`NOTHING_LEFT`). With no owner's message in it (in a group: nobody else's) the run ends without a call:
   *    `cancelled` with no error when everything it was to answer is before a new topic (its owner started over), else
   *    `failed` `busy`; and so does one whose model's context cannot hold the newest such message, or 200 tokens of it,
   *    beside the system text, roster and all (`failed`, `context_too_small`). Everything here is planned at the model's
   *    learned ratio when it is above 1 (metering/tokens.ts `planRatio`; read once, here, for the whole run), with a tenth
   *    of the room kept free (`contextBudget`). The tools the reply is offered are decided here, before the plan: its
   *    toolbox's (`AgentPortDeps.toolbox`; none while `TOOLS.enabled` is false, none for a model that cannot use them —
   *    `Resolved.tools` —, none without a toolbox; a reply offered none is told so in its system text, one offered some
   *    is not), their definitions
   *    (at the plan's ratio) and what providers add around them (`TOOL_PREAMBLE_TOKENS`) reserved in the plan as the
   *    system text is — and, from what that plan gives the conversation, room for what the tools bring back
   *    (`resultReserve`) and the last call's line (`FINAL_LINE`), reserved with them, so that the conversation is planned
   *    once more; when, with that reservation, the conversation would not get the room a call needs at least (the
   *    `context_too_small` rule), none are offered and the run is planned, and goes on, as one that offers none. The
   *    reservation is a plan only: nothing is held or charged for it (step 3 holds what is sent).
   * 2. No transaction: the attachments' bytes are read and the call's turns assembled (`buildContext`). A send to the
   *    conversation, a pause or a delete meanwhile does not wait for it. No further file is read once the run should
   *    stop (step 3 then ends it); a file that cannot be read is shown by its name; the store failing on two files
   *    before it has served one, or the step taking longer than `agentRunTimeoutMs`, ends the run `failed`, `busy`. When `closing`
   *    aborts (the service is closing) the read is abandoned and `begin` rejects with its reason before step 3: the run
   *    is still `running`, unadmitted, and its caller ends it (the worker: `release`).
   * 3. A short transaction under `lockRun` again: a run `halted` meanwhile ends as in step 1, with no call; when
   *    `closing` has aborted by the time the locks are held, the transaction rolls back and `begin` rejects with its
   *    reason, admitting nothing (as in step 2). Then what its lane is held to is read again (runs.ts
   *    `refusedAtAdmission`; replies settled while it waited queued may have spent a budget since): a run someone else
   *    called for (lane `others`) meets the Agent's others' daily budget, and a reply nobody asked for (`proactive`) its
   *    owner's switch and its proactive budget. Refused, it ends `cancelled` with no error (`ENDED_QUIETLY`) — no
   *    call, nothing held or charged — and the others' budget's notice, if this appended it, is published to the group
   *    after commit, the Agent pushed to its owner (a reply nobody asked for tells nobody). What step 1 took on (noted on
   *    the run after its claim) is handed back as noted — `covers_seq` back to what it covered before, `pending_seq` at
   *    least what it took on — so `finish`'s follow-up answers it as any: the owner's own mention is queued as theirs (the
   *    owner's calls are never refused by these), someone else's meets the others' budget again and is not queued once
   *    it is spent.
   *    Otherwise
   *    the call is admitted holding the most its input can cost: its text at its utf-8 bytes, at most what the model's
   *    context leaves beside the output limit, images and PDFs at their constants (metering/tokens.ts `holdTokens`; no
   *    ratio in it; 402 `no_quota` ends the run failed); the estimate itself (a call of text only) and the ratio's key are recorded on
   *    the run for settlement to learn from, and the Agent's read marker moves to what the run covers (announced after
   *    commit). What settlement falls back on when no usage is reported is the estimate with its text corrected by the
   *    model's learned ratio (the one step 1 read). The reasoning level is the Agent's when the model allows it, else `none`.
   *    A reply offered tools (step 1) has their definitions held at their bytes too, and what providers add around them
   *    (`TOOL_PREAMBLE_TOKENS`); no estimate is recorded (such a reply teaches the ratio nothing), and what its later
   *    calls are priced by is kept for `extend` (`RunFlags.money`).
   */
  async begin(run: RunTicket, closing?: AbortSignal): Promise<Prepared | RunEnd> {
    const { db, config, blobs, log } = this.deps;
    const now = new Date();
    const first = await db.tx(async (t): Promise<
      | { end: RunEnd }
      | { resolved: Resolved; loaded: LoadedContext; covers: number; coveredBefore: number; key: string; ratio: number; offer: Offer | null; reserved: number }
    > => {
      const { agent, state } = await this.lockRun(t, run);
      // Anywhere but the Agent's own conversation is a group: nothing of the reply is streamed (`emit`).
      const group = run.conversationId !== agent.conversationId;
      if (group) this.flagsOf(run.id).group = true;
      const halted = this.halted(run, agent, state);
      if (halted) return { end: halted };
      // In a group: the Agent must still be a member there (nothing else may have marked the run yet).
      const scene = group ? await loadGroupScene(t, agent, run.conversationId) : null;
      if (group && scene === null) return { end: REMOVED };
      // A block made since the call, either way, between the Agent's owner and its caller: the call is refused now.
      const blocked = await t.query(`select 1 from agent_runs r where r.id = $1 and ${blockedEitherWay("$2::uuid", "r.caller_id")}`, [run.id, agent.ownerId]);
      if (blocked.rowCount !== 0) return { end: BLOCKED_SINCE };
      // A reply nobody asked for that someone has called since its claim: no unasked remark now. What was noted on it
      // stays noted, so its follow-up answers the call in the caller's lane.
      if (state.lane === "proactive" && Number(state.pending_seq ?? 0) > Number(state.covers_seq ?? 0)) return { end: ENDED_QUIETLY };

      let resolved;
      try {
        resolved = await resolveModel(t, config, agent);
      } catch (err) {
        if (!(err instanceof KeyUnreadableError)) throw err;
        // As a key the provider refused: its owner must save it again. Not retryable as it is.
        log.error({ err, runId: run.id }, "agent run: the provider's saved key cannot be opened (PROVIDER_KEY_SECRET changed, or the value was moved or damaged)");
        return { end: KEY_UNREADABLE };
      }
      if (!resolved) return { end: MODEL_GONE };
      // The model's learned ratio, read once for the run: the context is planned at it when it is above 1 (`planRatio`),
      // and step 3 corrects by it the input estimate settlement falls back on (never the hold).
      const key = ratioKey(resolved);
      const ratio = await readRatio(t, key);
      const planned = planRatio(ratio);

      // What it covered before taking on what was noted on it since its claim (kept: step 3 may hand that back).
      const coveredBefore = Number(state.covers_seq ?? 0);
      const covers = Math.max(coveredBefore, Number(state.pending_seq ?? 0));
      await t.query("update agent_runs set covers_seq = $2, pending_seq = null where id = $1", [run.id, covers]);
      const owner = await t.query<{ display_name: string }>("select display_name from principals where id = $1", [agent.ownerId]);
      const displayName = owner.rows[0]!.display_name;
      // What its Agent may be shown of its memory here (`notesFor`'s rules), read once with the rest, under the same locks.
      // An onboarding run (its own conversation, no persona yet) is shown none (`systemPrompt`), so none is read.
      // At most `MEMORY.passageShare` of the model's context goes to it: over that entries are left out (`fitNotes`).
      const notes =
        !group && agent.persona === ""
          ? NO_NOTES
          : fitNotes(
              await loadNotes(t, agent, { conversationId: run.conversationId, group }),
              group,
              config.siteTimezone,
              displayName,
              passageBudget(resolved.contextTokens, resolved.call.maxOutputTokens, config.memory.passageShare),
              planned,
            ).notes;
      // A run still proactive when it starts (its stored lane: a mention that took it over changed it) is told nobody called it.
      // The system text with the run's mark and, in a group, its roster of who is there with those who spoke: a group's
      // carries both; the Agent's own conversation has neither (it says what to call the owner, if they set that). A reply
      // offered tools (`tools`) is not told it has none; one offered none is, as always.
      const system =
        (tools: boolean) =>
        (mark: string, speakers: readonly Speaker[]): SystemText =>
          scene
            ? groupSystemText(agent, { displayName }, withRoster(scene, speakers), now, config.siteTimezone, mark, state.lane === "proactive", notes, tools)
            : systemText(agent, { displayName }, now, agent.persona === "" ? "onboarding" : "normal", config.siteTimezone, notes, tools);
      // In a group, at most `AGENT_GROUP_CONTEXT_TOKENS` of its latest `GROUP_CONTEXT_MESSAGES` messages are shown, and
      // nothing at or before its asker's line (`askerLine`, Task 10b) but the calls it answers (`callsSeen`), read once,
      // here, for the whole run. First, whoever it will hear from beyond what it was asked — everyone who wrote since
      // what it covered before taking on what was noted above, those calls included — is recorded among its askers
      // (runs.ts `hearFrom`, fix round 2), so the line counts them, and so does whatever it hands down.
      if (group) await hearFrom(t, run.id, coveredBefore, null);
      const calls = group ? await callsSeen(t, agent.id, run.id) : [];
      if (group && calls.length === 0) return { end: NOTHING_LEFT };
      const cap = group ? { maxTokens: config.agentGroupContextTokens, maxMessages: GROUP_CONTEXT_MESSAGES, after: await askerLine(t, run.id), calls } : null;
      const plan = { agentId: agent.id, ownerId: agent.ownerId, conversationId: run.conversationId, coversSeq: covers, group: cap, planRatio: planned };
      // The tools the reply is offered, decided in this order: none while `TOOLS.enabled` is false; none for a model that
      // cannot use them (`Resolved.tools`: its configuration, or its owner's list); none without a toolbox, or when it
      // offers none; then what they take of the context — their definitions at the plan's ratio and what providers add
      // around them, reserved as the system text is — and room for what they bring back (below).
      let offer: Offer | null = config.tools.enabled && resolved.tools && this.deps.toolbox ? this.deps.toolbox.offer(run) : null;
      if (offer !== null && offer.tools.length === 0) offer = null;
      const definitions = offer === null ? 0 : estimateTokens(JSON.stringify(offer.tools), planned) + TOOL_PREAMBLE_TOKENS;
      let reserved = definitions;
      let loaded = await loadContext(t, { ...plan, reserved }, resolved, system(offer !== null), this.deps.drawMark);
      if (offer !== null && holdsNewest(loaded.entries, loaded.budget, loaded.planRatio)) {
        // And room for what the tools bring back, from what that plan gives the conversation (`resultReserve`), with
        // the last call's line: reserved as the definitions are.
        reserved = definitions + estimateTokens(`\n\n${FINAL_LINE}`, planned) + resultReserve(config.tools.resultMaxWeight, planned, loaded.budget);
        loaded = await loadContext(t, { ...plan, reserved }, resolved, system(true), this.deps.drawMark);
      }
      if (offer !== null && !holdsNewest(loaded.entries, loaded.budget, loaded.planRatio)) {
        // With the tools reserved the conversation would not get the room a call needs at least: none are offered, and
        // the reply is planned, and made, as one that offers none (its system text saying so).
        offer = null;
        reserved = 0;
        loaded = await loadContext(t, plan, resolved, system(false), this.deps.drawMark);
      }
      if (!hasOwnerTurn(loaded)) return { end: loaded.topicStart > 0 && covers <= loaded.topicStart ? STARTED_OVER : BUSY };
      if (!holdsNewest(loaded.entries, loaded.budget, loaded.planRatio)) return { end: TOO_SMALL };
      return { resolved, loaded, covers, coveredBefore, key, ratio, offer, reserved };
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

    const result = await db.tx(async (t): Promise<{ end: RunEnd; told?: Told } | { prepared: Prepared; read: number | null; money: RunMoney }> => {
      const { agent, state } = await this.lockRun(t, run);
      const halted = this.halted(run, agent, state);
      if (halted) return { end: halted };
      // The service may have started closing while this waited for the locks: then nothing is admitted (thrown, so the
      // transaction rolls back) and the run is left running, unadmitted, for the caller to end (the worker: `release`).
      if (closing?.aborted) throw closing.reason;
      // What its lane is held to, once more: replies settled while it waited count now, and its owner may have turned a
      // reply nobody asked for off. Refused, what step 1 took on (noted on it after its claim — its owner's mention, say)
      // is handed back as noted, so `finish`'s follow-up answers it by the usual rule: its owner's own is queued; someone
      // else's meets the others' budget again and is simply not queued (no second notice that day), so nothing loops.
      const told = await refusedAtAdmission(t, run.conversationId, agent, state.lane, config);
      if (told) {
        if (first.covers > first.coveredBefore) {
          await t.query("update agent_runs set covers_seq = $2, pending_seq = greatest(coalesce(pending_seq, 0), $3) where id = $1", [
            run.id,
            first.coveredBefore,
            first.covers,
          ]);
        }
        return { end: ENDED_QUIETLY, told };
      }
      const { resolved, loaded, covers, key, ratio, offer, reserved } = first;
      // The tools the reply is offered (step 1).
      const tools = offer?.tools ?? [];
      // What admission holds for the input: the most it can cost — its text at its utf-8 bytes, at most what the context
      // leaves beside the output limit (`holdTokens`), images and PDFs at their constants — whatever the model's ratio.
      // Offered tools go with the call too: their definitions are held at their bytes as well, and what providers add
      // around them.
      const texts = [loaded.system.text, ...context.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))];
      const held =
        tools.length === 0
          ? holdTokens(texts, resolved.contextTokens, resolved.call.maxOutputTokens) + context.fixedTokens
          : holdTokens([...texts, JSON.stringify(tools)], resolved.contextTokens, resolved.call.maxOutputTokens) + TOOL_PREAMBLE_TOKENS + context.fixedTokens;
      // The input as the model is expected to count it: its text times the model's learned ratio (1 until it has learned;
      // read in step 1), images and PDFs at their constants. What settlement falls back on when no usage is reported.
      const input = correctedEstimate(context.inputTokensEstimate, context.fixedTokens, ratio);
      try {
        await admitRun(t, config, run.id, run.ownerId, resolved, held, now);
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== "no_quota") throw err;
        const resetsAt = err.details.resetsAt;
        return { end: { status: "failed", error: "no_quota", ...(typeof resetsAt === "string" ? { resetsAt } : {}) } };
      }
      // What settlement learns the ratio from: the estimate at ratio 1 of a call that showed text only (an image's or a
      // PDF's real tokens are not text's), and the ratio's key. A reply that offers tools teaches nothing: its rounds send
      // the tools and the steps, which the estimate does not count, and settle on their summed usage.
      await t.query("update agent_runs set input_estimate = $2, ratio_key = $3 where id = $1", [
        run.id,
        context.fixedTokens === 0 && tools.length === 0 ? context.inputTokensEstimate : null,
        key,
      ]);
      const marked = await markRead(t, agent.id, run.conversationId, covers);
      const reasoning = resolved.reasoning;
      const planned = planRatio(ratio);
      return {
        prepared: {
          call: { ...resolved.call, system: loaded.system.text, messages: context.messages, reasoning },
          inputChars: input,
          tools,
          toolRun:
            offer === null || tools.length === 0
              ? null
              : {
                  perTool: offer.perTool,
                  kinds: offer.kinds,
                  contextTokens: resolved.contextTokens,
                  fixedTokens: context.fixedTokens,
                  ratio,
                  planRatio: planned,
                  planned: correctedEstimate(context.inputTokensEstimate, context.fixedTokens, planned),
                  // The plan's limit: the system text, the reservation (step 1) and the conversation's budget before a
                  // group's cap — what the rounds may fill is what is left of it.
                  limit:
                    systemTokens(loaded.system, planned) +
                    reserved +
                    contextBudget(resolved.contextTokens, resolved.call.maxOutputTokens, loaded.system, planned, reserved),
                },
        },
        read: marked && marked.readSeq > marked.previous ? marked.readSeq : null,
        money: { price: resolved.price ?? null, maxOutputTokens: resolved.call.maxOutputTokens },
      };
    });
    if ("end" in result) {
      // The others' daily budget's notice, if the admission's refusal appended it, goes to the group; the Agent to its owner.
      if (result.told) this.tell(result.told);
      return result.end;
    }
    if (result.read !== null) this.deps.reads.publish({ conversationId: run.conversationId, principalId: run.agentId, seq: result.read }, log);
    // The mark the call carries is the one `post` takes out of the reply.
    const flags = this.flagsOf(run.id);
    flags.mark = first.loaded.mark;
    flags.money = result.money;
    const { resolved } = first;
    flags.model = resolved.source === "site" ? { source: "site", id: resolved.name } : { source: "provider", providerId: resolved.providerId!, name: resolved.name };
    return result.prepared;
  }

  emit(run: RunTicket, delta: Delta): void {
    // Checked now and again when the hub delivers it, against the flags it was emitted under: once the pause, delete or
    // removal from the run's group has answered, no delta goes out, however late it is delivered. A run that has
    // finished emits nothing, and a run in a group never does (to nobody, its owner included).
    const flags = this.flags.get(run.id);
    if (!flags || flags.silenced || flags.group) return;
    this.deps.realtime.pushDelta(run.ownerId, run.conversationId, run.id, delta, () => !flags.silenced);
  }

  /** `AgentPort.tool`: through the toolbox that offered the tool (`begin`); with none nothing was offered, and nothing runs. */
  tool(run: RunTicket, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    const box = this.deps.toolbox;
    if (!box) return Promise.reject(new Error("no tool is offered: there is no toolbox"));
    return box.run(run, call, signal);
  }

  /**
   * `AgentPort.extend`, in one transaction under `lockRun` (the run's conversation row and its Agent's, then the run's;
   * the account's after, as admission takes them): a run no longer running answers "stop". At the site model's price as
   * `begin` resolved it (`RunMoney`), what the reply has cost so far is `spent` when it is two counts, else `estimated` —
   * what settlement would charge now, before its cap — and the most the next call can cost is `nextInputTokens` (the
   * worker's bound of everything that call sends — the last call's line, every step and the tools' definitions included —
   * whichever call it is: tool round or last) and the whole output limit. In this order:
   * 1. a budget of the run's lane reached by what it has cost so far (runs.ts `budgetReachedWith`: the others' daily,
   *    the proactive daily, the chain budget) makes the answer at most "final";
   * 2. so far and the next call's most within `TOOLS.maxPoints` and within what is left of the run's source, its own hold
   *    added back (admit.ts `raiseHold`), and step 1 not reached: the hold raised to that — "ok";
   * 3. else, while what is left is above what the reply has spent (admission's own "anything left" rule): the hold raised
   *    to so far and the next call's most, past what is left if it must, as an admitted call's may be — "final";
   * 4. else "stop", the hold as it was.
   * A hold is never lowered. A provider's model costs nothing: nothing is held, and the answer is "ok", or "final" once a
   * budget of its lane is reached (its rounds and its context bound it otherwise, in the worker).
   */
  async extend(run: RunTicket, spent: Usage | null, estimated: Estimated, nextInputTokens: number): Promise<"ok" | "final" | "stop"> {
    assertCount("extend: estimated.inputChars", estimated.inputChars);
    assertCount("extend: estimated.outputChars", estimated.outputChars);
    assertCount("extend: nextInputTokens", nextInputTokens);
    const money = this.flags.get(run.id)?.money;
    // A run this process did not begin: nothing more is called for it.
    if (!money) return "stop";
    const { db, config } = this.deps;
    try {
      return await db.tx(async (t) => {
        const { agent, state } = await this.lockRun(t, run);
        const lane = { conversationId: run.conversationId, lane: state.lane, coversSeq: Number(state.covers_seq ?? 0) };
        const row = (await t.query<{ charge_to: ChargeTo | null; hold: string }>("select charge_to, hold_micro::text as hold from agent_runs where id = $1", [run.id])).rows[0]!;
        if (money.price === null || row.charge_to === null) return (await budgetReachedWith(t, lane, agent, 0n, config)) ? "final" : "ok";
        const reported = spent !== null && isCount(spent.inputTokens) && isCount(spent.outputTokens);
        const cost = costMicro(money.price, reported ? spent.inputTokens : estimated.inputChars, reported ? spent.outputTokens : estimated.outputChars);
        const next = costMicro(money.price, nextInputTokens, money.maxOutputTokens);
        const tools = cost + next <= BigInt(config.tools.maxPoints) * MICRO_PER_POINT && !(await budgetReachedWith(t, lane, agent, cost, config));
        return raiseHold(t, config, { id: run.id, ownerId: run.ownerId, chargeTo: row.charge_to, holdMicro: BigInt(row.hold) }, cost, cost + next, tools, new Date());
      });
    } catch (err) {
      if (err instanceof RunNotRunning) return "stop";
      throw err;
    }
  }

  /**
   * `AgentPort.activity`: the kind, or null, to the run's owner with the run, and in a group to every other current member
   * with the Agent's state (`Hub.pushActivity`) — in its own conversation and in a group alike, though nothing of a group's
   * reply streams. Dropped like a delta once the Agent's pause, delete or removal has silenced the run, also one still
   * waiting in the hub's queue; nothing for a run this process is not working on.
   */
  activity(run: RunTicket, activity: Activity | null): void {
    const flags = this.flags.get(run.id);
    if (!flags || flags.silenced) return;
    this.deps.realtime.pushActivity(run.conversationId, run.id, activity, () => !flags.silenced);
  }

  /**
   * `AgentPort.toolsUnusable`: the reply found its model unable to use tools (its upstream refused them, or it called them
   * garbled twice). A site model's configuration is the operator's and is never changed: one metric line names the model,
   * and nothing else is done. A provider's model is marked, in one transaction: `tools: false` on its owner's entry
   * (`markToolsOff`, the provider's row first: see there why it may come first), only when the entry does not say so
   * already — and only then a whisper (`TOOLS_OFF`, kind `tools_off`, no button) to its owner in the reply's
   * conversation (`createWhisper`, taking the conversation's row and then the Agent's for share, the whisper's row last),
   * pushed to them after commit; so its owner is told once per model, however many replies find it out at the same
   * moment. Where the whisper cannot be made (its owner or the Agent is no longer a member there, the Agent deleted) the
   * model is still marked, and nobody is told. Nothing for a run this process did not begin. Whatever turns tools off, the
   * next reply is offered none (`begin`), and is the reply it always was.
   */
  async toolsUnusable(run: RunTicket, _why: "refused" | "garbled"): Promise<void> {
    const model = this.flags.get(run.id)?.model;
    if (!model) return;
    const { db, log, realtime } = this.deps;
    if (model.source === "site") {
      log.info({ metric: "tools_refused_site", model: model.id }, "agent run: a site model could not use the tools");
      return;
    }
    const told = await db.tx(async (t) => {
      if (!(await markToolsOff(t, run.ownerId, model.providerId, model.name))) return null;
      return createWhisper(t, { conversationId: run.conversationId, ownerId: run.ownerId, agentId: run.agentId, kind: "tools_off", body: TOOLS_OFF }, log);
    });
    if (told) realtime.pushWhisper(told.ownerId, toWireWhisper(told));
  }

  /**
   * `postAsAgent` in its own transaction, announced after commit; a reply that proposed a persona (and so superseded
   * the Agent's earlier open proposals) also tells the owner's sockets to look at the Agent's proposals again (`agent`;
   * never in a group, where nothing proposes). In a group the reply loses the run's mark — the port's own copy, kept from
   * `begin` (`RunFlags.mark`) — and, once posted, drops the proactive judgement waiting there (`deps.proactive`).
   * "refused" for the Agent's state or a mark on the run — paused, deleted,
   * out of the run's group (`agent_removed`), halted — and also when the run is no longer `running` (`RunNotRunning`:
   * another instance's recovery ended it while this one answered); `finish` then finds it ended and leaves it as that
   * recovery recorded it.
   */
  async post(run: RunTicket, out: Reply): Promise<"posted" | "refused" | "empty"> {
    const mark = this.flags.get(run.id)?.mark ?? null;
    try {
      const posted = await this.deps.db.tx((t) => postAsAgent(t, run.agentId, run.conversationId, run.id, out, mark, this.deps.config));
      if (!posted) return "empty";
      const { message, duplicate, triggered } = posted;
      // In a group, the notices the Agent's message led to follow it; the runs it called for go to their owners, the
      // calls over its owner's limit on other people's Agents are only logged, and the owners of Agents whose others'
      // daily budget it found spent are pushed them.
      if (!duplicate) this.deps.conversations.publish({ messages: [message, ...triggered.notices], conversations: [] }, this.deps.log);
      if (!duplicate && typeof message.body.proposalId === "string") this.deps.realtime.pushAgentChanged(run.ownerId, run.agentId);
      actOnTriggered(triggered, { announce: (called) => this.announce(called), log: this.deps.log, realtime: this.deps.realtime });
      // The group moved on: a judgement waiting there for a person's message is dropped (the decision would refuse that
      // message now). Nothing ever waits in the Agent's own conversation.
      if (!duplicate) this.deps.proactive?.cancelled(run.conversationId);
      return "posted";
    } catch (err) {
      if (err instanceof AppError && REFUSED.has(err.code)) return "refused";
      if (err instanceof RunNotRunning) {
        this.deps.log.warn({ runId: run.id, status: err.status }, "agent run: ended elsewhere while it was answered (another instance's recovery); its reply is not posted");
        return "refused";
      }
      throw err;
    }
  }

  /**
   * After commit, what a refusal told (runs.ts `Told`): the notices it appended go to their group, and each Agent whose
   * others' daily budget it found spent to its owner (`pushBudgetReached`).
   */
  private tell(told: Told): void {
    if (told.notices.length > 0) this.deps.conversations.publish({ messages: told.notices, conversations: [] }, this.deps.log);
    pushBudgetReached(this.deps.realtime, told.budgetReached);
  }

  /**
   * One transaction under `lockAgent` on the run's conversation: settles the call (it leaves `running` in the same
   * transaction, so its hold never stops counting before its cost lands) — at no charge when it failed on our side
   * (`busy`: the reply could not be stored) — records how the run ended (`recorded`), and follows it up by
   * `followUpSeq`, in the run's conversation (runs.ts `followUp`: in a group, under the owner's replies a minute, the
   * halt, the chain budget and the others' daily budget). Announced after commit, and the notices the follow-up appended
   * are published after the run's end (the owner of an Agent whose others' daily budget refused it is pushed it). A run
   * ended elsewhere meanwhile (another instance's recovery, the stale-run sweep, a stop of a run this
   * process was not seen working on) is left as that recorded it, and its owner is told how it stands now, so no
   * "replying" stays shown. A run whose reply was posted is pushed that reply once more, to its owner only, before its
   * end (`Hub.pushChargedReply`): now that the run is charged, the reply carries its `via`. The run's flags are forgotten
   * in any case, also when this throws (a delta still waiting keeps its own).
   */
  async finish(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: Estimated): Promise<void> {
    let result: Recorded | null | undefined;
    try {
      result = await this.record(run, end, usage, fallback, new Date());
    } finally {
      // An interrupted run is silenced here too, whether or not the pause's (or removal's) own call (`interruptRuns`)
      // came first.
      const flags = this.flags.get(run.id);
      if (flags && result?.interrupted) flags.silenced = true;
      this.flags.delete(run.id);
    }
    if (!result) return;
    if (result.reply !== null) this.deps.realtime.pushChargedReply(run.conversationId, run.ownerId, result.reply);
    this.announce(result.ended);
    // A reply stands: the conversation may have something to remember (the reviewer never throws and reads for itself).
    if (result.reply !== null) this.deps.memory?.noted(run.agentId, run.conversationId);
    if (result.followed.run) this.announce(result.followed.run);
    // A notice its follow-up appended (a chain budget or the others' daily budget spent): the group is told after the
    // run's end.
    this.tell(result.followed);
  }

  /** `finish`'s transaction: what to announce once it has committed, or null for a run that no longer exists. */
  private record(run: RunTicket, end: RunEnd, usage: Usage | null, fallback: Estimated, now: Date) {
    const { db, config } = this.deps;
    return db.tx(async (t): Promise<Recorded | null> => {
      const agent = await lockAgent(t, run.agentId, run.conversationId);
      const state = await t.query<RunState>(`select ${RUN_STATE} from agent_runs where id = $1 for update`, [run.id]);
      if (state.rows[0]?.status !== "running") {
        const current = await t.query<RunRow>(`select ${RUN_COLUMNS} from agent_runs r where r.id = $1`, [run.id]);
        if (!current.rows[0]) return null;
        const ended: Announced = { ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(current.rows[0]) };
        return { ended, followed: followUpOf(null), interrupted: false, reply: null };
      }
      const posted = await t.query<{ seq: string }>("select seq::text from messages where conversation_id = $1 and sender_id = $2 and client_txn = $3", [
        run.conversationId,
        run.agentId,
        run.id,
      ]);
      // A refused post of a run in a group whose Agent is no longer a member there ends `agent_removed` (looked up only
      // for a refusal nothing else explains).
      const refused = posted.rowCount === 0 && state.rows[0].interrupted === null && end.status === "cancelled" && end.error === undefined;
      const removed = refused && run.conversationId !== agent.conversationId && !(await currentMembership(t, run.conversationId, agent.id));
      const final = recorded(end, { posted: posted.rowCount !== 0, interrupted: state.rows[0].interrupted, agent, removed });
      const ours = final.status === "failed" && final.error === "busy";
      await settle(t, config, run.id, usage, fallback, final.status, now, { forgiveAll: ours, log: this.deps.log });
      const error = final.status === "failed" || final.status === "cancelled" ? (final.error ?? null) : null;
      const resetsAt = final.status === "failed" && final.resetsAt !== undefined ? final.resetsAt : null;
      const updated = await t.query<RunRow>(
        `update agent_runs as r set status = $2, error = $3, resets_at = $4, finished_at = now(),
                pending_seq = case when $5::boolean then null else r.pending_seq end
          where r.id = $1 returning ${RUN_COLUMNS}`,
        [run.id, final.status, error, resetsAt, droppedOnEnd(final)],
      );
      const ended: Announced = { ownerId: run.ownerId, conversationId: run.conversationId, run: toWireRun(updated.rows[0]!) };
      const next = followUpSeq(state.rows[0], agent, final);
      return {
        ended,
        followed: next === null ? followUpOf(null) : await followUp(t, agent, run.conversationId, Number(state.rows[0].covers_seq ?? 0), next, config),
        interrupted: state.rows[0].interrupted !== null,
        reply: posted.rows[0] ? Number(posted.rows[0].seq) : null,
      };
    });
  }

  /** `AgentPort.release`: the worker's run, ended as recovery ends one (`releaseRun`). */
  async release(run: RunTicket): Promise<void> {
    await this.releaseRun(run.id);
  }

  /**
   * Ends run `runId` (a reply, or a persona draft) that will not be finished where it was begun — this process is
   * closing, or nobody is working on it — exactly as recovery at start-up ends one (`recoverRun`, in a transaction of
   * its own under the locks `finish` takes, on the run's own conversation), then tells its owner (and a follow-up queued
   * by the one rule wakes the worker), publishes the notices its follow-up appended (pushing the Agent to its owner when
   * its others' daily budget refused the follow-up), and forgets its flags; a run whose
   * reply had been posted pushes that reply once more to its owner, first (`Hub.pushChargedReply`, as `finish` does).
   * False when it was no longer running. Rejects, changing nothing, when it cannot be written.
   */
  async releaseRun(runId: string): Promise<boolean> {
    const { db, config, log } = this.deps;
    let recovered: Recovered | null;
    try {
      recovered = await db.tx((t) => recoverRun(t, config, runId, log));
    } finally {
      this.flags.delete(runId);
    }
    if (recovered === null) return false;
    const { charged } = recovered;
    if (charged !== null) this.deps.realtime.pushChargedReply(charged.conversationId, charged.ownerId, charged.seq);
    for (const a of recovered.runs) this.announce(a);
    this.tell(recovered.told);
    return true;
  }
}

/** What `finish`'s transaction leaves to do once it has committed. */
interface Recorded {
  ended: Announced;
  /** Its follow-up (runs.ts `followUp`), and what deciding it told: notices to publish, Agents to push their owners. */
  followed: FollowUp;
  interrupted: boolean;
  /** The seq of the reply the run posted, to push again to its owner now that it is charged; null when none. */
  reply: number | null;
}

/**
 * What `recoverRun` leaves to do once it has committed: runs to announce, what its follow-up told (notices to publish,
 * the Agent to push to its owner when its others' daily budget refused the follow-up), a charged reply to push.
 */
interface Recovered {
  runs: Announced[];
  told: Told;
  /** The reply the run had posted, now charged (`Hub.pushChargedReply`); null when it posted none. */
  charged: { conversationId: string; ownerId: string; seq: number } | null;
}

export function createAgentPort(deps: AgentPortDeps): DbAgentPort {
  return new DbAgentPort(deps);
}

/**
 * Recovery at start-up, before the worker starts (README "Agents and runs"; spec 6.4, 6.5): every run the previous
 * process left `running` — its call, if it had one, died with it — is ended without a model call, each in a
 * transaction of its own under the locks `finish` takes (the run's own conversation row and the Agent's `agents` row,
 * then the run's, then the account's; a persona draft has no Agent: its run row, then the account). A draft has no
 * message either, so it always ends as the last case:
 * - its reply had been posted in its conversation (the stop fell between post and finish): `done`, or `stopped` when
 *   the message says so;
 * - else, its Agent's pause, delete or leaving the run's group had interrupted it: `cancelled` with that reason;
 * - else `failed`, `provider_unavailable`, retryable.
 * In the same transaction its hold is released by a settlement that costs nothing (whatever the upstream reported died
 * with the process: no tokens, all forgiven) — unless it already has its usage record: it is never settled twice. A
 * posted or cancelled run is followed up by the one rule (`followUpSeq`: queued, for the worker about to start); a
 * failed one is not, so nothing is called again on its own (spec 6.5) and a retry answers everything. Queued runs are
 * left as they are. Nothing is pushed (no socket can be open yet): a client learns the state from `GET …/run`. A run
 * that cannot be recovered is logged and left for the stale-run sweep or the next start. Returns how many were
 * recovered. The same ending, while the service runs, is `DbAgentPort.releaseRun` (one transaction of `recoverRun`).
 */
export async function recoverRuns(db: Db, config: Config, log: Pick<FastifyBaseLogger, "error" | "warn">): Promise<number> {
  const { rows } = await db.query<{ id: string }>("select id from agent_runs where status = 'running' order by started_at, id");
  let recovered = 0;
  for (const run of rows) {
    try {
      // Nothing is announced: no socket can be open yet, and the worker starts after this.
      if ((await db.tx((t) => recoverRun(t, config, run.id, log))) !== null) recovered++;
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: could not be recovered at start-up; it stays running until the stale-run sweep or the next start releases it");
    }
  }
  return recovered;
}

/**
 * One run of `recoverRuns` (and of `sweepStaleRuns`, `releaseRun`): null when it was no longer running (or does not
 * exist), else what to tell its owner — the run as it ended and its follow-up (queued, or in a group over the owner's
 * replies a minute the reusable `rate_limited` run), if any, both in the run's own conversation (a draft has no
 * conversation: nothing) — and the notices the follow-up appended there. The run's Agent and conversation are read from
 * its row first (they never change), so that the locks are taken in their order: that conversation's row and the
 * `agents` row, then the run's, then (`settle`, the follow-up) the owner's `accounts` row.
 */
async function recoverRun(t: Tx, config: Config, runId: string, log: Pick<FastifyBaseLogger, "warn">): Promise<Recovered | null> {
  const of = (
    await t.query<{ agent_id: string | null; conversation_id: string | null }>("select agent_id, conversation_id from agent_runs where id = $1", [runId])
  ).rows[0];
  if (!of) return null;
  // A reply has its Agent and conversation; a persona draft has neither.
  const reply =
    of.agent_id !== null && of.conversation_id !== null
      ? { agent: await lockAgent(t, of.agent_id, of.conversation_id), conversationId: of.conversation_id }
      : null;
  const state = (await t.query<RunState>(`select ${RUN_STATE} from agent_runs where id = $1 for update`, [runId])).rows[0];
  if (state?.status !== "running") return null;
  const posted =
    reply === null
      ? null
      : (
          await t.query<{ stopped: boolean | null; seq: string }>(
            "select (body ->> 'stopped') = 'true' as stopped, seq::text from messages where conversation_id = $1 and sender_id = $2 and client_txn = $3",
            [reply.conversationId, reply.agent.id, runId],
          )
        ).rows[0];
  const end: RunEnd = posted
    ? { status: posted.stopped === true ? "stopped" : "done" }
    : state.interrupted
      ? { status: "cancelled", error: state.interrupted }
      : UNAVAILABLE;
  // A run settled already had its hold released with its record.
  const settled = (await t.query("select 1 from usage_records where run_id = $1", [runId])).rowCount !== 0;
  if (!settled) await settle(t, config, runId, null, NOTHING, end.status, new Date(), { forgiveAll: true, log });
  const error = end.status === "failed" || end.status === "cancelled" ? (end.error ?? null) : null;
  const updated = await t.query<RunRow>(
    `update agent_runs as r set status = $2, error = $3, finished_at = now(),
            pending_seq = case when $4::boolean then null else r.pending_seq end
      where r.id = $1 returning ${RUN_COLUMNS}`,
    [runId, end.status, error, droppedOnEnd(end)],
  );
  if (reply === null) return { runs: [], told: noneTold(), charged: null };
  const { agent, conversationId } = reply;
  const ended: Announced = { ownerId: agent.ownerId, conversationId, run: toWireRun(updated.rows[0]!) };
  const next = end.status !== "failed" ? followUpSeq(state, agent, end) : null;
  const { run: followed, ...told } = next === null ? followUpOf(null) : await followUp(t, agent, conversationId, Number(state.covers_seq ?? 0), next, config);
  return {
    runs: followed ? [ended, followed] : [ended],
    told,
    charged: posted ? { conversationId, ownerId: agent.ownerId, seq: Number(posted.seq) } : null,
  };
}

/**
 * How long a run must have been `running` before the stale-run sweep may release it: twice the longer of a call's time
 * limit (`AGENT_RUN_TIMEOUT_MS`) and a reply's with tools (`TOOLS.runTimeoutMs`) — the reading of its attachments, then
 * its call or its rounds — and a minute for posting and recording. With the defaults 2 × max(120 s, 300 s) + 60 s: 11
 * minutes.
 */
export const staleAfterMs = (config: { agentRunTimeoutMs: number; tools: Pick<Config["tools"], "runTimeoutMs"> }): number =>
  2 * Math.max(config.agentRunTimeoutMs, config.tools.runTimeoutMs) + 60_000;

/**
 * The stale-run sweep (README "Agents and runs", Recovery): every run — reply or draft — that is `running`, has been
 * since longer than `staleAfterMs`, and is not one this process is working on (`held`: its worker's runs and its drafts
 * in flight) is released exactly as start-up recovery releases one (`port.releaseRun`: `recoverRun`, each in a
 * transaction of its own under the same locks, on the run's own conversation; its owner is told, a follow-up wakes the
 * worker, and its flags are forgotten). Such a run's process died mid-call while another instance kept running (a
 * deploy where two overlap), its stop could not write its end, or its `finish` failed. Every run is bounded well within
 * `staleAfterMs`, so one that is still being worked on elsewhere is past its time: `post` then refuses it
 * (`RunNotRunning`) and nothing is recorded twice. A run that cannot be released is logged and tried again by the next
 * sweep. Returns how many were released.
 */
export async function sweepStaleRuns(
  port: Pick<DbAgentPort, "releaseRun">,
  db: Db,
  config: Config,
  log: Pick<FastifyBaseLogger, "error" | "warn">,
  held: (runId: string) => boolean,
): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `select id from agent_runs
      where status = 'running' and started_at < now() - ($1::bigint * interval '1 millisecond')
      order by started_at, id`,
    [staleAfterMs(config)],
  );
  let released = 0;
  for (const run of rows) {
    if (held(run.id)) continue;
    try {
      if (!(await port.releaseRun(run.id))) continue;
      released++;
      log.warn({ runId: run.id }, "agent run: released by the stale-run sweep (left running by a process that is gone)");
    } catch (err) {
      log.error({ err, runId: run.id }, "agent run: the stale-run sweep could not release it; the next sweep tries again");
    }
  }
  return released;
}

/**
 * Runs `sweep` once after `initialDelayMs` (default a minute), then every `intervalMs` (default a minute); never two at
 * once. `stop` cancels the timers and waits for a sweep under way.
 */
export function startStaleRunSweep(
  sweep: () => Promise<unknown>,
  log: Pick<FastifyBaseLogger, "error">,
  { initialDelayMs = 60_000, intervalMs = 60_000 }: { initialDelayMs?: number; intervalMs?: number } = {},
): { stop(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let every: NodeJS.Timeout | undefined;
  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = sweep()
      .then(
        () => undefined,
        (err: unknown) => log.error({ err }, "the stale-run sweep failed; it runs again shortly"),
      )
      .finally(() => {
        inFlight = undefined;
      });
  };
  const first = setTimeout(() => {
    tick();
    if (stopped) return;
    every = setInterval(tick, intervalMs);
    every.unref();
  }, initialDelayMs);
  first.unref();
  return {
    async stop() {
      stopped = true;
      clearTimeout(first);
      if (every) clearInterval(every);
      await inFlight;
    },
  };
}
