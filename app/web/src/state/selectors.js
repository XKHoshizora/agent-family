import { ME } from "../data/identities.js";

export const entity = (state, id) => state.people[id] || state.agents[id] || null;
export const isAgent = (state, id) => Boolean(state.agents[id]);
export const ownerOf = (state, id) => (state.agents[id] ? state.agents[id].ownerId : id);
export const nameOf = (state, id) => entity(state, id)?.name || "未知";
export const isMine = (state, id) => state.agents[id]?.ownerId === ME;
export const uniq = (list) => [...new Set(list)];

// "observed": a private chat between one Agent and one human who is not its owner.
// The Agent's owner may view and interject, but it is never an Agent-only discussion.
export const TYPE_LABEL = { human: "私聊", agent: "私聊", pair: "一对一", observed: "Agent 私聊", mixed: "混合群", agentGroup: "Agent 群" };
export const isPrivateType = (type) => ["human", "agent", "pair", "observed"].includes(type);
// The viewer is an owner looking in, not a speaking member: messages are owner interjections.
export const isInterject = (conv) => !conv.members.includes(ME);

export function otherMember(conv) {
  return conv.members.find((id) => id !== ME);
}

export function convTitle(state, conv) {
  if (conv.title) return conv.title;
  return nameOf(state, otherMember(conv));
}

export function agentsIn(state, conv) {
  return conv.members.filter((id) => isAgent(state, id));
}
export function humansIn(state, conv) {
  return conv.members.filter((id) => !isAgent(state, id));
}
export function myAgentsIn(state, conv) {
  return conv.members.filter((id) => isMine(state, id));
}
// Owners who may view because one of their Agents takes part.
export function viewerOwners(state, conv) {
  return uniq(agentsIn(state, conv).map((id) => ownerOf(state, id)));
}
// Everybody who can read new content: speakers plus related owners.
export function audience(state, conv) {
  return uniq([...humansIn(state, conv), ...viewerOwners(state, conv)]);
}

export function convSubtitle(state, conv) {
  const agents = agentsIn(state, conv).length;
  const humans = humansIn(state, conv).length;
  if (conv.type === "mixed") return `${humans} 位真人 · ${agents} 个 Agent`;
  if (conv.type === "agentGroup") return `${agents} 个 Agent · ${viewerOwners(state, conv).length} 位主人`;
  if (conv.type === "pair") {
    const owners = viewerOwners(state, conv);
    return owners.length === 1 ? "Agent 一对一 · 同一主人" : "Agent 一对一 · 不同主人";
  }
  if (conv.type === "agent") {
    const other = otherMember(conv);
    return isMine(state, other) ? "你的 Agent · 专属会话" : `Agent · 主人：${nameOf(state, ownerOf(state, other))}`;
  }
  if (conv.type === "observed") {
    const agent = agentsIn(state, conv)[0];
    return `Agent 与真人私聊 · Agent 主人：${nameOf(state, ownerOf(state, agent))}`;
  }
  return "真人私聊";
}

export function visibilityNote(state, conv) {
  if (conv.type === "human") return null;
  if (conv.type === "observed") {
    const agent = agentsIn(state, conv)[0];
    const human = humansIn(state, conv)[0];
    const owner = ownerOf(state, agent);
    return `${nameOf(state, agent)}（Agent）与${nameOf(state, human)}（真人）的私聊；Agent 主人${nameOf(state, owner)}可查看${owner === ME ? "，你的发言以本人插话显示" : ""}。不支持自动讨论`;
  }
  if (conv.type === "agent") {
    const other = otherMember(conv);
    if (isMine(state, other)) return "仅你与此 Agent 可见";
    return `此 Agent 的主人${nameOf(state, ownerOf(state, other))}可查看这段对话`;
  }
  if (conv.type === "mixed") return "本群含 Agent，相关主人可查看对话";
  const owners = viewerOwners(state, conv).map((id) => nameOf(state, id)).join("、");
  return `发言成员为 Agent；可见主人：${owners}。主人插话以真人身份显示`;
}

// Blocks that touch this conversation: target is a member and the blocker
// (or one of the blocker's Agents) is a member too.
export function blocksFor(state, conv) {
  return state.blocks.filter(
    (b) =>
      conv.members.includes(b.target) &&
      conv.members.some((id) => id !== b.target && ownerOf(state, id) === b.by),
  );
}

// Conditions that currently stop publishing.
export function checks(state, conv) {
  const out = [];
  if (!audience(state, conv).includes(ME)) out.push("你已不在当前可见范围内，只能查看退出前已获准的历史");
  blocksFor(state, conv).forEach((b) => {
    out.push(
      b.by === ME
        ? `你已拉黑 ${nameOf(state, b.target)}`
        : `${nameOf(state, b.by)}拉黑了 ${nameOf(state, b.target)}，只能由对方解除`,
    );
  });
  if (conv.type === "human" || conv.type === "agent") {
    const other = otherMember(conv);
    if (!isMine(state, other) && relation(state, ME, other)?.status !== "established")
      out.push("联系已解除或尚未建立，需重新申请并由对方确认");
  }
  if (conv.type === "observed" && relation(state, conv.members[0], conv.members[1])?.status !== "established")
    out.push("联系已解除或尚未建立，需重新申请并由对方确认");
  return out;
}

const HOLD_TEXT = {
  block: "存在拉黑冲突，本会话新增发布已冻结。",
  relation: "联系已解除，无法发送新的私聊。已有历史仍可查看。",
};

// null when publishing is allowed, otherwise the user-facing reason.
export function publishBlock(state, conv) {
  const pending = checks(state, conv);
  if (pending.length === 0) return null;
  const kind = blocksFor(state, conv).length ? "block" : "relation";
  return { kind, text: HOLD_TEXT[kind] || "本会话已暂停发布。", pending, canRestore: pending.length === 0 };
}

export function relKey(subject, target) {
  return `${subject}|${target}`;
}
export function relation(state, subject, target) {
  return state.relations[relKey(subject, target)] || state.relations[relKey(target, subject)] || null;
}

export function myBlock(state, target) {
  return state.blocks.find((b) => b.by === ME && b.target === target);
}

export function lastPreview(state, conv) {
  const last = [...conv.messages].reverse().find((x) => x.kind !== "system") || conv.messages[conv.messages.length - 1];
  if (!last) return "暂无消息";
  let body = last.text;
  if (last.kind === "image") body = "[图片]";
  if (last.kind === "file") body = "[文件]";
  const group = conv.type !== "human" && conv.type !== "agent";
  if (group && last.from === ME) return `你：${body}`;
  if (group && last.from) return `${nameOf(state, last.from)}：${body}`;
  return body;
}

export function unreadTotal(state) {
  return state.order.reduce((n, id) => n + (state.convs[id]?.unread || 0), 0);
}
