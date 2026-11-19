import type { FastifyBaseLogger } from "fastify";
import { siteDay } from "../accounts/store.ts";
import { atDailyLimit, countJudgement } from "../agents/proactive/decide.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Answer, Judge, Question } from "../judge/client.ts";

/** Mirrors the store's `NoteKind` (a later task merges them). */
type NoteKind = "owner" | "self";

export interface SortDeps {
  db: Db;
  judge: Judge | null;
  config: Pick<Config, "judge" | "memory" | "siteTimezone">;
  log: Pick<FastifyBaseLogger, "info" | "debug">;
}

const OWNER_INSTRUCTIONS =
  "这是一个人的 AI 助手记下的一条关于主人的笔记，可能用任何语言写。这条内容属于日常偏好或习惯（比如饮食口味、作息、称呼、喜欢的风格、常用的工具），即使被主人的朋友、同事、群友知道也完全无妨。凡是涉及健康、钱、工作变动、感情和家庭矛盾、对别人的评价、行踪住址、账号密码、尚未公开的计划，或者拿不准的，都不算。";
const SELF_INSTRUCTIONS =
  "这是一个 AI 助手给自己记的一条笔记，可能用任何语言写。这条内容只是它做事的方式或习惯（比如回答的长短、先说什么、用什么格式、推荐时注意什么），不透露主人的任何私事，即使被主人的朋友、同事、群友看到也完全无妨。凡是提到主人的健康、钱、工作变动、感情和家庭、对别人的评价、行踪住址、账号密码、未公开的计划，或者拿不准的，都不算。";
const DUPLICATE_INSTRUCTIONS =
  "这是一个 AI 助手关于主人的两条笔记：一条已有的，一条新的。两条可能用不同的语言写。新的这条和已有的那条说的是同一件事（换了说法、换了语言、更简略或更啰嗦都算），记下新的不会让助手多知道任何东西。如果新的这条和已有的矛盾、是对它的更新、或者多了已有那条没有的信息，都不算。";

const FAITHFUL_INSTRUCTIONS =
  "下面是原来的一条或几条笔记，和由它们改写、合并或拆分成的一条或几条新笔记。新的这些说的全都是原来的笔记里已经有的事，没有多出任何原来没有的内容、推测或细节；原来的笔记里的事也都还在（只是删掉了括号里“以前……”那样的旧经过不算漏）。都可能是任何语言。";

const FAITHFUL = "faithful";
const SORT = "sort";
/** Existing notes per request: one yes/no question each, in one call. */
const CHUNK = 20;
/** A score from here up to `shareAt` is "unsure". */
const UNSURE_FROM = 0.2;

/**
 * One judgement call with `questions` about `state`, counted in `judge_usage`, bounded as the proactive decision is (each
 * channel its `timeoutMs`). Null when it cannot be asked (no judge, the site's day used up) or gave no answer for any reason;
 * else the answers it did give, by key.
 */
export async function askAll(deps: SortDeps, state: string, questions: readonly Question[]): Promise<Map<string, Answer> | null> {
  const { db, judge, config, log } = deps;
  if (judge === null || config.judge === null) return null;
  try {
    const day = siteDay(new Date(), config.siteTimezone);
    if (await atDailyLimit(db, day, config.judge.dailyLimit, log)) return null;
    const deadline = AbortSignal.timeout(config.judge.timeoutMs * Math.max(1, config.judge.channels.length));
    let answers: Map<string, Answer> | null = null;
    try {
      answers = await judge.ask(state, questions, deadline);
    } catch {
      // No answer: the callers fail closed (or open, as they decide).
    }
    // Counted whatever came of the call; a failure of the count itself never changes the result.
    await countJudgement(db, day).catch((err: unknown) => log.info({ metric: "judge_count_failed", err }, "a judgement could not be counted"));
    return answers;
  } catch (err) {
    // The limit check could not be read: not asked.
    log.info({ metric: "judge_limit_check_failed", err }, "the judgement limit could not be read: not judged");
    return null;
  }
}

