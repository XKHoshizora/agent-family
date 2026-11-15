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
// Only Agent-only conversations support a round-limited automatic discussion.
export const supportsDiscussion = (conv) => conv.type === "pair" || conv.type === "agentGroup";
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

// Conditions that must all clear before publishing can be restored.
export function checks(state, conv) {
  const out = [];
  if (!audience(state, conv).includes(ME)) out.push("你已不在当前可见范围内，只能查看退出前已获准的历史");
  if (conv.expansion?.status === "pending") out.push(`扩员方案 v${conv.expansion.version} 仍在等待确认`);
  blocksFor(state, conv).forEach((b) => {
    out.push(
      b.by === ME
        ? `你已拉黑 ${nameOf(state, b.target)}`
        : `${nameOf(state, b.by)}拉黑了 ${nameOf(state, b.target)}，只能由对方解除`,
    );
  });
  if (conv.visibility === "down") out.push("必要主人暂时无法查看本会话");
  if (conv.type === "human" || conv.type === "agent") {
    const other = otherMember(conv);
    if (!isMine(state, other) && relation(state, ME, other)?.status !== "established")
      out.push("联系已解除或尚未建立，需重新申请并由对方确认");
  }
  if (conv.type === "observed" && relation(state, conv.members[0], conv.members[1])?.status !== "established")
    out.push("联系已解除或尚未建立，需重新申请并由对方确认");
  return out;
}

// People whose confirmation a recovery plan needs: every speaking human plus
// every owner who can view. Each unique person confirms once.
export function recoveryApprovers(state, conv) {
  return audience(state, conv);
}

// Rounds of the current discussion that were approved but not yet completed.
export function remainingRounds(conv) {
  const d = conv.discussion;
  if (!d || !["running", "paused", "stale"].includes(d.status)) return 0;
  return Math.max(0, d.rounds - d.round + 1);
}

// Recovery plan status for a frozen conversation. `ready` is the only state
// in which publishing may be restored.
export function recoveryState(state, conv) {
  const rec = conv.recovery || null;
  const pending = checks(state, conv);
  const required = recoveryApprovers(state, conv);
  const active = Boolean(rec) && rec.status === "pending";
  const sameRoster = active && rec.memberVersion === conv.version && required.every((id) => id in rec.approvals) && Object.keys(rec.approvals).length === required.length;
  const waiting = active ? required.filter((id) => rec.approvals[id] !== "approved") : required;
  return {
    rec,
    required,
    active,
    current: active && sameRoster,
    waiting,
    ready: active && sameRoster && waiting.length === 0 && pending.length === 0,
  };
}

const HOLD_TEXT = {
  expansion: "扩员期间冻结本群新增消息、附件与讨论。",
  expansionResolved: "扩员方案已结束，本群保持暂停，需检查后手动恢复。",
  joined: "新成员已加入生效，但讨论不会自动恢复。请检查后手动恢复。",
  block: "存在拉黑冲突，本会话新增发布已冻结。",
  blockCleared: "拉黑已解除，但会话不会自动恢复。请检查后手动恢复。",
  visibility: "必要主人暂时无法查看，本会话新增消息、附件与讨论已冻结。",
  membership: "成员已变化，需重新检查后才能恢复发布。",
  relation: "联系已解除，无法发送新的私聊。已有历史仍可查看。",
};

// null when publishing is allowed, otherwise the user-facing reason.
export function publishBlock(state, conv) {
  const pending = checks(state, conv);
  if (!conv.hold && pending.length === 0) return null;
  const kind =
    conv.hold?.kind || (conv.visibility === "down" ? "visibility" : blocksFor(state, conv).length ? "block" : "relation");
  return { kind, text: HOLD_TEXT[kind] || "本会话已暂停发布。", pending, canRestore: pending.length === 0 };
}

export function canManage(state, conv) {
  if (!audience(state, conv).includes(ME)) return false;
  if (conv.type === "mixed" || conv.type === "agentGroup") return conv.admin === ME;
  return true;
}

// Unique humans who must approve an expansion plan.
export function requiredApprovers(state, conv, candidate) {
  return uniq([...humansIn(state, conv), ...viewerOwners(state, conv), ownerOf(state, candidate)]);
}

export function rolesInPlan(state, conv, candidate, personId) {
  const roles = [];
  if (conv.members.includes(personId)) roles.push("发言成员");
  const owned = agentsIn(state, conv).filter((id) => ownerOf(state, id) === personId);
  if (owned.length) roles.push(`${owned.map((id) => nameOf(state, id)).join("、")}的主人`);
  if (candidate === personId) roles.push("新加入真人");
  if (isAgent(state, candidate) && ownerOf(state, candidate) === personId) roles.push("新 Agent 的主人");
  return roles;
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
  const block = publishBlock(state, conv);
  if (conv.expansion?.status === "pending") return "扩员待确认 · 讨论已暂停。";
  if (block && conv.recovery?.status === "pending") return `已暂停发布 · 恢复方案 v${conv.recovery.version} 待确认。`;
  if (block) return "已暂停发布，等待检查。";
  if (conv.discussion?.status === "pendingApproval") return "等待主人确认";
  const last = [...conv.messages].reverse().find((x) => x.kind !== "system") || conv.messages[conv.messages.length - 1];
  if (!last) return "暂无消息";
  let body = last.text;
  if (last.kind === "image") body = "[图片]";
  if (last.kind === "file") body = "[文件]";
  if (last.kind === "task") body = "[任务授权申请]";
  if (last.kind === "result") body = "[任务成果]";
  if (last.kind === "share") body = "[分享确认]";
  if (last.kind === "shared") body = "[分享的摘要]";
  const group = conv.type !== "human" && conv.type !== "agent";
  if (group && last.from === ME) return `你：${body}`;
  if (group && last.from) return `${nameOf(state, last.from)}：${body}`;
  return body;
}

