import type { Message, Run } from "../shared/types";
import type { messagingApi } from "@line/bot-sdk";
export function lineMessages(
  messages: Message[],
  run?: Run,
): messagingApi.TextMessage[] {
  const answers = messages.filter((m) => m.role === "assistant");
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
    ...complete
      .slice(0, available)
      .map((m) => ({
        type: "text" as const,
        text: `第 ${round} 轮\n${m.content.slice(0, 4700)}${m.content.length > 4700 ? "\n\n（完整回答请到网页查看）" : ""}`,
        sender: { name: m.author.slice(0, 20) },
      })),
  ];
}