async function ask(deps: SortDeps, state: string, question: Question): Promise<Answer | null> {
  return (await askAll(deps, state, [question]))?.get(question.key) ?? null;
}

/**
 * Whether a new note may live outside the vault. `vault` / `open` settings answer without a call; `auto` asks once.
 * Everything that goes wrong puts the note in the vault.
 */
export async function sortNote(
  deps: SortDeps,
  text: string,
  kind: NoteKind,
  setting: "auto" | "vault" | "open",
): Promise<{ vault: boolean; unsure: boolean }> {
  if (setting === "vault") return { vault: true, unsure: false };
  if (setting === "open") return { vault: false, unsure: false };
  return (await resortNote(deps, text, kind)) ?? { vault: true, unsure: false };
}

/**
 * The same judgement for a note that already exists and is outside the vault (a dream looking at what is new): always asked
 * (the owner's setting for new notes is about new notes, never about these), and null when there is no answer (no judge, the
 * day's limit, an error, nothing usable): the caller leaves the note where it is, where `sortNote` would lock it.
 */
export async function resortNote(deps: SortDeps, text: string, kind: NoteKind): Promise<{ vault: boolean; unsure: boolean } | null> {
  const instructions = kind === "owner" ? OWNER_INSTRUCTIONS : SELF_INSTRUCTIONS;
  const answer = await ask(deps, `笔记：${text}`, { key: SORT, type: "noul", instructions });
  if (answer?.type !== "noul") return null;
  const { shareAt } = deps.config.memory;
  if (answer.p >= shareAt) return { vault: false, unsure: false };
  return { vault: true, unsure: answer.p >= UNSURE_FROM };
}

/** What a dream made out of notes: a split of one note into parts, or a merge or a rewrite into one. */
export type DreamChange = { kind: "split"; source: string; parts: ReadonlyArray<string> } | { kind: "merge" | "rewrite"; sources: ReadonlyArray<string>; result: string };

/**
 * Whether what a dream made holds nothing the notes did not say and keeps what they said (checked by meaning, not by length:
 * parts repeat a subject or a date, and languages differ in length): one question to the site's judgement model, `faithfulAt` or
 * more sure — the same question and the same threshold for a split, a merge and a rewrite. False whenever it cannot be asked or
 * answers nothing usable: the change is dropped then.
 */
export async function addsNothing(deps: SortDeps, change: DreamChange): Promise<boolean> {
  const sources = change.kind === "split" ? [change.source] : change.sources;
  const results = change.kind === "split" ? change.parts : [change.result];
  const answer = await ask(deps, JSON.stringify({ sources, results }), { key: FAITHFUL, type: "noul", instructions: FAITHFUL_INSTRUCTIONS });
  return answer?.type === "noul" && answer.p >= deps.config.memory.faithfulAt;
}

/**
 * The id of the existing note that `text` repeats, or null (also whenever it cannot be asked: the note is then added). For each
 * chunk of up to `CHUNK` existing notes one request with one yes/no question per note (`d0`…), each about the pair; the note with
 * the highest score at or above `sameAt` over all the chunks wins. No answer for a chunk (an error, the limit, nothing usable)
 * makes it null: no judgement is guessed at.
 */
export async function duplicateOf(deps: SortDeps, text: string, existing: ReadonlyArray<{ id: string; text: string }>): Promise<string | null> {
  let best: { id: string; p: number } | null = null;
  for (let i = 0; i < existing.length; i += CHUNK) {
    const chunk = existing.slice(i, i + CHUNK);
    const questions = chunk.map((n, k): Question => ({ key: `d${k}`, type: "noul", instructions: `${DUPLICATE_INSTRUCTIONS}\n已有的笔记：${n.text}` }));
    const answers = await askAll(deps, `新的笔记：${text}`, questions);
    if (answers === null) return null;
    chunk.forEach((n, k) => {
      const answer = answers.get(`d${k}`);
      if (answer?.type === "noul" && answer.p >= deps.config.memory.sameAt && (best === null || answer.p > best.p)) best = { id: n.id, p: answer.p };
    });
  }
  return (best as { id: string } | null)?.id ?? null;
}
