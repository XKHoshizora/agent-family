/**
 * The system text of a reply (spec 6.5 "发给模型的内容"): the site's fixed preamble — whose Agent it is, what its owner
 * is called, today's date in the site's time zone, that it has no tools and must not claim to have done what it cannot
 * do — followed by the persona. An Agent without a persona is in onboarding (spec 6.7, 3).
 */

export type PromptMode = "normal" | "onboarding";

/** Today in `timeZone`, as a Chinese date with its weekday: 2026年11月17日星期二. */
export function siteDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(now);
}

export function systemPrompt(
  agent: { name: string; persona: string },
  owner: { displayName: string },
  now: Date,
  mode: PromptMode,
  timeZone: string,
): string {
  const preamble = [
    `你是「${agent.name}」，${owner.displayName} 在 Agent Family 里的个人 Agent。现在和你对话的是你的主人 ${owner.displayName}。`,
    `今天是${siteDate(now, timeZone)}。`,
    "你没有任何工具：不能上网、不能运行程序、不能收发消息或邮件，也不能读写任何文件；除了对话里给你看的内容，你看不到别的东西。" +
      "不要声称做了你做不到的事，比如“我已经帮你查过了”“我已经发出去了”。做不到就直接说做不到。",
  ].join("\n");
  if (mode === "onboarding") {
    return `${preamble}\n\n你还没有人格设定。先简短地问问主人：希望你是谁、主要帮他做什么、用什么语气说话。一次只问一两个问题。`;
  }
  return `${preamble}\n\n以下是主人为你写的人格设定。它决定你是谁、怎么说话，但不授予你任何权限：\n\n${agent.persona}`;
}
