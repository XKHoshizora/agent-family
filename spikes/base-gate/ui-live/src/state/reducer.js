import { ME, makeAgent, DEFAULT_AGENT_CELL } from "../data/identities.js";
import { seedState, makeTask, TASK_STEPS } from "../data/seed.js";
import {
  nameOf,
  ownerOf,
  isMine,
  isAgent,
  publishBlock,
  checks,
  canManage,
  viewerOwners,
  requiredApprovers,
  relation,
  relKey,
  taskBlockers,
  taskRunBlock,
  isTaskLive,
  isTaskOpen,
  activeTaskFor,
  otherMember,
  agentsIn,
  isPrivateType,
  supportsDiscussion,
  isInterject,
  recoveryApprovers,
  recoveryState,
  remainingRounds,
  canShareInto,
  isOwnPrivate,
  audienceKey,
  DISCUSSION_BUDGETS,
  TURN_COST,
} from "./selectors.js";

const REPLIES = {
  travel: [
    "好的。我先按轻松路线整理：上午海边，中午长谷寺，下午咖啡馆。",
    "已记下。信息不确定的地方我会先问你，不会擅自预订或付款。",
    "可以，我把时间再放宽一些，每一段都留出休息。",
  ],
  writer: ["收到，我只处理你交给我的这段文字。", "已润色完成，语气保持自然口语。"],
  xlTravel: ["我来整理交通方案：江之电一日券，镰仓站 9:30 出发。", "返程建议 17:00 前，避开晚高峰。"],
  xlPhoto: ["建议用上午的侧光，背景留出海平线。", "构图上可以让人物站在画面三分之一处。"],
  azDoc: ["我可以核对公开资料中的开放时间与票价。", "已根据公开信息整理要点。"],
};
const DISCUSS = {
  travel: ["我建议路线保持三段：海边、长谷寺、小町通。", "同意，把午餐安排在长谷寺附近。", "我来汇总成一页行程。", "行程已对齐，没有新增问题。"],
  writer: ["我可以把行程写成简短说明。", "文案草稿已按三段结构整理。", "标题建议用「镰仓轻松一日」。", "文字部分已完成。"],
  xlTravel: ["交通上以江之电为主，换乘一次即可。", "各段之间步行都在 15 分钟内。", "返程时间建议 17:00 前。", "交通部分确认无误。"],
  xlPhoto: ["由比滨上午顺光，适合人像。", "长谷寺观景台可以拍海景全景。", "小町通适合抓拍街景。", "拍摄点已标注完成。"],
  azDoc: ["我核对了公开的开放时间。", "票价信息已补充。", "资料来源均为公开页面。", "资料核对完成。"],
};

const pick = (table, id, n) => {
  const list = table[id] || ["好的，我已收到。", "明白，我会按你的说明处理。"];
  return list[n % list.length];
};
const names = (s, ids) => ids.map((id) => nameOf(s, id)).join("、");

function toast(s, text) {
  s.toast = { id: ++s.seq, text };
}

function push(s, convId, msg) {
  const c = s.convs[convId];
  const full = { status: "sent", kind: "text", ...msg, id: `m${++s.seq}`, at: s.now };
  c.messages.push(full);
  c.at = s.now;
  s.order = [convId, ...s.order.filter((x) => x !== convId)];
  const viewing = s.nav.section === "chat" && s.nav.convId === convId;
  if (!viewing && full.from && full.from !== ME) c.unread += 1;
  return full;
}
const note = (s, convId, text) => push(s, convId, { from: null, kind: "system", text });

// A pending recovery plan is only valid for the roster and freeze state it was written for.
function voidRecovery(s, conv, why) {
  if (conv.recovery?.status !== "pending") return;
  conv.recovery.status = "invalid";
  note(s, conv.id, `${why}，恢复方案 v${conv.recovery.version} 及已有确认全部失效，需重新发起。`);
}

function hold(s, conv, kind) {
  voidRecovery(s, conv, "本会话出现新的冻结原因");
  conv.hold = { kind };
  conv.generating = null;
  if (conv.discussion?.status === "running") conv.discussion.status = "paused";
}

// Every roster change: new member version, old share consents and recovery
// confirmations can never become valid again.
function bumpVersion(s, conv) {
  conv.version += 1;
  Object.values(s.shares).forEach((sh) => {
    if (sh.target === conv.id && sh.status === "pending") sh.status = "invalid";
  });
  voidRecovery(s, conv, "成员名单已变化");
}

function release(s, task) {
  const d = s.devices[task.deviceId];
  if (d.heldBy === task.id) {
    d.busy = false;
    d.heldBy = null;
  }
}

function afterSend(s, conv, msg) {
  if (conv.type === "human") {
    conv.readToken = ++s.seq;
    return;
  }
  let targets = [];
  if (conv.type === "agent") {
    const id = otherMember(conv);
    if (s.agents[id].privateReply !== "仅在我点名时回复" || (msg.text || "").includes(`@${nameOf(s, id)}`)) targets = [id];
  }
  if (conv.type === "mixed") targets = agentsIn(s, conv).filter((id) => s.agents[id].groupReply !== "不在群内回复" && (msg.text || "").includes(`@${nameOf(s, id)}`));
  queueReplies(s, conv, targets);
}

function queueReplies(s, conv, targets) {
  const queue = [];
  targets.forEach((id) => {
    if (s.agents[id].paused) note(s, conv.id, `${nameOf(s, id)}已暂停全部会话，不会回复。`);
    else if (conv.myPause && isMine(s, id)) note(s, conv.id, `你已暂停本会话中的${nameOf(s, id)}，不会回复。`);
    else queue.push(id);
  });
  if (queue.length) conv.generating = { queue, token: ++s.seq };
}

