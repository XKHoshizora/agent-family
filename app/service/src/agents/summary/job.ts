import { AppError } from "../../errors.ts";
import { weight } from "../../metering/tokens.ts";
import { memoryCall, type MemoryCallDeps, type MemoryCallReport } from "../../memory/call.ts";
import { shown } from "../../memory/review.ts";
import { count } from "../../memory/stats.ts";
import { attachmentLabel } from "../runtime/context.ts";
import { labelName } from "../runtime/prompt.ts";
import { lockAgent, readOwnedAgent } from "../store.ts";
import { cleanSummary, OWNER, SELF, summaryInput, summarySystem, type SummaryLine } from "./prompt.ts";
import { countPlaced, readPlaced, readSummary, summaryBase, writeSummary, type PlacedMessage, type PlacedReader, type Summary } from "./store.ts";

/**
 * One rolling-summary job (README "The rolling summary"; queued after a reply by agents/port-impl.ts `finish`, run by the
 * memory reviewer's scheduler, memory/reviewer.ts, one job per Agent at a time within its cap): the messages of the pair
 * that a reply's context left out are folded, by ONE memory call (memory/call.ts `memoryCall`: its own `agent_runs` row of
 * purpose `memory`, held and settled on the memory allowance the site pays — or, on a model of the owner's own provider,
 * nothing), into the pair's summary, updated in place.
 *
 * Fail closed: a call that could not be made, failed, was abandoned, or answered nothing usable changes nothing; so does an
 * answer that is not shorter than what it would replace (the old summary and the messages it now covers, in weight), and so
 * does one that arrives once the pair has moved on (a new topic, the Agent out of the group, another write). Nothing of any
 * text is logged: counters only (memory/stats.ts).
 */

export interface SummaryJob {
  kind: "summary";
  agentId: string;
  conversationId: string;
  /** The last place (agents/summary/store.ts) the reply's context left out: what is to be covered up to. */
  upTo: number;
}

export interface SummaryContext {
  /** The service is stopping: a call under way is abandoned, and nothing is written. */
  closing: AbortSignal;
  /** The place the pair's last attempt that wrote nothing was to cover up to (in this process); null when none. */
  summaryTried: number | null;
  /** After an attempt: the place it was to cover up to when it wrote nothing, null when it wrote a summary. */
  summaryAttempted(upTo: number | null): void;
}

export type SummaryDeps = MemoryCallDeps;

/** The most messages one job reads; the rest waits for the next job. */
export const SUMMARY_MAX_MESSAGES = 200;

/** Who a message is from, as the call is shown it (prompt.ts `SummaryLine`). */
function lineOf(m: PlacedMessage, reader: PlacedReader, maxWeight: number): SummaryLine {
  const label = m.attachment ? attachmentLabel({ name: m.attachment.name, image: m.attachment.inline === true }) : "";
  const text = shown([label, m.text].filter((s) => s !== "").join(" "), maxWeight);
  if (m.senderId === reader.agentId) return { who: SELF, text };
  if (!reader.group) return { who: OWNER, text };
  const role = m.kind === "agent" ? "Agent" : m.senderId === reader.ownerId ? "主人" : "群成员";
  return { who: labelName(m.name, m.handle), role, text };
}

/**
 * The job: what to read, the call, what to keep. The window is the pair's messages placed after what its summary covers
 * (or, with none, after where the Agent may be shown the conversation from: `summaryBase`) and up to `job.upTo`, at most
 * `SUMMARY_MAX_MESSAGES` of them and at most what a review is shown in weight (`reviewMessages` × `reviewMessageWeight`, each
 * cut at `reviewMessageWeight`), cut between places — so an exchange is never split; the rest waits for the next job. A pair
 * whose last attempt wrote nothing is not asked again until `summaryMinMessages` more messages lie past that attempt.
 */
