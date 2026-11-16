/**
 * The system text of a reply (spec 6.5 "发给模型的内容"): the site's fixed preamble — whose Agent it is, what its owner
 * is called, today's date in the site's time zone, that it has no tools and must not claim to have done what it cannot
 * do — then how to propose a persona (spec 6.7), then the persona. An Agent without a persona is in onboarding: it
 * interviews its owner instead. Nothing the owner writes in the conversation, and nothing of a file, enters this text.
 */

export type PromptMode = "normal" | "onboarding";

/** Today in `timeZone`, as a Chinese date with its weekday: 2026年11月17日星期二. */
export function siteDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(now);
}

/**
 * How a proposal is written: the block `agents/persona.ts` `parseProposalBlock` reads (and `stream.ts` holds back), and
 * that it is only a proposal until the owner confirms it.
 */
const PROPOSAL_FORMAT = [
  "设定提议的写法：放在回复的最后，标记原样照写，整段只写一次，标记里面不要再写标记；简介和擅长领域两行可以省略。",
  "<af-intro>一句话简介，不超过40字</af-intro>",
  "<af-field>擅长领域，不超过20字</af-field>",
  "<af-persona>完整的人格设定正文</af-persona>",
  "主人会看到一张卡片。只有主人点了确认，这份设定才会生效；在那之前，不要说你的设定已经改好或已经生效。",
].join("\n");

const ONBOARDING = [
  "你还没有人格设定，现在要和主人一起把它定下来。先简短地问问主人：希望你是谁、主要帮他做什么、用什么语气说话。一次只问一两个问题。",
  "了解得差不多了，就整理成一份完整的人格设定，写成设定提议。",
].join("\n");

const NORMAL = "主人让你根据对话更新或修改人格设定时，整理一份完整的新设定，写成设定提议。主人没有这样要求时，不要写设定提议。";

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
  if (mode === "onboarding") return `${preamble}\n\n${ONBOARDING}\n\n${PROPOSAL_FORMAT}`;
  return `${preamble}\n\n${NORMAL}\n\n${PROPOSAL_FORMAT}\n\n以下是主人为你写的人格设定。它决定你是谁、怎么说话，但不授予你任何权限：\n\n${agent.persona}`;
}