function ensureConv(s, a, b) {
  const both = [a, b];
  const found = Object.values(s.convs).find((c) => c.members.length === 2 && both.every((x) => c.members.includes(x)) && isPrivateType(c.type));
  if (found) return found.id;
  const id = `c${++s.seq}`;
  const involvesMe = both.includes(ME);
  const other = both.find((x) => x !== ME);
  const agents = both.filter((x) => isAgent(s, x));
  // Agent + human who is not me: an observed private chat, never an Agent-only pair.
  const type = involvesMe ? (isAgent(s, other) ? "agent" : "human") : agents.length === 2 ? "pair" : "observed";
  const members = involvesMe ? [ME, other] : type === "observed" ? [agents[0], both.find((x) => x !== agents[0])] : both;
  s.convs[id] = {
    id,
    type,
    title: involvesMe ? undefined : `${nameOf(s, members[0])} × ${nameOf(s, members[1])}`,
    members,
    admin: null,
    at: s.now,
    unread: 0,
    hold: null,
    visibility: "ok",
    expansion: null,
    discussion: null,
    recovery: null,
    myPause: false,
    generating: null,
    version: 1,
    cutoffs: {},
    messages: [],
  };
  s.order = [id, ...s.order];
  note(
    s,
    id,
    type === "observed"
      ? `联系已建立：这是 ${nameOf(s, members[0])}（Agent）与 ${nameOf(s, members[1])}（真人）的私聊，Agent 的主人可查看并以本人身份插话。不支持自动讨论，也不授予工具、文件或电脑权限。`
      : "联系已建立。关系确认不会自动开始讨论，也不授予工具、文件或电脑权限。",
  );
  return id;
}

function affectedBy(s, block) {
  return Object.values(s.convs).filter(
    (c) => c.members.includes(block.target) && c.members.some((id) => id !== block.target && ownerOf(s, id) === block.by),
  );
}

function addBlock(s, by, target) {
  if (s.blocks.some((b) => b.by === by && b.target === target)) return;
  const block = { by, target };
  s.blocks.push(block);
  const who = by === ME ? "你" : nameOf(s, by);
  affectedBy(s, block).forEach((c) => {
    hold(s, c, "block");
    note(s, c.id, `${who}拉黑了${nameOf(s, target)}。本会话新增消息、附件与讨论已冻结，已有历史不受影响。`);
  });
}

function removeBlock(s, by, target) {
  const block = s.blocks.find((b) => b.by === by && b.target === target);
  if (!block) return;
  const list = affectedBy(s, block);
  s.blocks = s.blocks.filter((b) => b !== block);
  const who = by === ME ? "你" : nameOf(s, by);
  list.forEach((c) => {
    const rest = checks(s, c);
    if (c.hold?.kind === "block" && rest.length === 0) c.hold = { kind: "blockCleared" };
    note(
      s,
      c.id,
      rest.length
        ? `${who}解除了对${nameOf(s, target)}的拉黑，但仍有其他限制，会话保持冻结。`
        : `${who}解除了对${nameOf(s, target)}的拉黑。会话不会自动恢复：需由当前所有必需的人确认恢复方案后手动恢复。`,
    );
  });
}

function settleExpansion(s, conv) {
  const e = conv.expansion;
  if (!Object.values(e.approvals).every((v) => v === "approved")) return;
  e.status = "approved";
  e.joinedAt = s.now;
  conv.members.push(e.candidate);
  bumpVersion(s, conv);
  conv.cutoffs[e.candidate] = s.now;
  conv.hold = { kind: "joined" };
  if (conv.discussion && conv.discussion.status !== "done") conv.discussion.status = "stale";
  note(
    s,
    conv.id,
    `${nameOf(s, e.candidate)}已于 ${s.now} 加入生效。新成员与新主人仅可查看此后的新消息；旧附件与摘要不会自动开放。本群保持冻结：需由新名单中所有必需的人确认恢复方案（新摘要、目标、剩余轮次）后才能恢复。`,
  );
}

function failExpansion(s, conv, status, text) {
  conv.expansion.status = status;
  conv.hold = { kind: "expansionResolved" };
  note(s, conv.id, `${text}本次方案不生效，原成员关系保留；本群保持暂停，可按原名单发起恢复确认后手动恢复。`);
}

function resetApprovals(s, conv) {
  const e = conv.expansion;
  if (!e || e.status !== "pending") return;
  e.version += 1;
  const next = {};
  requiredApprovers(s, conv, e.candidate).forEach((id) => {
    next[id] = id === e.initiator ? "approved" : "pending";
  });
  e.approvals = next;
  note(s, conv.id, `成员名单已变化，原确认失效。扩员方案更新为 v${e.version}，需重新确认。`);
}

// Restore applies one fully confirmed recovery plan to this conversation and its
// discussion only. Tasks, grants and relations are untouched.
function applyRecovery(s, conv) {
  const rec = conv.recovery;
  rec.status = "applied";
  conv.hold = null;
  const d = conv.discussion;
  let tail = "本会话没有可继续的讨论。";
  if (d && ["running", "paused", "stale"].includes(d.status)) {
    if (rec.rounds > 0) {
      const agents = agentsIn(s, conv);
      const sameRoster = d.order.length === agents.length && d.order.every((id) => agents.includes(id));
      const approvals = {};
      viewerOwners(s, conv).forEach((id) => (approvals[id] = "approved"));
      Object.assign(d, {
        status: "paused",
        goal: rec.goal,
        input: rec.summary,
        order: [...d.order.filter((id) => agents.includes(id)), ...agents.filter((id) => !d.order.includes(id))],
        turn: sameRoster ? d.turn : 0,
        rounds: d.round - 1 + rec.rounds,
        approvals,
        token: 0,
      });
      tail = `讨论按已确认的新方案保留 ${rec.rounds} 轮，处于暂停，需手动继续。`;
    } else {
      d.status = "done";
      tail = "原讨论已结束；再次讨论需要重新设置并确认。";
    }
  } else if (d && ["pendingApproval", "ready"].includes(d.status)) {
    d.status = "stale";
    tail = "尚未开始的讨论方案已失效，需重新设置并确认。";
  }
  note(
    s,
    conv.id,
    `恢复方案 v${rec.version} 已由${names(s, Object.keys(rec.approvals))}全部确认，本会话恢复新消息发布。${tail}仅影响本会话；不恢复好友关系、电脑许可或已停止、已结束的任务。`,
  );
}