export async function runSummary(deps: SummaryDeps, job: SummaryJob, ctx: SummaryContext): Promise<void> {
  const { db, config } = deps;
  if (ctx.closing.aborted) return;
  const owner = await db.query<{ owner_id: string }>("select owner_id from principals where id = $1", [job.agentId]);
  const agent = owner.rows[0] ? await readOwnedAgent(db, owner.rows[0].owner_id, job.agentId) : null;
  if (!agent || agent.deleted || agent.paused) return;
  const reader: PlacedReader = { agentId: agent.id, ownerId: agent.ownerId, conversationId: job.conversationId, group: job.conversationId !== agent.conversationId };

  const base = await summaryBase(db, agent.id, job.conversationId);
  if (base === null) return;
  const stored = await readSummary(db, job.conversationId, agent.id);
  // A summary from before where the Agent may be shown the conversation from now (a new topic, a new stay) is no summary.
  const old = stored !== null && stored.fromSeq > base ? stored : null;
  const start = old?.uptoSeq ?? base;
  if (job.upTo <= start) return;
  const tried = ctx.summaryTried;
  if (tried !== null && tried >= start && (await countPlaced(db, reader, tried, job.upTo)) < config.memory.summaryMinMessages) return;

  const { memory } = config;
  const read = await readPlaced(db, reader, start, job.upTo, SUMMARY_MAX_MESSAGES + 1);
  const lines = read.map((m) => lineOf(m, reader, memory.reviewMessageWeight));
  let n = Math.min(read.length, SUMMARY_MAX_MESSAGES);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = weight(lines[i]!.text);
    if (i > 0 && total + w > memory.reviewMessages * memory.reviewMessageWeight) {
      n = i;
      break;
    }
    total += w;
  }
  const cut = n < read.length;
  // Cut between places: when the first message left for later shares its place with the last one taken, that place waits whole.
  if (cut && n > 0 && read[n]!.at === read[n - 1]!.at) {
    const at = read[n - 1]!.at;
    while (n > 0 && read[n - 1]!.at === at) n--;
  }
  if (n === 0) return;
  const upto = cut ? read[n - 1]!.at : job.upTo;
  const taken = lines.slice(0, n).filter((l) => l.text !== "");
  const next: Omit<Summary, "text"> = { fromSeq: old?.fromSeq ?? read[0]!.at, uptoSeq: upto };

  count(db, "summary_run");
  const report: MemoryCallReport = { answered: false };
  const answer = await memoryCall(
    deps,
    agent.ownerId,
    {
      system: summarySystem(reader.group, memory.summaryMaxWeight),
      user: summaryInput(old?.text ?? null, taken),
      maxOutputTokens: Math.max(memory.reviewMaxOutputTokens, 2 * memory.summaryMaxWeight),
    },
    ctx.closing,
    report,
  );
  if (ctx.closing.aborted) return;
  const text = answer === null ? null : cleanSummary(answer, memory.summaryMaxWeight);
  if (text === null) {
    // A refusal for the allowance is counted where it is decided (`memory_refused_allowance`).
    if (!report.refused) count(db, "summary_failed");
    ctx.summaryAttempted(job.upTo);
    return;
  }
  // Shorter than what it replaces — the old summary and the messages it now covers — or not at all.
  if (weight(text) >= weight(old?.text ?? "") + taken.reduce((sum, l) => sum + weight(l.text), 0)) {
    count(db, "summary_not_shorter");
    ctx.summaryAttempted(job.upTo);
    return;
  }

  let written: boolean;
  try {
    written = await db.tx(async (t) => {
      // The conversation's row, then the Agent's (the order a reply's run takes them in): no reply reads a half-written state.
      const locked = await lockAgent(t, agent.id, job.conversationId);
      if (locked.deleted) return false;
      const now = await summaryBase(t, agent.id, job.conversationId);
      if (now === null || next.fromSeq <= now) return false;
      const current = await readSummary(t, job.conversationId, agent.id);
      if (!sameSummary(current, stored)) return false;
      await writeSummary(t, job.conversationId, agent.id, { ...next, text });
      return true;
    });
  } catch (err) {
    if (err instanceof AppError && err.status === 404) written = false;
    else throw err;
  }
  if (!written) {
    count(db, "summary_dropped");
    return;
  }
  count(db, "summary_written");
  ctx.summaryAttempted(null);
}

const sameSummary = (a: Summary | null, b: Summary | null): boolean =>
  a === null || b === null ? a === b : a.fromSeq === b.fromSeq && a.uptoSeq === b.uptoSeq && a.text === b.text;
