import { ME } from "../data/identities.js";

export const entity = (state, id) => state.people[id] || state.agents[id] || null;
export const isAgent = (state, id) => Boolean(state.agents[id]);
export const ownerOf = (state, id) => (state.agents[id] ? state.agents[id].ownerId : id);
export const nameOf = (state, id) => entity(state, id)?.name || "未知";
// A message's sender (or a quote's) whom nobody has named here: they left before this client saw them.
export const senderName = (state, id) => entity(state, id)?.name || "已退出的成员";
export const TYPE_LABEL = { human: "私聊", group: "群聊" };

export function otherMember(conv) {
  return conv.members.find((id) => id !== ME);
}

export function convTitle(state, conv) {
  if (conv.title) return conv.title;
  return nameOf(state, otherMember(conv));
}

export function convSubtitle(state, conv) {
  return conv.type === "group" ? `${conv.members.length} 位真人` : "真人私聊";
}

// null when publishing is allowed, otherwise the user-facing reason (the service's verdict, see viewmodel.js `hold`).
export function publishBlock(state, conv) {
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