// ───────── task helpers
function stopTask(s, task, reason) {
  task.status = "stopped";
  task.control = "none";
  task.reason = reason;
  task.stopUnconfirmed = false;
  task.stopIntent = null;
}

// Ask the device to stop the Agent. Nothing is claimed as stopped, ended or
// released until the device confirms; an offline device leaves it unconfirmed.
function requestStop(s, task, intent, reason) {
  const device = s.devices[task.deviceId];
  task.control = "pendingStop";
  task.stopIntent = intent;
  task.token = ++s.seq;
  task.stopUnconfirmed = !device?.online;
  if (reason) task.reason = reason;
  if (intent === "stop") task.status = "stopping";
  if (intent === "end") {
    task.status = "ending";
    task.grant = "void"; // revoked at once and never revived, even before the device confirms
  }
}

function finishEnd(s, task) {
  Object.assign(task, { status: "ended", control: "none", grant: "void", stopUnconfirmed: false, stopIntent: null });
  release(s, task);
  note(s, task.convId, "任务已结束：设备已确认停止并释放电脑控制，本次授权失效。没有成果文件。");
}

// Only called once the device is reachable and has confirmed the Agent stopped.
function completeStop(s, task) {
  const intent = task.stopIntent;
  task.stopUnconfirmed = false;
  task.stopIntent = null;
  if (intent === "end") return finishEnd(s, task);
  if (intent === "takeover") {
    const why = taskRunBlock(s, task);
    if (!why) {
      task.control = "human";
      return;
    }
    return stopTask(s, task, `Agent 已确认停止，但接管未进行：${why}。`);
  }
  stopTask(s, task, task.reason || "任务已确认停止。");
  note(s, task.convId, "设备已确认 Agent 停止输入。任务保持停止；电脑仍由本任务占用，直到你重新检查继续或结束任务。");
}

// Runs after every action, so no path (including late timers and simulated
// events elsewhere) can leave an Agent acting once any condition has lapsed.
function enforceTasks(s) {
  Object.values(s.tasks).forEach((t) => {
    const device = s.devices[t.deviceId];
    if (t.control === "pendingStop" && !device?.online) t.stopUnconfirmed = true;
    if (t.status !== "running") return;
    const why = taskRunBlock(s, t);
    if (!why) return;
    const reason = `${why}。已阻止后续操作与成果发布，不会自动恢复。`;
    // Under human control the Agent's stop was already confirmed by the device.
    if ((t.control === "human" || t.control === "returning") && device?.online) stopTask(s, t, reason);
    else requestStop(s, t, "stop", reason);
  });
}

