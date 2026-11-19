import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.ts";
import { appendSystem } from "../conversations/system.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import type { Db } from "../db.ts";
import type { Judge } from "../judge/client.ts";
import type { StoredMessage } from "../messages/model.ts";
import type { ModelGateway } from "../models/gateway.ts";
import { lockAgent, readOwnedAgent, type AgentRow } from "../agents/store.ts";
import { applyOps, proposeUnlocks, vaultKey, type StoredOp } from "./apply.ts";
import { memoryCall } from "./call.ts";
import { parseOps, type Op } from "./ops.ts";
import { EXPLICIT, linesOf, reviewInput, type RefNote } from "./review.ts";
import { duplicateOf, sortNote, type SortDeps } from "./sort.ts";
import { getNewNotes, roomOf, type NoteKind } from "./store.ts";

/**
 * The reviewer: when a conversation between an owner and their Agent (or a group the Agent replied in) has been quiet
 * long enough, has had enough replies, was started over, or the owner asked for something to be remembered, one metered
 * model call (`memoryCall`) decides what to remember; its answer becomes safe operations (`parseOps`), is checked for
 * duplicates and sorted for the vault outside any transaction, applied (`applyOps`, one transaction that also moves
 * `reviewed_seq` and writes the owner's notice) and told in a small `memory_changed` notice in the owner's own
 * conversation with the Agent.
 *
 * In memory, in this one process, like the proactive scheduler: it never throws and never rejects (what goes wrong is
 * logged with ids, never a note or an answer), one review per Agent at a time (a second trigger meanwhile waits and runs
 * once after), at most `MAX_REVIEWS_AT_ONCE` overall. Fail closed: a call that fails, times out, has no quota, or is
 * abandoned changes nothing and leaves `reviewed_seq` where it was; an answer that is not understood changes nothing but
 * is reviewed (`reviewed_seq` moves). Timers come from the caller (`now`, `setTimer`), so tests never sleep.
 */

export const MAX_REVIEWS_AT_ONCE = 4;

export type SetTimer = (fn: () => void, ms: number) => { clear(): void };

/** `setTimeout` that never holds the process open. */
export const realTimer: SetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return { clear: () => clearTimeout(timer) };
};

export interface ReviewerDeps {
  db: Db;
  config: Config;
  models: Pick<ModelGateway, "stream">;
  judge: Judge | null;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info" | "debug">;
  /** The memory calls this process is working on, by run id (the stale-run sweep leaves them alone). */
  inFlight: Set<string>;
  /** The service is stopping: a call under way is abandoned. `close()` ends them too. */
  closing?: AbortSignal;
  /** Where the notice is announced (after commit). */
  conversations: Pick<ConversationEvents, "publish">;
  now: () => number;
  setTimer: SetTimer;
}

export interface Reviewer {
  /** After commit: Agent `agentId` posted a reply in `conversationId` (its own, or a group). */
  noted(agentId: string, conversationId: string): void;
  /** After commit: the owner started a new topic in the Agent's own conversation. */
  topicReset(agentId: string, conversationId: string): void;
  /** After commit: a message of `conversationId` was flagged for the Agent (a later batch fills this in). */
  flagged(agentId: string, conversationId: string, kind: "hearsay" | "own"): void;
  /** At start: arms a quiet timer for every pair with a reply after `reviewed_seq`; how many. */
  resume(): Promise<number>;
  /** Cancels every timer and waiting review, and abandons calls under way. */
  close(): void;
  /** Resolves once nothing is being looked at, nothing waits and no review is under way (timers do not count). */
  idle(): Promise<void>;
}

interface Job {
  agentId: string;
  conversationId: string;
}

const keyOf = (agentId: string, conversationId: string): string => `${agentId}|${conversationId}`;

