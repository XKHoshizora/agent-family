import type { Message, Run } from "../shared/types";
import type { messagingApi } from "@line/bot-sdk";
export function lineMessages(
  messages: Message[],
  run?: Run,
): messagingApi.TextMessage[] {
  const answers = messages.filter((m) => m.role === "assistant");
  if (run?.mode === "free") {
    const complete = answers
      .filter((m) => m.status === "complete" && m.content.trim())
      .slice(-4);
    const closure = messages.findLast(
      (m) => m.discussion?.phase === "fallback",
    );
    if (closure) complete.splice(0, Math.max(0, complete.length - 3));
    return [
      {
        type: "text",
        text: `[自由讨论]\n${run.notice || (run.status === "interrupted" ? "服务重启，讨论已中断。" : "讨论已停止。改善设置后可重新发起。")}\n已发言 ${run.turns || answers.length} 次，模型调用 ${run.callsUsed || 0} 次。以下为最近 ${complete.length} 条完整发言，完整过程请到网页查看。`.slice(
          0,
          4900,
        ),
      },
      ...complete.map((m) => ({
        type: "text" as const,
        text: `${m.discussion?.phase === "summary" ? "最终方案" : `第 ${m.round || 1} 轮 · 第 ${m.discussion?.turn || 1} 次发言`}\n${m.content.slice(0, 4700)}${m.content.length > 4700 ? "\n（完整回答请到网页查看）" : ""}`,
        sender: { name: m.author.slice(0, 20) },
      })),
      ...(closure
        ? [{ type: "text" as const, text: closure.content.slice(0, 4700) }]
        : []),
    ];
  }
  const round = Math.max(1, ...answers.map((m) => m.round || 1));
  const complete = answers.filter(
    (m) =>
      (m.round || 1) === round && m.status === "complete" && m.content.trim(),
  );
  const failed = [
    ...new Set(
      answers
        .filter((m) => m.status !== "complete" || !m.content.trim())
        .map((m) => m.author),
    ),
  ];
  const notes = [
    run?.notice,
    failed.length ? `未完成回答：${failed.join("、")}。` : "",
    run?.status === "cancelled" ? "本次任务已停止。" : "",
    run?.status === "interrupted" ? "服务重启，本次任务已中断。" : "",
  ].filter(Boolean);
  if (!complete.length)
    notes.push(
      `第 ${round} 轮没有完整回答，未用此前轮次替代。请到网页查看记录。`,
    );
  const available = notes.length ? 4 : 5;
  if (complete.length > available) notes.push("其余完整回答请到网页查看。");
  return [
    ...(notes.length
      ? [
          {
            type: "text" as const,
            text: `[Agent Family 提示]\n${notes.join("\n")}`.slice(0, 4900),
          },
        ]
      : []),
    ...complete.slice(0, available).map((m) => ({
      type: "text" as const,
      text: `第 ${round} 轮\n${m.content.slice(0, 4700)}${m.content.length > 4700 ? "\n\n（完整回答请到网页查看）" : ""}`,
      sender: { name: m.author.slice(0, 20) },
    })),
  ];
}
