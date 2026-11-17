import { ME } from "../data/identities.js";

export const entity = (state, id) => state.people[id] || state.agents[id] || null;
export const isAgent = (state, id) => Boolean(state.agents[id]);
export const ownerOf = (state, id) => (state.agents[id] ? state.agents[id].ownerId : id);
export const nameOf = (state, id) => entity(state, id)?.name || "未知";
// A message's sender (or a quote's) whom nobody has named here: they left before this client saw them.
export const senderName = (state, id) => entity(state, id)?.name || "已退出的成员";
export const TYPE_LABEL = { human: "私聊", agent: "私聊", group: "群聊" };

export function otherMember(conv) {
  return conv.members.find((id) => id !== ME);
}

export function convTitle(state, conv) {
  if (conv.title) return conv.title;
  return nameOf(state, otherMember(conv));
}

export function convSubtitle(state, conv) {
  if (conv.type === "agent") return "你的 Agent · 专属会话";
  return conv.type === "group" ? `${conv.members.length} 位真人` : "真人私聊";
}

/** A deleted Agent's conversation: read only, said in the frozen-conversation style. */
export const AGENT_DELETED_TEXT = "这个 Agent 已删除，聊天记录仍可查看";

/** Whether the Agent of an Agent conversation is deleted (by its record, the conversation's flags or the service's hold). */
export const agentDeleted = (state, conv) =>
  conv.type === "agent" && Boolean(conv.hold?.kind === "agentDeleted" || conv.agent?.deleted || state.agents[conv.agentId]?.deleted);

// null when publishing is allowed, otherwise the user-facing reason (the service's verdict, see viewmodel.js `hold`).
// A deleted Agent's conversation reads as such as soon as anything here knows it (its record may arrive first).
export function publishBlock(state, conv) {
  if (agentDeleted(state, conv)) return { kind: "agentDeleted", reason: "agent_deleted", text: AGENT_DELETED_TEXT, pending: [], canRestore: false };
  return conv.hold ?? null;
}

export function lastPreview(state, conv) {
  const last = [...conv.messages].reverse().find((x) => x.kind !== "system") || conv.messages[conv.messages.length - 1];
  if (!last) return "暂无消息";
  let body = last.text;
  if (last.kind === "image") body = "[图片]";
  if (last.kind === "file") body = "[文件]";
  const group = conv.type === "group";
  if (group && last.from === ME) return `你：${body}`;
  if (group && last.from) return `${senderName(state, last.from)}：${body}`;
  return body;
}

export function unreadTotal(state) {
  return state.order.reduce((n, id) => n + (state.convs[id]?.unread || 0), 0);
}
