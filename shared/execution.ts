import type { Agent, Mode } from "./types";

export function mentionedAgents(agents: Agent[], content: string) {
  return agents.filter(
    (a) =>
      a.enabled &&
      new RegExp(
        "@" +
          a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "(?=\\s|$|[，。！？、,.!?：:])",
        "u",
      ).test(content),
  );
}
export function planExecution(
  agents: Agent[],
  content: string,
  mode: Mode,
  targets?: string[],
  allowTools = true,
) {
  const enabled = agents.filter((a) => a.enabled);
  if (targets?.some((t) => !enabled.some((a) => a.id === t)))
    throw new Error("所选伙伴不在当前群聊中。");
  const mentions = mentionedAgents(enabled, content);
  let selected = mentions.length
    ? mentions
    : targets?.length
      ? enabled.filter((a) => targets.includes(a.id))
      : enabled;
  if (!selected.length) throw new Error("请至少启用一位伙伴。");
  if (mode === "single") {
    if (mentions.length > 1)
      throw new Error(
        "一位伙伴回答模式只能点名一位，请减少点名或切换聊天方式。",
      );
    selected = selected.slice(0, 1);
  }
  const effectiveMode =
    mode === "discuss" && selected.length < 2 ? "single" : mode;
  const rounds = effectiveMode === "discuss" ? 2 : 1;
  return {
    agents: selected,
    mode: effectiveMode as Mode,
    notice:
      mode !== effectiveMode ? "本次只选中一位伙伴，已改为单轮回答。" : "",
    minimum: selected.length * rounds,
    maximum:
      selected.reduce((sum, a) => sum + (a.tools && allowTools ? 3 : 1), 0) *
      rounds,
  };
}
