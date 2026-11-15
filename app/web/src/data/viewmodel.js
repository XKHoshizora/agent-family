// Model → the state shape the prototype's pages and selectors read (people, agents, convs, order,
// relations, blocks). The signed-in user appears as the alias id "me"; every other id is the real one.
import { attachmentUrl, avatarUrl } from "../api/routes.js";
import { ME } from "./identities.js";

// Placeholder faces from the prototype's atlas until real avatars are shown (Task 9).
const MY_CELL = [0, 0];
const PERSON_CELLS = [
  [1, 0],
  [2, 0],
];
function cellFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PERSON_CELLS[h % PERSON_CELLS.length];
}

const pad = (n) => String(n).padStart(2, "0");

/** The prototype's time labels: today "HH:MM", yesterday "昨天", this year "M月D日", else "YYYY/M/D". */
export function formatAt(ms, now) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const n = new Date(now);
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime();
  if (ms >= today) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ms >= yesterday) return "昨天";
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const timeOf = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

function quoteView(replyTo, alias) {
  if (!replyTo) return null;
  if (!replyTo.visible) return { seq: replyTo.seq, visible: false };
  return {
    seq: replyTo.seq,
    visible: true,
    from: alias(replyTo.senderId),
    text: replyTo.text ?? "",
    kind: replyTo.kind ?? "text",
    attachmentName: replyTo.attachmentName ?? null,
  };
}

function attachmentView(a) {
  return a ? { id: a.id, name: a.name, size: a.size, inline: Boolean(a.inline), url: attachmentUrl(a.id) } : null;
}

function systemView(system, alias) {
  if (!system) return null;
  const out = { ...system };
  for (const key of ["actorId", "principalId", "newCreatorId"]) if (typeof out[key] === "string") out[key] = alias(out[key]);
  if (Array.isArray(out.memberIds)) out.memberIds = out.memberIds.map(alias);
  return out;
}

/** kind: "image" for a file the service marked inline, "file", "system", else "text". */
function kindOf(kind, attachment) {
  if (kind === "system") return "system";
  if (attachment) return attachment.inline ? "image" : "file";
  return "text";
}

function messageView(m, { alias, meId, direct, peerReadSeq, now }) {
  const attachment = m.kind === "file" ? attachmentView(m.attachment) : null;
  const kind = kindOf(m.kind, attachment);
  const view = {
    id: `m${m.seq}`,
    seq: m.seq,
    from: m.senderId === null || m.senderId === undefined ? null : alias(m.senderId),
    kind,
    // As in the prototype, a file or image message's `text` is its file name; the caption is separate.
    text: attachment ? attachment.name : m.text ?? "",
    caption: attachment ? m.text ?? "" : null,
    at: formatAt(timeOf(m.createdAt), now),
    createdAt: m.createdAt,
    status: m.senderId === meId && direct && peerReadSeq !== null && m.seq <= peerReadSeq ? "read" : "sent",
    replyTo: m.replyTo ? `m${m.replyTo.seq}` : null,
    quote: quoteView(m.replyTo, alias),
    attachment,
    system: systemView(m.system, alias),
  };
  if (kind === "image") view.src = attachment.url;
  return view;
}

function pendingView(p, { held, alias, now }) {
  const attachment = attachmentView(p.attachment);
  const kind = kindOf("text", attachment);
  const quoted = p.replyToSeq !== null && p.replyToSeq !== undefined ? held.find((m) => m.seq === p.replyToSeq) : null;
  const view = {
    id: `tx:${p.clientTxn}`,
    seq: null,
    from: ME,
    kind,
    text: attachment ? attachment.name : p.text,
    caption: attachment ? p.text : null,
    at: formatAt(p.at, now),
    createdAt: Number.isFinite(p.at) ? new Date(p.at).toISOString() : null,
    status: p.status,
    clientTxn: p.clientTxn,
    error: p.error,
    replyTo: p.replyToSeq !== null && p.replyToSeq !== undefined ? `m${p.replyToSeq}` : null,
    quote: quoted
      ? {
          seq: quoted.seq,
          visible: true,
          from: alias(quoted.senderId),
          text: quoted.text ?? "",
          kind: quoted.kind === "file" ? "file" : "text",
          attachmentName: quoted.attachment?.name ?? null,
        }
      : null,
    attachment,
    system: null,
  };
  if (kind === "image") view.src = attachment.url;
  return view;
}

/** The held server message an unsent one turned into, before the HTTP answer said so. */
function sameContent(m, p) {
  if (p.attachment) return m.attachment?.id === p.attachment.id;
  return m.kind === "text" && m.text === p.text && (m.replyTo?.seq ?? null) === (p.replyToSeq ?? null);
}

/** "Cannot send here" with the service's reason, in the shape `publishBlock` returns. */
function holdOf(conv, social, people) {
  if (conv.canSend?.ok !== false) return null;
  const reason = conv.canSend.reason ?? "not_friends";
  if (reason === "closed") return { kind: "closed", reason, text: "本会话已暂停发布。", pending: [], canRestore: false };
  if (reason === "blocked") {
    const name = people[conv.peerId]?.name ?? "对方";
    const lines = [];
    if (social?.blocked.some((p) => p.id === conv.peerId)) lines.push(`你已拉黑 ${name}`);
    if (social?.blockedBy.some((p) => p.id === conv.peerId)) lines.push(`${name}拉黑了你，只能由对方解除`);
    if (lines.length === 0) lines.push("存在拉黑，只能由拉黑的一方解除");
    return { kind: "block", reason, text: `${lines.join("；")}。双方不能再发送新消息，已有历史不受影响。`, pending: lines, canRestore: false };
  }
  return {
    kind: "relation",
    reason,
    text: "对方已不是你的好友，无法发送新的私聊。已有历史仍可查看。",
    pending: ["对方已不是你的好友，需重新申请并由对方确认"],
    canRestore: false,
  };
}