function step(state, action) {
  if (action.type === "reset") return seedState();
  const s = structuredClone(state);
  s.now = action.now || s.now || "15:30";
  const conv = action.convId ? s.convs[action.convId] : null;
  const task = action.taskId ? s.tasks[action.taskId] : null;

  switch (action.type) {
    case "nav":
      Object.assign(s.nav, action.patch);
      return s;
    case "nav/openConv":
      Object.assign(s.nav, { section: "chat", convId: action.convId, view: "chat", pane: "main", taskOpen: false, ...(action.patch || {}) });
      if (conv) conv.unread = 0;
      return s;
    case "toast":
      toast(s, action.text);
      return s;
    case "toast/clear":
      if (s.toast?.id === action.id) s.toast = null;
      return s;

    // ───────── messages
    case "msg/send": {
      const block = publishBlock(s, conv);
      if (block) return toast(s, block.text), s;
      const failed = s.sim.failNext;
      s.sim.failNext = false;
      conv.lastStopped = null;
      const msg = push(s, conv.id, {
        from: ME,
        kind: action.kind || "text",
        text: action.text,
        src: action.src,
        replyTo: action.replyTo || null,
        interject: isInterject(conv),
        status: failed ? "failed" : "sent",
      });
      if (!failed) afterSend(s, conv, msg);
      return s;
    }
    case "msg/retry": {
      const block = publishBlock(s, conv);
      if (block) return toast(s, block.text), s;
      const msg = conv.messages.find((x) => x.id === action.msgId);
      if (!msg || msg.status !== "failed") return s;
      msg.status = "sent";
      msg.at = s.now;
      afterSend(s, conv, msg);
      return s;
    }
    case "read/mark":
      if (!conv || conv.readToken !== action.token) return state;
      conv.readToken = null;
      conv.messages.forEach((x) => {
        if (x.from === ME && x.status === "sent") x.status = "read";
      });
      return s;
    case "gen/finish": {
      if (!conv?.generating || conv.generating.token !== action.token) return state;
      if (publishBlock(s, conv)) return (conv.generating = null), s;
      const id = conv.generating.queue.shift();
      const agent = s.agents[id];
      if (agent && !agent.paused && !(conv.myPause && isMine(s, id)) && conv.members.includes(id) && !(conv.type === "mixed" && agent.groupReply === "不在群内回复")) {
        push(s, conv.id, { from: id, text: pick(REPLIES, id, agent.replyCount) });
        agent.replyCount += 1;
      }
      conv.generating = conv.generating.queue.length ? { queue: conv.generating.queue, token: ++s.seq } : null;
      return s;
    }
    case "gen/stop":
      if (!conv?.generating) return s;
      conv.lastStopped = conv.generating.queue;
      conv.generating = null;
      note(s, conv.id, "已停止本次回复。这不会暂停该 Agent，也不会取消其他任务。");
      return s;
    case "gen/retry": {
      const block = publishBlock(s, conv);
      if (block) return toast(s, block.text), s;
      const queue = (conv.lastStopped || []).filter((id) => !s.agents[id]?.paused && !(conv.type === "mixed" && s.agents[id]?.groupReply === "不在群内回复"));
      conv.lastStopped = null;
      if (queue.length) conv.generating = { queue, token: ++s.seq };
      else toast(s, "该 Agent 已暂停，无法重新生成");
      return s;
    }

    // ───────── recovery confirmation (replaces one-click restore)
    case "recover/propose": {
      if (!publishBlock(s, conv)) return toast(s, "本会话未冻结，无需恢复"), s;
      if (!canManage(s, conv)) return toast(s, "只有群管理员或讨论发起人可以发起恢复"), s;
      const rest = checks(s, conv);
      if (rest.length) return toast(s, `暂不能发起恢复：${rest[0]}`), s;
      if (conv.recovery?.status === "pending") return toast(s, "已有待确认的恢复方案，请先撤回再重新发起"), s;
      const summary = String(action.summary || "").trim();
      const goal = String(action.goal || "").trim();
      if (!summary) return toast(s, "请填写恢复后可使用的新摘要"), s;
      const max = supportsDiscussion(conv) ? remainingRounds(conv) : 0;
      const rounds = Math.max(0, Math.min(max, Number(action.rounds) || 0));
      if (rounds > 0 && !goal) return toast(s, "继续讨论需要填写目标"), s;
      const approvals = {};
      recoveryApprovers(s, conv).forEach((id) => (approvals[id] = id === ME ? "approved" : "pending"));
      conv.recovery = {
        version: (conv.recovery?.version || 0) + 1,
        memberVersion: conv.version,
        status: "pending",
        initiator: ME,
        summary,
        goal: rounds > 0 ? goal : "",
        rounds,
        approvals,
        at: s.now,
      };
      const waiting = Object.keys(approvals).filter((id) => approvals[id] !== "approved");
      note(
        s,
        conv.id,
        waiting.length
          ? `你提交了恢复方案 v${conv.recovery.version}（成员版本 v${conv.version}）并已本人确认，等待${names(s, waiting)}分别确认。全部确认前本会话保持冻结。`
          : `你提交并确认了恢复方案 v${conv.recovery.version}。你是唯一需要确认的人；仍需手动完成恢复。`,
      );
      return s;
    }
    case "recover/withdraw":
      if (conv.recovery?.status !== "pending") return s;
      conv.recovery.status = "withdrawn";
      note(s, conv.id, `你撤回了恢复方案 v${conv.recovery.version}。本会话保持冻结，可重新发起。`);
      return s;
    case "sim/recoverResolve": {
      const rec = conv.recovery;
      if (rec?.status !== "pending") return s;
      if (action.result === "expire") {
        rec.status = "expired";
        note(s, conv.id, `恢复方案 v${rec.version} 超过 24 小时未全部确认，已过期（模拟）。本会话保持冻结，可重新发起。`);
        return s;
      }
      if (action.who === ME || !(action.who in rec.approvals) || rec.approvals[action.who] !== "pending") return s;
      if (action.result === "approve") {
        rec.approvals[action.who] = "approved";
        note(
          s,
          conv.id,
          Object.values(rec.approvals).every((v) => v === "approved")
            ? `${nameOf(s, action.who)}确认了恢复方案 v${rec.version}（模拟）。所有必需的人均已确认；会话不会自动恢复，需手动完成恢复。`
            : `${nameOf(s, action.who)}确认了恢复方案 v${rec.version}（模拟）。`,
        );
      } else {
        rec.approvals[action.who] = "rejected";
        rec.status = "rejected";
        note(s, conv.id, `${nameOf(s, action.who)}拒绝了恢复方案 v${rec.version}（模拟）。本会话保持冻结，可调整后重新发起。`);
      }
      return s;
    }
    case "conv/restore": {
      if (!publishBlock(s, conv)) return s;
      if (!canManage(s, conv)) return toast(s, "只有群管理员或讨论发起人可以恢复"), s;
      const rest = checks(s, conv);
      if (rest.length) return toast(s, `暂不能恢复：${rest[0]}`), s;
      const r = recoveryState(s, conv);
      if (!r.active) return toast(s, "需要先发起恢复确认，并由当前所有必需的人确认"), s;
      if (!r.current) {
        voidRecovery(s, conv, "成员或可见人已变化");
        return toast(s, "成员或可见人已变化，原恢复确认失效，请重新发起"), s;
      }
      if (r.waiting.length) return toast(s, `暂不能恢复：仍在等待${names(s, r.waiting)}确认恢复方案 v${r.rec.version}`), s;
      applyRecovery(s, conv);
      return s;
    }
    case "conv/toggleMyPause":
      conv.myPause = !conv.myPause;
      if (conv.myPause) {
        if (conv.generating) {
          const queue = conv.generating.queue.filter((id) => !isMine(s, id));
          conv.generating = queue.length ? { queue, token: ++s.seq } : null;
        }
        if (conv.discussion?.status === "running") conv.discussion.status = "paused";
        note(s, conv.id, "你暂停了本会话中自己的 Agent。其他人的 Agent 不受影响。");
      } else note(s, conv.id, "你恢复了本会话中自己的 Agent。已暂停的讨论不会自动继续。");
      return s;

    // ───────── discussion
    case "disc/propose": {
      if (!supportsDiscussion(conv)) return toast(s, "此会话不是 Agent 之间的会话，不支持自动讨论"), s;
      const block = publishBlock(s, conv);
      if (block) return toast(s, block.text), s;
      const agents = agentsIn(s, conv);
      const order = Array.isArray(action.order) ? action.order : [];
      if (agents.length < 2 || order.length !== agents.length || !agents.every((id) => order.includes(id)))
        return toast(s, "发言顺序必须恰好包含本会话当前的全部 Agent"), s;
      const rounds = Math.max(1, Math.min(4, Number(action.rounds) || 1));
      const budget = DISCUSSION_BUDGETS.includes(action.budget) ? action.budget : DISCUSSION_BUDGETS[0];
      const approvals = {};
      viewerOwners(s, conv).forEach((id) => (approvals[id] = id === ME ? "approved" : "pending"));
      const ready = Object.values(approvals).every((v) => v === "approved");
      conv.discussion = {
        status: ready ? "ready" : "pendingApproval",
        initiator: ME,
        goal: action.goal,
        input: action.input,
        rounds,
        budget,
        spent: 0,
        round: 1,
        turn: 0,
        order,
        approvals,
        token: 0,
      };
      note(
        s,
        conv.id,
        `${ready ? "讨论方案已确认，可由你手动开始" : "你提交了讨论方案，等待其他主人分别确认"} · 最多 ${rounds} 轮 · 模拟预算上限 ${budget} 点。`,
      );
      return s;
    }
    case "disc/start":
    case "disc/resume": {
      const d = conv.discussion;
      if (!supportsDiscussion(conv)) return toast(s, "此会话不支持自动讨论"), s;
      const block = publishBlock(s, conv);
      if (block) return toast(s, block.text), s;
      if (!d || !["ready", "paused"].includes(d.status)) return s;
      const agents = agentsIn(s, conv);
      const owners = viewerOwners(s, conv);
      const rosterOk = d.order.length === agents.length && d.order.every((id) => agents.includes(id));
      if (!rosterOk || !owners.every((id) => d.approvals[id] === "approved")) {
        d.status = "stale";
        return toast(s, "成员或主人已变化，原讨论方案失效，需重新设置并确认"), s;
      }
      const paused = d.order.find((id) => s.agents[id].paused || (conv.myPause && isMine(s, id)));
      if (paused) return toast(s, `${nameOf(s, paused)}已暂停，无法继续讨论`), s;
      if (d.status === "ready") note(s, conv.id, `讨论已开始 · 最多 ${d.rounds} 轮 · 模拟预算上限 ${d.budget ?? "未设"} 点 · 每轮按固定顺序各发言一次`);
      d.status = "running";
      d.token = ++s.seq;
      return s;
    }
    case "disc/tick": {
      const d = conv?.discussion;
      if (!d || d.status !== "running" || d.token !== action.token) return state;
      if (publishBlock(s, conv)) return (d.status = "paused"), s;
      const id = d.order[d.turn];
      if (!s.agents[id] || !conv.members.includes(id)) return (d.status = "stale"), s;
      if (s.agents[id].paused || (conv.myPause && isMine(s, id))) {
        d.status = "paused";
        note(s, conv.id, `${nameOf(s, id)}已暂停，本次讨论暂停等待检查。`);
        return s;
      }
      const spent = d.spent || 0;
      if (d.budget != null && spent + TURN_COST > d.budget) {
        d.status = "done";
        note(s, conv.id, `已达到模拟预算上限 ${d.budget} 点（已用 ${spent} 点），讨论结束。增加预算或轮次需要重新设置并确认。`);
        return s;
      }
      push(s, conv.id, { from: id, text: `第 ${d.round} 轮：${pick(DISCUSS, id, d.round - 1)}` });
      d.spent = spent + TURN_COST;
      d.turn += 1;
      if (d.turn >= d.order.length) {
        d.turn = 0;
        d.round += 1;
      }
      if (d.round > d.rounds) {
        d.status = "done";
        note(s, conv.id, `已达到 ${d.rounds} 轮上限，讨论结束（模拟预算已用 ${d.spent} 点）。补充目标或增加轮次需要重新确认。`);
      } else d.token = ++s.seq;
      return s;
    }
    case "disc/pause":
      if (conv.discussion?.status === "running") {
        conv.discussion.status = "paused";
        note(s, conv.id, "你暂停了本次讨论。真人仍可发言；不影响其他会话。");
      }
      return s;
    case "disc/end":
      if (conv.discussion && conv.discussion.status !== "done") {
        conv.discussion.status = "done";
        note(s, conv.id, "本次讨论已结束。再次讨论需要重新设置并确认。");
      }
      return s;
    case "sim/discResolve": {
      const d = conv.discussion;
      if (!d || d.status !== "pendingApproval" || action.who === ME) return s;
      if (action.ok) {
        d.approvals[action.who] = "approved";
        if (Object.values(d.approvals).every((v) => v === "approved")) {
          d.status = "ready";
          note(s, conv.id, "所有相关主人已确认讨论方案。讨论不会自动开始，由发起人手动开始。");
        }
      } else {
        d.approvals[action.who] = "rejected";
        d.status = "done";
        note(s, conv.id, `${nameOf(s, action.who)}拒绝了讨论方案，讨论未开始。`);
      }
      return s;
    }

    // ───────── expansion & membership
    case "exp/propose": {
      if (conv.expansion?.status === "pending") return toast(s, "已有待确认的扩员方案，不能重复提交"), s;
      const approvals = {};
      requiredApprovers(s, conv, action.candidate).forEach((id) => (approvals[id] = id === ME ? "approved" : "pending"));
      conv.expansion = {
        version: (conv.expansion?.version || 1) + 1,
        candidate: action.candidate,
        initiator: ME,
        status: "pending",
        approvals,
        joinedAt: null,
      };
      hold(s, conv, "expansion");
      note(s, conv.id, `你提交了扩员方案 v${conv.expansion.version}（拟加入 ${nameOf(s, action.candidate)}）。扩员期间冻结本群新增消息、附件与讨论。`);
      settleExpansion(s, conv);
      return s;
    }
    case "exp/approve":
      if (conv.expansion?.status !== "pending" || !(ME in conv.expansion.approvals)) return s;
      conv.expansion.approvals[ME] = "approved";
      settleExpansion(s, conv);
      return s;
    case "exp/reject":
      if (conv.expansion?.status !== "pending") return s;
      conv.expansion.approvals[ME] = "rejected";
      failExpansion(s, conv, "rejected", "你拒绝了本次扩员。");
      return s;
    case "exp/withdraw":
      if (conv.expansion?.status !== "pending") return s;
      if (conv.expansion.initiator !== ME) return toast(s, "只有发起人可以撤回"), s;
      failExpansion(s, conv, "withdrawn", "你撤回了扩员方案。");
      return s;
    case "sim/expResolve": {
      const e = conv.expansion;
      if (!e || e.status !== "pending") return s;
      if (action.result === "expire") failExpansion(s, conv, "expired", "扩员方案超过 24 小时未全部确认，已过期。");
      else if (action.result === "withdraw") {
        if (e.initiator !== ME) failExpansion(s, conv, "withdrawn", `发起人${nameOf(s, e.initiator)}撤回了扩员方案。`);
      } else if (action.who && action.who !== ME && action.who in e.approvals) {
        if (action.result === "approve") {
          e.approvals[action.who] = "approved";
          settleExpansion(s, conv);
        } else {
          e.approvals[action.who] = "rejected";
          failExpansion(s, conv, "rejected", `${nameOf(s, action.who)}拒绝了本次扩员。`);
        }
      }
      return s;
    }
    case "group/remove": {
      const id = action.memberId;
      const own = isMine(s, id);
      if (!own && conv.admin !== ME) return toast(s, "只有群管理员可以移除成员"), s;
      if (!conv.members.includes(id)) return s;
      conv.members = conv.members.filter((x) => x !== id);
      bumpVersion(s, conv);
      conv.generating = null;
      if (conv.discussion && conv.discussion.status !== "done") conv.discussion.status = "stale";
      note(s, conv.id, own ? `你撤回了${nameOf(s, id)}，它立即停止参与本群。` : `${nameOf(s, id)}已被移出本群，停止接收新内容。`);
      resetApprovals(s, conv);
      if (!conv.hold) conv.hold = { kind: "membership" };
      return s;
    }
    case "group/exit": {
      const leaving = conv.members.filter((id) => id === ME || isMine(s, id));
      conv.members = conv.members.filter((id) => !leaving.includes(id));
      Object.values(s.shares).forEach((sh) => {
        if (sh.target === conv.id && sh.status === "pending") sh.status = "invalid";
      });
      s.order = s.order.filter((x) => x !== conv.id);
      delete s.convs[conv.id];
      Object.assign(s.nav, { convId: s.order[0], view: "chat", detailsOpen: false, pane: "list" });
      toast(s, "你已退出该群，你的 Agent 同时停止参与。已取得的历史不会被远端抹除。");
      return s;
    }

    // ───────── relations
    case "rel/apply": {
      const { subject, target } = action;
      if (subject !== ME && !isMine(s, subject)) return toast(s, "只能以你本人或你拥有的 Agent 发起"), s;
      if (!subject || !target || subject === target) return s;
      if (target === ME || (subject === ME && isMine(s, target))) return toast(s, "你与自己的 Agent 已有专属会话，无需申请"), s;
      if (s.blocks.some((b) => b.by === ME && b.target === target)) return toast(s, "你已拉黑对方，需先解除拉黑"), s;
      const existing = relation(s, subject, target);
      if (existing?.status === "pending" || existing?.status === "incoming") return toast(s, "已有待处理的申请，不会重复发送"), s;
      if (existing?.status === "established") return toast(s, "已建立联系"), s;
      delete s.relations[relKey(target, subject)];
      if (ownerOf(s, subject) === ownerOf(s, target)) {
        // Both sides belong to the same person: one confirmation, no external response to wait for.
        s.relations[relKey(subject, target)] = { status: "established", at: `今天 ${s.now}`, sameOwner: true };
        ensureConv(s, subject, target);
        toast(s, "你是双方唯一的主人，已一次确认并建立联系。不会自动开始讨论，也不授予工具或电脑权限");
        return s;
      }
      s.relations[relKey(subject, target)] = { status: "pending", at: `今天 ${s.now}` };
      toast(s, "申请已发送，24 小时内未确认将失效");
      return s;
    }
    case "rel/withdraw":
      if (s.relations[action.key]?.status === "pending") s.relations[action.key].status = "withdrawn";
      return s;
    case "rel/accept":
    case "rel/reject": {
      const r = s.relations[action.key];
      if (r?.status !== "incoming") return s;
      const [a, b] = action.key.split("|");
      if (action.type === "rel/accept") {
        r.status = "established";
        ensureConv(s, a, b);
        toast(s, "已确认。关系建立不会自动开始讨论，也不授予工具或电脑权限");
      } else r.status = "rejected";
      return s;
    }
    case "rel/remove": {
      const key = [relKey(ME, action.target), relKey(action.target, ME)].find((k) => s.relations[k]);
      if (!key) return s;
      s.relations[key].status = "removed";
      Object.values(s.convs).forEach((c) => {
        if (["human", "agent"].includes(c.type) && c.members.includes(action.target)) {
          c.generating = null;
          note(s, c.id, "联系已解除，停止新的私聊。已有历史不会被追溯删除。");
        }
      });
      return s;
    }
    case "sim/relResolve": {
      const r = s.relations[action.key];
      if (r?.status !== "pending") return s;
      const [a, b] = action.key.split("|");
      if (ownerOf(s, a) === ownerOf(s, b)) return s; // no external party exists to respond
      r.status = action.result;
      if (action.result === "established") ensureConv(s, a, b);
      return s;
    }
    case "sim/incoming": {
      const key = relKey("xlPhoto", "travel");
      if (relation(s, "xlPhoto", "travel")) return toast(s, "该申请已存在，不会重复创建"), s;
      s.relations[key] = { status: "incoming", at: `今天 ${s.now}` };
      toast(s, "收到新的联系申请（模拟）");
      return s;
    }

    // ───────── blocking & visibility
    case "block/add":
      addBlock(s, ME, action.target);
      return s;
    case "block/remove":
      removeBlock(s, ME, action.target);
      return s;
    case "sim/block":
      if (action.by === ME) return s;
      if (action.on) addBlock(s, action.by, action.target);
      else removeBlock(s, action.by, action.target);
      return s;
    case "sim/visibility":
      if (action.down && conv.visibility !== "down") {
        conv.visibility = "down";
        hold(s, conv, "visibility");
        note(s, conv.id, "必要主人暂时无法查看本会话。新消息、附件、本人插话、自动讨论以及来自本会话的电脑任务已冻结。");
      } else if (!action.down && conv.visibility === "down") {
        conv.visibility = "ok";
        note(s, conv.id, "主人可见已恢复正常。会话不会自动恢复：需由当前所有必需的人确认恢复方案后手动恢复。");
      }
      return s;

    // ───────── agents
    case "agent/save": {
      if (action.id) {
        if (!isMine(s, action.id)) return toast(s, "只能编辑自己的 Agent"), s;
        Object.assign(s.agents[action.id], action.fields);
        Object.assign(s.nav, { agentView: "detail" });
        toast(s, "已保存。编辑说明不会授予文件、工具或电脑权限");
        return s;
      }
      const id = `ag${++s.seq}`;
      s.agents[id] = makeAgent({ ...action.fields, id, ownerId: ME, handle: `@me-${id}`, cell: DEFAULT_AGENT_CELL, tags: [action.fields.field].filter(Boolean) });
      const convId = `p_${id}`;
      s.convs[convId] = {
        id: convId, type: "agent", members: [ME, id], admin: null, at: s.now, unread: 0, hold: null, visibility: "ok",
        expansion: null, discussion: null, recovery: null, myPause: false, generating: null, version: 1, cutoffs: {}, messages: [],
      };
      s.order = [convId, ...s.order];
      note(s, convId, "专属会话已创建。未自动授予任何设备或文件权限。");
      Object.assign(s.nav, { agentId: id, agentView: "detail", agentTab: "profile" });
      toast(s, "Agent 已创建");
      return s;
    }
    case "agent/pause": {
      const a = s.agents[action.id];
      if (!isMine(s, action.id)) return toast(s, "只能管理自己的 Agent"), s;
      a.paused = action.paused;
      if (a.paused) {
        Object.values(s.convs).forEach((c) => {
          if (!c.members.includes(a.id)) return;
          if (c.generating) {
            const queue = c.generating.queue.filter((x) => x !== a.id);
            c.generating = queue.length ? { queue, token: ++s.seq } : null;
          }
          if (c.discussion?.status === "running") {
            c.discussion.status = "paused";
            note(s, c.id, `${a.name}已暂停全部会话，本次讨论暂停等待检查。`);
          }
        });
        // Its running tasks are stopped by enforceTasks(), pending device confirmation.
        const active = Object.values(s.tasks).some((t) => t.agentId === a.id && t.status === "running");
        toast(s, `${a.name}已暂停全部会话：不再有新回复和新任务${active ? "；进行中的任务已请求停止，以设备确认为准" : ""}`);
      } else toast(s, `${a.name}已恢复。已暂停的讨论和任务不会自动继续`);
      return s;
    }
    case "agent/ability": {
      const a = s.agents[action.id];
      if (!isMine(s, action.id)) return toast(s, "只能配置自己的 Agent"), s;
      const busy = Object.values(s.tasks).some((t) => t.agentId === a.id && isTaskLive(t));
      if (busy) return toast(s, "该 Agent 有进行中的任务，请先结束任务再调整"), s;
      const device = action.execMode === "none" ? null : action.device;
      if (device && s.devices[device].owner !== ME) return toast(s, "你没有该设备的分配权限"), s;
      Object.assign(a, { execMode: action.execMode, device, caps: action.caps, folder: action.folder });
      toast(s, "已保存能力上限与设备分配。分配不会启动任务，每次任务仍需单独授权");
      return s;
    }

    // ───────── tasks
    case "task/authorize": {
      if (task.status !== "requested" || task.grant !== "pending") return s;
      const blockers = taskBlockers(s, task);
      if (blockers.length) return toast(s, blockers[0].text), s;
      Object.assign(task, {
        status: "running",
        control: "agent",
        grant: "active",
        step: 0,
        token: ++s.seq,
        reason: "",
        folder: s.agents[task.agentId].folder,
        stopIntent: null,
        stopUnconfirmed: false,
      });
      Object.assign(s.devices[task.deviceId], { busy: true, heldBy: task.id });
      s.nav.taskOpen = true;
      note(s, task.convId, "你已授权本次任务。授权仅覆盖本任务，完成或取消后失效。");
      return s;
    }
    case "task/decline": {
      if (task.status !== "requested") return s;
      task.status = action.result; // rejected | cancelled | expired
      task.grant = "void";
      const text = { rejected: "你拒绝了本次授权申请，可调整后重新申请。", cancelled: "任务已取消。", expired: "授权申请超过 24 小时未确认，已过期。" };
      note(s, task.convId, text[action.result]);
      return s;
    }
    case "task/new": {
      const host = s.convs[action.convId];
      if (!host) return s;
      const block = publishBlock(s, host);
      if (block) return toast(s, block.text), s;
      const current = activeTaskFor(s, action.convId);
      if (isTaskOpen(current)) return toast(s, "已有进行中的任务申请"), s;
      const id = `t${++s.seq}`;
      s.tasks[id] = makeTask(id, (current?.attempt || 0) + 1);
      push(s, action.convId, { from: s.tasks[id].agentId, kind: "task", refId: id, text: "任务授权申请" });
      return s;
    }
    case "task/tick": {
      // Fired by the step timer or by the labelled demo "advance" control; both
      // carry the token and pass the same full recheck before any step or result.
      if (!task || task.status !== "running" || task.control !== "agent" || task.token !== action.token) return state;
      const why = taskRunBlock(s, task);
      if (why) return requestStop(s, task, "stop", `${why}。已阻止后续操作与成果发布，不会自动恢复。`), s;
      task.step += 1;
      if (task.step >= TASK_STEPS.length) {
        Object.assign(task, { status: "done", control: "none", grant: "void" });
        release(s, task);
        if (!task.resultPosted) {
          task.resultPosted = true;
          push(s, task.convId, { from: task.agentId, kind: "result", refId: task.id, text: "镰仓一日行程.pdf" });
          note(s, task.convId, "任务已完成：成果已发布到本私聊一次，电脑控制已释放，本次授权已失效。");
        }
      } else task.token = ++s.seq;
      return s;
    }
    case "task/input": {
      const task = s.tasks[action.taskId];
      if (!task || task.status !== "running" || task.control !== "human" || taskRunBlock(s, task)) return s;
      const text = String(action.text || "").trim().slice(0, 240);
      if (text) task.edits = [...(task.edits || []), text];
      return s;
    }
    case "task/takeover":
      if (task.status === "running" && task.control === "agent") requestStop(s, task, "takeover");
      return s;
    case "task/stopConfirmed":
      if (task?.control !== "pendingStop" || task.token !== action.token) return state;
      if (s.devices[task.deviceId].online) completeStop(s, task);
      else task.stopUnconfirmed = true;
      return s;
    case "task/retryStop":
      if (task.control !== "pendingStop" || !task.stopUnconfirmed) return s;
      if (!s.devices[task.deviceId].online) return toast(s, "设备仍离线，停止请求无法送达。任务保持「未确认」"), s;
      Object.assign(task, { stopUnconfirmed: false, token: ++s.seq });
      return s;
    case "sim/deviceStopAck":
      // Labelled simulated device event. It can only land on a reachable device.
      if (task?.control !== "pendingStop") return s;
      if (!s.devices[task.deviceId].online) return toast(s, "设备离线，收不到停止确认；模拟事件未生效"), s;
      completeStop(s, task);
      return s;
    case "task/return":
      if (task.status === "running" && task.control === "human") Object.assign(task, { control: "returning", token: ++s.seq });
      return s;
    case "task/returnChecked": {
      if (task?.status !== "running" || task.control !== "returning" || task.token !== action.token) return state;
      const why = taskRunBlock(s, task);
      if (why) stopTask(s, task, `交还检查未通过：${why}。`);
      else Object.assign(task, { control: "agent", status: "running", token: ++s.seq });
      return s;
    }
    case "task/pause": {
      if (task.status !== "running") return s;
      const reason = "你暂停了本任务。继续前会重新检查授权、来源会话与设备。";
      const agentMayAct = task.control === "agent" || task.control === "pendingStop";
      if (!agentMayAct && s.devices[task.deviceId].online) stopTask(s, task, reason);
      else requestStop(s, task, "stop", reason);
      return s;
    }
    case "task/recheck": {
      if (task.status !== "stopped") return s;
      const why = taskRunBlock(s, task);
      if (why) return toast(s, `暂不能继续：${why}`), s;
      Object.assign(task, { status: "running", control: "agent", token: ++s.seq, reason: "" });
      return s;
    }
    case "task/end": {
      if (!isTaskLive(task) || task.status === "ending") return s;
      task.grant = "void";
      const agentMayAct = task.control === "agent" || task.control === "pendingStop";
      if (!agentMayAct && s.devices[task.deviceId].online) finishEnd(s, task);
      else {
        requestStop(s, task, "end");
        note(s, task.convId, "你请求结束任务：本次授权已立即失效。等待设备确认停止后才会释放电脑控制。");
      }
      return s;
    }
    case "sim/device": {
      const d = s.devices[action.deviceId];
      // Going offline never auto-stops or releases anything: enforceTasks() turns
      // running tasks into an unconfirmed stop request that waits for the device.
      if ("online" in action) d.online = action.online;
      if ("busy" in action && (!d.heldBy || d.heldBy === "other")) {
        d.busy = action.busy;
        d.heldBy = action.busy ? "other" : null;
      }
      return s;
    }

    // ───────── sharing
    case "share/create": {
      const target = s.convs[action.target];
      if (!isOwnPrivate(s, conv)) return toast(s, "只能从你与自己 Agent 的私聊中选择摘要分享"), s;
      if (!canShareInto(s, target)) return toast(s, "你不是该会话的发言成员或可见主人，不能分享到这里"), s;
      const items = Array.isArray(action.items) ? action.items.filter(Boolean) : [];
      if (!items.length) return toast(s, "请至少选择一条内容"), s;
      if (publishBlock(s, conv)) return toast(s, "来源私聊已冻结，不能发起分享"), s;
      if (publishBlock(s, target)) return toast(s, "目标会话已冻结，不能发起分享"), s;
      const id = `s${++s.seq}`;
      s.shares[id] = {
        id,
        convId: conv.id,
        target: target.id,
        items,
        status: "pending",
        version: target.version,
        audienceKey: audienceKey(s, target),
        source: `你与${nameOf(s, otherMember(conv))}的私聊`,
      };
      push(s, conv.id, { from: ME, kind: "share", refId: id, text: "分享确认" });
      return s;
    }
    case "share/confirm": {
      const sh = s.shares[action.id];
      if (sh?.status !== "pending") return s;
      const target = s.convs[sh.target];
      if (!target || !canShareInto(s, target)) return (sh.status = "invalid"), toast(s, "你已不能向该会话发布，分享确认失效"), s;
      if (target.version !== sh.version || audienceKey(s, target) !== sh.audienceKey)
        return (sh.status = "invalid"), toast(s, "目标会话的成员或可见人已变化，原确认失效，请重新发起分享"), s;
      if (publishBlock(s, target)) return toast(s, "目标会话已冻结，未发布。恢复后可再次确认，不会重复发送"), s;
      sh.status = "sent";
      push(s, sh.target, {
        from: ME,
        kind: "shared",
        items: sh.items,
        text: "分享的摘要",
        source: sh.source || "你与自己 Agent 的私聊",
        interject: isInterject(target),
      });
      toast(s, "所选摘要已发布一次");
      return s;
    }
    case "share/close": {
      const sh = s.shares[action.id];
      if (sh?.status === "pending") sh.status = action.result; // cancelled | expired
      return s;
    }

    // ───────── other simulated events
    case "sim/failNext":
      s.sim.failNext = !s.sim.failNext;
      return s;
    case "sim/peerMessage": {
      if (publishBlock(s, conv)) return toast(s, "会话已冻结，对方同样无法发布新消息"), s;
      const from = conv.members.find((id) => id !== ME && !isAgent(s, id));
      if (!from) return s;
      push(s, conv.id, { from, text: action.text || "好的，我看到了。" });
      if (conv.type === "observed") queueReplies(s, conv, agentsIn(s, conv));
      return s;
    }
    default:
      return state;
  }
}

export function reducer(state, action) {
  const next = step(state, action);
  if (next === state) return state;
  enforceTasks(next);
  return next;
}
