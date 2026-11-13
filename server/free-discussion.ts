import {
  beginInputAwareTurn,
  pendingInputs,
  markInputsAnswered,
  INPUT_INTERRUPT,
} from "./discussion-inputs";
import { db, getRoom, messageFrom } from "./db";
import { now } from "./config";
import { releaseRunBudget, reserveRunBudget, usage } from "./budget";
import { buildFreeHistory } from "./context";
import {
  discussionSettings,
  nextSpeaker,
  type TurnDecision,
} from "./discussion";
import { similarContribution, saveFallback } from "./discussion-quality";
import { mentionedAgents } from "../shared/execution";
import type { Agent, Room } from "../shared/types";
import { assertLineScope, type LineScope } from "./line-access";
import type { ModelMessage } from "ai";

export type FreeTurnInput = {
  turn: number;
  replyTo?: string;
  participants: Agent[];
  steps: number;
  phase?: "discussion" | "review" | "summary";
  reviewState?: "complete" | "missing";
};
type Answer = (
  agent: Agent,
  history: ModelMessage[],
  round: number,
  turn: FreeTurnInput,
  signal: AbortSignal,
) => Promise<{ messageId: string; decision?: TurnDecision } | undefined>;
export async function executeFreeDiscussion(
  runId: string,
  room: Room,
  agents: Agent[],
  signal: AbortSignal,
  actor: string,
  scope: LineScope | undefined,
  answer: Answer,
  notify: () => void,
) {
  const lastSpoke = new Map<string, number>(),
    agentFailures = new Map<string, number>();
  const quiet = new Set<string>(),
    successfulAgents = new Set<string>();
  const contributions: { id: string; content: string }[] = [];
  let next = agents[0],
    replyTo: string | undefined;
  let failures = 0,
    totalFailures = 0,
    repeats = 0,
    turns = 0,
    seenInput = 0,
    successes = 0;
  let reason = "讨论已结束。",
    closing = "",
    summarized = false,
    clarified = false,
    reviewAttempted = false,
    reviewComplete = false;
  let reviewer: string | undefined;
  try {
    while (!signal.aborted) {
      const run = db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as any;
      const settings = discussionSettings(JSON.parse(run.discussion));
      const remainingTurns =
        settings.maxRounds === null
          ? Infinity
          : settings.maxRounds * agents.length - turns;
      if (remainingTurns <= 0) {
        reason = "已达到设置的讨论轮数。";
        break;
      }
      if (run.calls_used >= settings.maxCalls) {
        reason = "已达到本次模型调用上限。";
        break;
      }
      const current = getRoom(room.id);
      if (
        !current ||
        current.archived ||
        agents.some(
          (a) =>
            !current.agents.some(
              (b) =>
                b.id === a.id &&
                b.enabled &&
                b.model === a.model &&
                b.provider === a.provider,
            ),
        )
      ) {
        reason = "参与伙伴或群聊设置已变更，讨论已停止。";
        break;
      }
      if (scope) {
        try {
          assertLineScope(scope, room.id);
        } catch {
          reason = "LINE 共享权限已变更，讨论已停止。";
          break;
        }
      } else {
        const member = db
          .prepare(
            "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
          )
          .get(room.workspaceId, actor) as any;
        if (
          !member ||
          member.role === "viewer" ||
          (current.visibility === "private" && current.createdBy !== actor)
        ) {
          reason = "访问权限已变更，讨论已停止。";
          break;
        }
      }
      const inputs = pendingInputs(runId),
        newest = inputs.at(-1)?.seq || 0;
      if (newest > seenInput) {
        const newInputs = inputs.filter((m) => m.seq > seenInput);
        seenInput = newest;
        quiet.clear();
        contributions.length = 0;
        repeats = 0;
        failures = 0;
        closing = "";
        reviewAttempted = false;
        reviewComplete = false;
        reviewer = undefined;
        for (const m of newInputs)
          for (const id of m.targets) agentFailures.delete(id);
      }
      const directed = [...inputs]
        .reverse()
        .find((m) =>
          m.targets.some(
            (t: string) =>
              !m.handled.includes(t) && (agentFailures.get(t) || 0) < 2,
          ),
        );
      if (directed)
        next =
          agents.find(
            (a) =>
              a.id ===
              directed.targets.find(
                (t: string) =>
                  !directed.handled.includes(t) &&
                  (agentFailures.get(t) || 0) < 2,
              ),
          ) || next;
      const eligible = agents.filter((a) => (agentFailures.get(a.id) || 0) < 2);
      if (!eligible.length) {
        reason = "所有伙伴均多次未完成回答，已停止继续调用。";
        break;
      }
      if (!eligible.some((a) => a.id === next.id))
        next = nextSpeaker(eligible, lastSpoke, turns);
      if (inputs.length) replyTo = (directed || inputs.at(-1)).id;
      releaseRunBudget(runId);
      const u = usage(room.workspaceId, run.created_at.slice(0, 10));
      const available = Math.min(
        settings.maxCalls - run.calls_used,
        u.limit - u.calls - u.reserved,
        scope ? u.lineLimit - u.lineCalls - u.lineReserved : Infinity,
      );
      if (available < 1) {
        reason = "空间或 LINE 剩余额度不足，讨论已停止；已有回答已保留。";
        break;
      }
      const review =
        !reviewAttempted &&
        turns > 0 &&
        eligible.length > 1 &&
        remainingTurns >= 2 &&
        available >= 2 &&
        (!!closing || remainingTurns === 2 || available === 2);
      const summary =
        !review && (!!closing || remainingTurns === 1 || available === 1);
      if (review && !directed) {
        const previous = [...lastSpoke].sort((a, b) => b[1] - a[1])[0]?.[0];
        const peers = eligible.filter((a) => a.id !== previous);
        next =
          peers.find(
            (a) =>
              successfulAgents.has(a.id) && !(agentFailures.get(a.id) || 0),
          ) || nextSpeaker(peers, lastSpoke, turns);
      }
      if (summary && !directed && lastSpoke.size === agents.length)
        next =
          eligible.find(
            (a) =>
              a.id !== reviewer &&
              successfulAgents.has(a.id) &&
              !(agentFailures.get(a.id) || 0),
          ) || next;
      if (summary && !directed && next.id === reviewer)
        next =
          eligible.find((a) => a.id !== reviewer && !lastSpoke.has(a.id)) ||
          eligible.find((a) => a.id !== reviewer) ||
          next;
      const steps =
        summary || review
          ? 1
          : Math.min(
              next.tools && (!scope || scope.shareTools) ? 3 : 1,
              Math.max(
                1,
                available - (eligible.length > 1 && !reviewAttempted ? 2 : 1),
              ),
            );
      try {
        reserveRunBudget(
          runId,
          room.workspaceId,
          steps,
          scope ? "line" : "web",
          run.created_at.slice(0, 10),
        );
      } catch {
        reason = "空间或 LINE 剩余额度不足，讨论已停止；已有回答已保留。";
        break;
      }
      const summaryReason =
        closing ||
        (remainingTurns === 1
          ? "已达到设置的讨论轮数。"
          : "已达到本次调用上限或今日剩余额度。");
      turns++;
      db.prepare("UPDATE runs SET turns=? WHERE id=?").run(turns, runId);
      notify();
      const round = Math.floor((turns - 1) / agents.length) + 1;
      lastSpoke.set(next.id, turns);
      let requested: string | undefined;
      const turnControl = beginInputAwareTurn(runId, signal);
      try {
        const result = await answer(
          next,
          buildFreeHistory(room.id, runId, next.id, scope),
          round,
          {
            turn: turns,
            replyTo,
            participants: agents,
            steps,
            phase: summary ? "summary" : review ? "review" : "discussion",
            ...(summary
              ? ({
                  reviewState: reviewComplete ? "complete" : "missing",
                } as const)
              : {}),
          },
          turnControl.signal,
        );
        const row =
          result &&
          db.prepare("SELECT * FROM messages WHERE id=?").get(result.messageId);
        const m = row ? messageFrom(row) : undefined;
        if (!m || m.status !== "complete" || !m.content.trim())
          throw new Error("incomplete");
        markInputsAnswered(
          inputs.map((m) => m.id),
          next.id,
          m.id,
        );
        successes++;
        failures = 0;
        agentFailures.delete(next.id);
        successfulAgents.add(next.id);
        if (summary) {
          summarized = true;
          reason = `${summaryReason} 已整理讨论结论；${reviewComplete ? "已完成交叉复核，仍需检查未解决事项。" : "未完成交叉复核，结论仅供继续验证。"}`;
          break;
        }
        if (review) {
          reviewAttempted = true;
          reviewComplete = !!m.discussion?.review;
          reviewer = next.id;
          replyTo = m.id;
          closing = `${closing || (remainingTurns === 2 ? "已达到设置的讨论轮数。" : "已达到本次调用上限或今日剩余额度。")} 交叉复核后整理结论。`;
          continue;
        }
        const decision = result!.decision;
        if (decision?.action === "clarify") {
          clarified = true;
          reason = "等待你确认任务方向，收到回复后再继续讨论。";
          break;
        }
        if (decision?.action === "pass") quiet.add(next.id);
        else quiet.clear();
        const duplicate = contributions.find((p) =>
          similarContribution(p.content, m.content),
        );
        repeats = duplicate ? repeats + 1 : 0;
        if (duplicate)
          db.prepare("UPDATE messages SET discussion=? WHERE id=?").run(
            JSON.stringify({ ...m.discussion, similarTo: duplicate.id }),
            m.id,
          );
        contributions.push({ id: m.id, content: m.content });
        if (contributions.length > 20) contributions.shift();
        replyTo = m.id;
        requested =
          decision?.action === "handoff" ? decision.nextAgentId : undefined;
        if (!decision && /^\s*@/.test(m.content))
          requested = mentionedAgents(
            agents.filter((a) => a.id !== next.id),
            m.content,
          )[0]?.id;
        if (requested === next.id || !eligible.some((a) => a.id === requested))
          requested = undefined;
        if (!pendingInputs(runId).length) {
          if (settings.stopWhenQuiet && eligible.every((a) => quiet.has(a.id)))
            closing = "所有伙伴中可继续者都表示暂无补充。";
          if (
            !closing &&
            repeats >= 2 &&
            (decision?.action !== "pass" || quiet.size === eligible.length)
          )
            closing = "连续发言与已有内容高度重复，转入最终整理。";
          if (decision?.action === "finish" && lastSpoke.size === agents.length)
            closing = "伙伴请求结束讨论并整理方案。";
        }
      } catch {
        if (signal.aborted) break;
        if (turnControl.signal.reason === INPUT_INTERRUPT) continue;
        failures++;
        totalFailures++;
        quiet.clear();
        agentFailures.set(next.id, (agentFailures.get(next.id) || 0) + 1);
        const failed = db
          .prepare(
            "SELECT id FROM messages WHERE run_id=? AND agent_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(runId, next.id) as any;
        if (failed) replyTo = failed.id;
        if (failed && (agentFailures.get(next.id) || 0) >= 2) {
          const row = db
            .prepare("SELECT discussion FROM messages WHERE id=?")
            .get(failed.id) as any;
          db.prepare("UPDATE messages SET discussion=? WHERE id=?").run(
            JSON.stringify({ ...JSON.parse(row.discussion), paused: true }),
            failed.id,
          );
        }
        if (summary) {
          reason = `${summaryReason} 最终整理未完成。`;
          break;
        }
        if (review) {
          reviewAttempted = true;
          reviewComplete = false;
          reviewer = next.id;
          closing = "交叉复核未完成，整理已有依据与缺口。";
        }
        if (
          failures >= 3 &&
          !pendingInputs(runId).some((m) => m.seq > seenInput)
        ) {
          if (!successes) {
            reason = "连续三次回答失败，讨论已停止；请检查模型服务。";
            break;
          }
          closing = "连续三次发言未完成，使用已有有效意见整理。";
        }
      } finally {
        turnControl.close();
      }
      next = nextSpeaker(eligible, lastSpoke, turns, requested);
    }
    if (signal.aborted) reason = "用户已停止自由讨论。";
    const waiting = pendingInputs(runId).length;
    if (waiting)
      reason += ` 还有 ${waiting} 条补充尚未被回应，已保存在群聊中；轮数和额度未自动增加。`;
    if (!summarized && !clarified)
      saveFallback(room, runId, reason, scope ? "line" : "web");
    db.prepare(
      "UPDATE runs SET status=?,finished_at=?,notice=?,error=? WHERE id=?",
    ).run(
      signal.aborted
        ? "cancelled"
        : !successes && totalFailures
          ? "failed"
          : totalFailures || (!summarized && !clarified)
            ? "partial"
            : "completed",
      now(),
      reason,
      totalFailures
        ? `${totalFailures} 次发言未完成，已标注供接话与整理时参考。`
        : null,
      runId,
    );
  } finally {
    releaseRunBudget(runId);
    notify();
  }
}
