import {
  beginInputAwareTurn,
  pendingInputs,
  markInputsAnswered,
  INPUT_INTERRUPT,
} from "./discussion-inputs";
import { db, getRoom, messageFrom } from "./db";
import { now } from "./config";
import { releaseRunBudget, reserveRunBudget } from "./budget";
import { buildFreeHistory } from "./context";
import {
  discussionSettings,
  nextSpeaker,
  normalizedContribution,
  type TurnDecision,
} from "./discussion";
import { mentionedAgents } from "../shared/execution";
import type { Agent, Room } from "../shared/types";
import { assertLineScope, type LineScope } from "./line-access";
import type { ModelMessage } from "ai";

export type FreeTurnInput = {
  turn: number;
  replyTo?: string;
  participants: Agent[];
  steps: number;
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
  const lastSpoke = new Map<string, number>();
  const quiet = new Set<string>();
  const contributions: string[] = [];
  let next = agents[0],
    replyTo: string | undefined;
  let failures = 0,
    totalFailures = 0,
    repeats = 0,
    turns = 0;
  let reason = "讨论已结束。";
  let seenInput = 0;
  try {
    while (!signal.aborted) {
      const run = db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as any;
      const settings = discussionSettings(JSON.parse(run.discussion));
      if (
        settings.maxRounds !== null &&
        turns >= settings.maxRounds * agents.length
      ) {
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
      const inputs = pendingInputs(runId);
      const newest = inputs.at(-1)?.seq || 0;
      if (newest > seenInput) {
        seenInput = newest;
        quiet.clear();
        contributions.length = 0;
        repeats = 0;
        failures = 0;
      }
      const directed = [...inputs]
        .reverse()
        .find((m) => m.targets.some((t: string) => !m.handled.includes(t)));
      if (directed)
        next =
          agents.find(
            (a) =>
              a.id ===
              directed.targets.find(
                (t: string) => !directed.handled.includes(t),
              ),
          ) || next;
      if (inputs.length) replyTo = (directed || inputs.at(-1)).id;
      const steps = Math.min(
        next.tools && (!scope || scope.shareTools) ? 3 : 1,
        settings.maxCalls - run.calls_used,
      );
      // Release unused steps from the preceding utterance; the start day stays fixed.
      releaseRunBudget(runId);
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
          { turn: turns, replyTo, participants: agents, steps },
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
        failures = 0;
        const decision = result!.decision;
        if (decision?.action === "pass") quiet.add(next.id);
        else quiet.clear();
        const normalized = normalizedContribution(m.content);
        const duplicate =
          normalized.length > 0 && contributions.includes(normalized);
        repeats = duplicate ? repeats + 1 : 0;
        contributions.push(normalized);
        if (contributions.length > 20) contributions.shift();
        replyTo = m.id;
        requested =
          decision?.action === "handoff" ? decision.nextAgentId : undefined;
        if (!decision && /^\s*@/.test(m.content))
          requested = mentionedAgents(
            agents.filter((a) => a.id !== next.id),
            m.content,
          )[0]?.id;
        if (requested === next.id || !agents.some((a) => a.id === requested))
          requested = undefined;
        if (
          !pendingInputs(runId).length &&
          settings.stopWhenQuiet &&
          quiet.size === agents.length
        ) {
          reason = "所有伙伴都表示暂无补充，讨论已结束。";
          break;
        }
        if (
          !pendingInputs(runId).length &&
          repeats >= 3 &&
          (decision?.action !== "pass" || quiet.size === agents.length)
        ) {
          reason = "连续三次发言重复已有内容，讨论已停止。";
          break;
        }
      } catch {
        if (signal.aborted) break;
        if (turnControl.signal.reason === INPUT_INTERRUPT) continue;
        failures++;
        totalFailures++;
        quiet.clear();
        if (
          failures >= 3 &&
          !pendingInputs(runId).some((m) => m.seq > seenInput)
        ) {
          reason = "连续三次回答失败，讨论已停止；请检查模型服务。";
          break;
        }
      } finally {
        turnControl.close();
      }
      next = nextSpeaker(agents, lastSpoke, turns, requested);
    }
    if (signal.aborted) reason = "用户已停止自由讨论。";
    const waiting = pendingInputs(runId).length;
    if (waiting)
      reason += ` 还有 ${waiting} 条补充尚未被回应，已保存在群聊中；轮数和额度未自动增加。`;
    db.prepare(
      "UPDATE runs SET status=?,finished_at=?,notice=?,error=? WHERE id=?",
    ).run(
      signal.aborted
        ? "cancelled"
        : totalFailures === turns && turns > 0
          ? "failed"
          : totalFailures
            ? "partial"
            : "completed",
      now(),
      reason,
      totalFailures ? `${totalFailures} 次发言未完成，其他内容已保留。` : null,
      runId,
    );
  } finally {
    releaseRunBudget(runId);
    notify();
  }
}