export function createReviewer(deps: ReviewerDeps): Reviewer {
  const { db, config, log } = deps;
  const stop = new AbortController();
  const closing = deps.closing ? AbortSignal.any([deps.closing, stop.signal]) : stop.signal;
  const timers = new Map<string, { clear(): void }>();
  /** Reviews waiting for a place (an Agent already under review, or all places taken), oldest first, one per pair. */
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
      void review(job)
        .catch((err: unknown) => log.error({ err, agentId: job.agentId, conversationId: job.conversationId }, "a memory review failed; nothing was changed"))
        .finally(() => {
          running.delete(job.agentId);
          pump();
          settleIdle();
        });
    }
    settleIdle();
  };

  const enqueue = (job: Job): void => {
    if (closed) return;
    if (!waiting.some((j) => j.agentId === job.agentId && j.conversationId === job.conversationId)) waiting.push(job);
    pump();
  };

  const arm = (job: Job): void => {
    const key = keyOf(job.agentId, job.conversationId);
    timers.get(key)?.clear();
    timers.set(
      key,
      deps.setTimer(() => {
        timers.delete(key);
        enqueue(job);
      }, config.memory.quietMs),
    );
  };

  /** Whether the Agent still keeps notes and can be reviewed for. */
  const keeps = async (agentId: string): Promise<AgentRow | null> => {
    const owner = await db.query<{ owner_id: string }>("select owner_id from principals where id = $1", [agentId]);
    if (!owner.rows[0]) return null;
    const agent = await readOwnedAgent(db, owner.rows[0].owner_id, agentId);
    return agent && agent.memory && !agent.paused && !agent.deleted ? agent : null;
  };

  const track = async (work: () => Promise<void>): Promise<void> => {
    looking++;
    try {
      await work();
    } catch (err) {
      log.error({ err }, "a memory trigger could not be read; it is dropped");
    } finally {
      looking--;
      settleIdle();
    }
  };

  const reviewedSeq = async (agentId: string, conversationId: string): Promise<number> => {
    const { rows } = await db.query<{ s: string }>("select reviewed_seq::text as s from memory_review_state where agent_id = $1 and conversation_id = $2", [agentId, conversationId]);
    return Number(rows[0]?.s ?? 0);
  };

  /** One review of `job`, start to finish. */
  async function review(job: Job): Promise<void> {
    const { agentId, conversationId } = job;
    const agent = await keeps(agentId);
    if (agent === null || closing.aborted) return;
    const after = await reviewedSeq(agentId, conversationId);
    const kinds: ReadonlySet<NoteKind> = new Set<NoteKind>(agent.sharedNotes ? ["owner", "self"] : ["self"]);
    const input = await reviewInput(db, agent, conversationId, after, { kinds, config, now: new Date(deps.now()) });
    if (input === null) return;

    const answer = await memoryCall(
      { db, models: deps.models, config, log, inFlight: deps.inFlight },
      agent.ownerId,
      { system: input.system, user: input.user, maxOutputTokens: config.memory.reviewMaxOutputTokens },
      closing,
    );
    if (answer === null || closing.aborted) return;

    const ops = parseOps(answer, new Set(input.refs.keys()), input.existing);
    const sorted = await sortOps(agent, ops, input.refs);
    const notices = await db.tx(async (t): Promise<StoredMessage[] | null> => {
      // The order every writer uses: the Agent's conversation and its row first, then (applyOps) the account.
      const locked = await lockAgent(t, agentId);
      if (locked.deleted || locked.paused || !locked.memory) return null;
      const ids = { ownerId: locked.ownerId, agentId };
      const written: Array<{ changeId: string; unlock: boolean }> = [];
      if (ops.length > 0) {
        const result = await applyOps(t, { ...ids, sharedNotes: locked.sharedNotes, kinds }, ops, input.refs, {
          conversationId: locked.conversationId,
          originConversationId: conversationId,
          status: locked.memoryAsk ? "pending" : "applied",
          vaults: sorted.vaults,
          duplicates: sorted.duplicates,
          rooms: roomOf(config),
        });
        if (result?.changeId) written.push({ changeId: result.changeId, unlock: false });
        if (result && result.unlocks.length > 0) {
          const targets = result.unlocks.flatMap((ref) => {
            const n = input.refs.get(ref);
            return n ? [{ kind: n.kind, id: n.id }] : [];
          });
          const unlockId = await proposeUnlocks(t, ids, locked.conversationId, targets);
          if (unlockId) written.push({ changeId: unlockId, unlock: true });
        }
      }
      await t.query(
        `insert into memory_review_state (agent_id, conversation_id, reviewed_seq) values ($1, $2, $3)
         on conflict (agent_id, conversation_id) do update set reviewed_seq = greatest(memory_review_state.reviewed_seq, excluded.reviewed_seq)`,
        [agentId, conversationId, input.upToSeq],
      );
      const stored: StoredMessage[] = [];
      for (const w of written) {
        const row = (await t.query<{ ops: StoredOp[]; full: boolean; status: "applied" | "pending" }>(`select ops, "full", status from memory_changes where id = $1`, [w.changeId])).rows[0]!;
        stored.push(
          await appendSystem(t, locked.conversationId, {
            event: "memory_changed",
            actorId: agentId,
            changeId: w.changeId,
            ...linesOf(row.ops),
            pending: row.status === "pending",
            unlock: w.unlock,
            full: row.full,
            status: row.status,
          }),
        );
      }
      return stored;
    });
    if (notices !== null && notices.length > 0) deps.conversations.publish({ messages: notices, conversations: [] }, log);
    log.info({ metric: "memory_review", agentId, conversationId, ops: ops.length, notices: notices?.length ?? 0 }, "a memory review ended");
  }

  /** The duplicate test and the vault sorting for what the ops add or replace, outside any transaction. */
  async function sortOps(agent: AgentRow, ops: Op[], refs: Map<string, RefNote>): Promise<{ vaults: Map<string, { vault: boolean; unsure: boolean }>; duplicates: Set<string> }> {
    const vaults = new Map<string, { vault: boolean; unsure: boolean }>();
    const duplicates = new Set<string>();
    if (ops.every((o) => o.op !== "add" && o.op !== "replace")) return { vaults, duplicates };
    const sortDeps: SortDeps = { db, judge: deps.judge, config, log };
    const setting = await getNewNotes(db, agent.ownerId);
    // Newest first: what a new note most likely repeats.
    const known = (kind: NoteKind) => [...refs.values()].filter((n) => n.kind === kind).reverse();
    for (const op of ops) {
      if (closing.aborted) break;
      if (op.op === "add") {
        if (await duplicateOf(sortDeps, op.text, known(op.kind))) duplicates.add(op.text);
        else vaults.set(vaultKey(op.kind, op.text), await sortNote(sortDeps, op.text, op.kind, setting));
      } else if (op.op === "replace") {
        const target = refs.get(op.ref);
        // A note inside the vault stays inside whatever the new text says: nothing to ask.
        if (target && !target.vault) vaults.set(vaultKey(target.kind, op.text), await sortNote(sortDeps, op.text, target.kind, setting));
      }
    }
    return { vaults, duplicates };
  }

  /** Decides what a reply means for the pair: review at once, or (re)arm its quiet timer. */
  async function considerReply(agentId: string, conversationId: string): Promise<void> {
    const agent = await keeps(agentId);
    if (agent === null || closed) return;
    const after = await reviewedSeq(agentId, conversationId);
    const { rows } = await db.query<{ replies: number; latest: string | null }>(
      `select (select count(*)::int from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' and seq > $3) as replies,
              (select body ->> 'text' from messages where conversation_id = $1 and sender_id = $4 and kind in ('text', 'file') and seq > $3 order by seq desc limit 1) as latest`,
      [conversationId, agentId, after, agent.ownerId],
    );
    const now = (rows[0]?.replies ?? 0) >= config.memory.maxReplies || EXPLICIT.test(rows[0]?.latest ?? "");
    if (now) {
      timers.get(keyOf(agentId, conversationId))?.clear();
      timers.delete(keyOf(agentId, conversationId));
      enqueue({ agentId, conversationId });
    } else {
      arm({ agentId, conversationId });
    }
  }

  return {
    noted(agentId, conversationId) {
      if (closed) return;
      void track(() => considerReply(agentId, conversationId));
    },
    topicReset(agentId, conversationId) {
      if (closed) return;
      timers.get(keyOf(agentId, conversationId))?.clear();
      timers.delete(keyOf(agentId, conversationId));
      enqueue({ agentId, conversationId });
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
            where m.kind = 'text' and m.seq > coalesce(s.reviewed_seq, 0)`,
        );
        for (const r of rows) {
          if (closed) return;
          arm({ agentId: r.agent_id, conversationId: r.conversation_id });
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