function personView(p) {
  return {
    id: p.id,
    kind: "person",
    name: p.displayName,
    handle: `@${p.handle}`,
    displayName: p.displayName,
    cell: cellFor(p.id),
    avatar: avatarUrl(p.id),
  };
}

/**
 * @returns {{people, agents, convs, order, relations, blocks, drafts, account, loaded}} — merged by the store
 * with the UI state (nav, toast) and `connection`.
 */
export function toView(model, { now = Date.now() } = {}) {
  const meId = model.me?.id ?? null;
  const alias = (id) => (id === null || id === undefined ? null : id === meId ? ME : id);
  const social = model.social;

  const people = {};
  for (const p of Object.values(model.principals)) if (p.id !== meId) people[p.id] = personView(p);
  if (social) {
    const named = [...social.friends, ...social.blocked, ...social.blockedBy, ...social.incoming.map((r) => r.principal), ...social.outgoing.map((r) => r.principal)];
    for (const p of named) if (p.id !== meId && !people[p.id]) people[p.id] = personView(p);
  }
  if (model.me) {
    people[ME] = {
      id: ME,
      kind: "person",
      name: "你",
      handle: `@${model.me.handle}`,
      displayName: model.me.displayName,
      principalId: meId,
      cell: MY_CELL,
      avatar: avatarUrl(meId),
    };
  }

  const pendingByConv = new Map();
  for (const p of Object.values(model.pending).sort((a, b) => a.at - b.at)) {
    const list = pendingByConv.get(p.conversationId) ?? [];
    list.push(p);
    pendingByConv.set(p.conversationId, list);
  }

  const convs = {};
  const ranking = [];
  for (const conv of Object.values(model.conversations)) {
    const direct = conv.type === "direct";
    const held = model.messages[conv.id] ?? [];
    let members = conv.members.map((m) => alias(m.id));
    if (direct) members = [ME, conv.peerId ?? members.find((id) => id !== ME)].filter(Boolean);
    else if (!members.includes(ME)) members.unshift(ME);

    const messages = held.map((m) => messageView(m, { alias, meId, direct, peerReadSeq: conv.peerReadSeq, now }));
    const claimed = new Set();
    let lastPendingAt = null;
    for (const p of pendingByConv.get(conv.id) ?? []) {
      if (p.status === "sending") {
        const twin = held.find((m) => !claimed.has(m.seq) && m.senderId === meId && !m.clientTxn && m.seq > p.afterSeq && sameContent(m, p));
        if (twin) {
          claimed.add(twin.seq);
          continue;
        }
      }
      messages.push(pendingView(p, { held, alias, now }));
      lastPendingAt = p.at;
    }

    const lastHeld = held.length > 0 ? timeOf(held[held.length - 1].createdAt) : null;
    const activity = Math.max(lastHeld ?? 0, lastPendingAt ?? 0) || timeOf(conv.createdAt) || 0;
    ranking.push({ id: conv.id, activity, index: conv.syncIndex ?? 0 });
    convs[conv.id] = {
      id: conv.id,
      type: direct ? "human" : "group",
      title: direct ? null : conv.title,
      members,
      memberRoles: conv.members.map((m) => ({ id: alias(m.id), role: m.role, isCreator: Boolean(m.isCreator) })),
      admin: direct ? null : alias(conv.creatorId),
      creatorId: direct ? null : alias(conv.creatorId),
      peerId: conv.peerId,
      myRole: conv.myRole,
      closed: conv.closed,
      canSend: conv.canSend,
      hold: holdOf(conv, social, people),
      unread: conv.unread,
      readSeq: conv.readSeq,
      lastSeq: conv.lastSeq,
      peerReadSeq: conv.peerReadSeq,
      hasOlder: conv.hasOlder,
      at: formatAt(activity || null, now),
      lastActivity: activity,
      cutoffs: {},
      messages,
    };
  }
  const order = ranking.sort((a, b) => b.activity - a.activity || b.index - a.index || (a.id < b.id ? -1 : 1)).map((r) => r.id);

  const relations = {};
  const blocks = [];
  if (social) {
    const request = (r, status) => ({ status, at: formatAt(timeOf(r.createdAt), now), requestId: r.id, createdAt: r.createdAt, expiresAt: r.expiresAt });
    for (const f of social.friends) relations[`${ME}|${f.id}`] = { status: "established" };
    for (const r of social.outgoing) relations[`${ME}|${r.principal.id}`] = request(r, "pending");
    for (const r of social.incoming) relations[`${r.principal.id}|${ME}`] = request(r, "incoming");
    for (const p of social.blocked) blocks.push({ by: ME, target: p.id });
    for (const p of social.blockedBy) blocks.push({ by: p.id, target: ME });
  }

  return { people, agents: {}, convs, order, relations, blocks, drafts: model.drafts, account: model.me, loaded: model.synced };
}