// Device allocation and capability ceiling shared by "may start" and "may continue".
function allocationProblem(state, task) {
  const agent = state.agents[task.agentId];
  const device = state.devices[task.deviceId];
  if (!agent || !device) return { text: "执行 Agent 或设备已不存在" };
  if (device.owner !== agent.ownerId || agent.ownerId !== ME) return { text: `${device.short}不属于该 Agent 的主人，不能使用` };
  if (agent.execMode === "none" || agent.device !== task.deviceId || (agent.execMode === "virtual") !== (device.type === "virtual"))
    return { text: `尚未把${device.short}分配给${agent.name}`, fix: "ability" };
  if (!agent.caps.browser || !agent.caps.folder)
    return { text: "该 Agent 的能力上限未包含「浏览公开网页」与「指定文件夹」", fix: "ability" };
  if (!String(agent.folder || "").trim()) return { text: "该 Agent 的能力上限未指定允许使用的文件夹", fix: "ability" };
  return null;
}

export function taskBlockers(state, task) {
  const agent = state.agents[task.agentId];
  const device = state.devices[task.deviceId];
  const conv = state.convs[task.convId];
  const out = [];
  if (agent.paused) out.push({ text: `${agent.name}已暂停全部会话`, fix: "agent" });
  const alloc = allocationProblem(state, task);
  if (alloc) out.push(alloc);
  if (!device.online) out.push({ text: `${device.short}离线，无法启动` });
  if (device.busy && device.heldBy !== task.id) out.push({ text: `${device.short}正被其他任务使用，需排队` });
  if (!conv || !conv.members.includes(task.agentId)) out.push({ text: "来源会话已不可用" });
  else if (publishBlock(state, conv)) out.push({ text: "当前会话已冻结" });
  return out;
}

// Single gate for every continue / return / finish path of an authorised task.
// null when the Agent may act and publish, otherwise the user-facing reason.
export function taskRunBlock(state, task) {
  const agent = state.agents[task.agentId];
  const device = state.devices[task.deviceId];
  const conv = state.convs[task.convId];
  if (task.grant !== "active") return "本次授权已失效，需要重新申请";
  if (!agent || !device) return "执行 Agent 或设备已不存在";
  if (!conv || !conv.members.includes(task.agentId)) return "来源会话已不可用，成果无处发布";
  if (publishBlock(state, conv)) return "来源会话已冻结，不能继续操作或发布成果";
  if (!device.online) return `${device.short}离线，无法确定操作者`;
  if (agent.paused) return `${agent.name}已暂停全部会话`;
  const alloc = allocationProblem(state, task);
  if (alloc) return `${alloc.text}（设备分配或能力上限已变化）`;
  if (task.folder && agent.folder !== task.folder) return "授权时指定的文件夹已变化，需要重新申请";
  if (device.heldBy !== task.id) return `${device.short}已不由本任务独占`;
  return null;
}

export const TASK_LIVE = ["running", "stopping", "stopped", "ending"];
export const isTaskLive = (task) => Boolean(task) && TASK_LIVE.includes(task.status);
export const isTaskOpen = (task) => isTaskLive(task) || task?.status === "requested";

// Truthful one-line status: a stop or end that the device has not confirmed is
// never shown as stopped, ended or released.
export function taskPhase(task) {
  const lost = task.stopUnconfirmed;
  switch (task.status) {
    case "requested":
      return ["待你确认", "pending"];
    case "running":
      if (task.control === "pendingStop") return lost ? ["接管未确认", "warn"] : ["等待停止确认（接管）", "pending"];
      if (task.control === "human") return ["你控制中", "ok"];
      if (task.control === "returning") return ["交还检查中", "pending"];
      return ["执行中", "ok"];
    case "stopping":
      return lost ? ["停止未确认", "warn"] : ["已请求停止，等待设备确认", "pending"];
    case "ending":
      return lost ? ["结束未确认 · 电脑未释放", "warn"] : ["已请求结束，等待设备确认", "pending"];
    case "stopped":
      return ["已确认停止，等待检查", "warn"];
    case "done":
      return ["已完成", "ok"];
    case "ended":
      return ["已结束", "muted"];
    case "rejected":
      return ["已拒绝", "muted"];
    case "cancelled":
      return ["已取消", "muted"];
    case "expired":
      return ["已过期", "muted"];
    default:
      return [task.status, "muted"];
  }
}

export function activeTaskFor(state, convId) {
  const list = Object.values(state.tasks).filter((t) => t.convId === convId);
  return list[list.length - 1] || null;
}

// Conversations the viewer may publish a chosen summary into: a mixed group
// they speak in, or an Agent group they can view (and interject in) as an owner.
export function canShareInto(state, conv) {
  if (!conv) return false;
  if (conv.type === "mixed") return conv.members.includes(ME);
  if (conv.type === "agentGroup") return viewerOwners(state, conv).includes(ME);
  return false;
}
// Only a private chat between the viewer and one of their own Agents can be a source.
export function isOwnPrivate(state, conv) {
  return Boolean(conv) && conv.type === "agent" && conv.members.includes(ME) && isMine(state, otherMember(conv));
}
export const audienceKey = (state, conv) => [...conv.members, "|", ...audience(state, conv)].join(",");

export const DISCUSSION_BUDGETS = [20, 50, 100];
// Mock cost per Agent turn, in points.
export const TURN_COST = 5;

export function unreadTotal(state) {
  return state.order.reduce((n, id) => n + (state.convs[id]?.unread || 0), 0);
}
