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
  "下面是一个 AI 助手已经记下的几条笔记和一条新的笔记（都可能用任何语言写）。新的这条和哪一条说的是同一件事（换了说法、换了语言、更简略或更啰嗦都算），记下它不会让助手多知道任何东西？如果它和已有的矛盾、是对它的更新、或者多了已有的没有的信息，选“都不是”。";

const SORT = "sort";
const DUP = "dup";
const NONE = "都不是";
/** Existing notes per question: the choice form is calibrated to about 20 options. */
const CHUNK = 20;
/** A score from here up to `shareAt` is "unsure". */
const UNSURE_FROM = 0.2;

/**
 * One judgement call, counted in `judge_usage`, bounded as the proactive decision is (each channel its `timeoutMs`).
 * Null when it cannot be asked (no judge, the site's day used up) or gave no answer for any reason.
 */
async function ask(deps: SortDeps, state: string, question: Question): Promise<Answer | null> {
  const { db, judge, config, log } = deps;
  if (judge === null || config.judge === null) return null;
  try {
    const day = siteDay(new Date(), config.siteTimezone);
    if (await atDailyLimit(db, day, config.judge.dailyLimit, log)) return null;
    const deadline = AbortSignal.timeout(config.judge.timeoutMs * Math.max(1, config.judge.channels.length));
    let answer: Answer | null = null;
    try {
      answer = (await judge.ask(state, [question], deadline)).get(question.key) ?? null;
    } catch {
      // No answer: the callers fail closed.
    }
    // Counted whatever came of the call; a failure of the count itself never changes the result.
    await countJudgement(db, day).catch((err: unknown) => log.info({ metric: "judge_count_failed", err }, "a judgement could not be counted"));
    return answer;
  } catch (err) {
    // The limit check could not be read: not asked.
    log.info({ metric: "judge_limit_check_failed", err }, "the judgement limit could not be read: the note is not judged");
    return null;
  }
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
  const instructions = kind === "owner" ? OWNER_INSTRUCTIONS : SELF_INSTRUCTIONS;
  const answer = await ask(deps, `笔记：${text}`, { key: SORT, type: "noul", instructions });
  if (answer?.type !== "noul") return { vault: true, unsure: false };
  const { shareAt } = deps.config.memory;
  if (answer.p >= shareAt) return { vault: false, unsure: false };
  return { vault: true, unsure: answer.p >= UNSURE_FROM };
}

/** The id of the existing note that `text` repeats, or null (also whenever it cannot be asked: the note is then added). */
export async function duplicateOf(deps: SortDeps, text: string, existing: ReadonlyArray<{ id: string; text: string }>): Promise<string | null> {
  for (let i = 0; i < existing.length; i += CHUNK) {
    const chunk = existing.slice(i, i + CHUNK);
    const options: Record<string, string> = Object.fromEntries(chunk.map((n) => [n.id, n.text]));
    options[NONE] = NONE;
    const answer = await ask(deps, `新的笔记：${text}`, { key: DUP, type: "choice", instructions: DUPLICATE_INSTRUCTIONS, options });
    // No answer (error, limit, nothing usable): stop here, asking further chunks would only spend more calls.
    if (answer?.type !== "choice") return null;
    for (const note of chunk) {
      if ((answer.probabilities.get(note.id) ?? 0) >= deps.config.memory.sameAt) return note.id;
    }
  }
  return null;
}
