import React from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { TASK_SCOPE } from "../data/copy.js";
import { isAgent, nameOf, ownerOf, taskBlockers, activeTaskFor, audience, convTitle, taskPhase, isTaskLive, publishBlock, canShareInto, audienceKey } from "../state/selectors.js";
import { Avatar, Tag, Btn, Reason, asset } from "../ui/primitives.jsx";
import { Reply, RotateCw, FileText, Check, CircleAlert, Monitor, Share2, Lock } from "../icons.js";

function TaskCard({ msg, conv }) {
  const { state, dispatch } = useStore();
  const task = state.tasks[msg.refId];
  if (!task) return null;
  const device = state.devices[task.deviceId];
  const [label, tone] = taskPhase(task);
  const blockers = task.status === "requested" ? taskBlockers(state, task) : [];
  const latest = activeTaskFor(state, conv.id)?.id === task.id;
  const terminal = ["done", "ended", "rejected", "cancelled", "expired"].includes(task.status);
  const fix = (kind) =>
    dispatch({ type: "nav", patch: { section: "agents", agentId: task.agentId, agentView: "detail", agentTab: kind === "ability" ? "ability" : "profile", pane: "main" } });
  return (
    <div className="card task-card">
      <div className="card-head">
        <Monitor size={18} aria-hidden="true" />
        <strong>任务授权申请{task.attempt > 1 ? ` · 第 ${task.attempt} 次尝试` : ""}</strong>
        <Tag tone={tone}>{label}</Tag>
      </div>
      <p className="card-title">{task.title}</p>
      <dl className="mini-kv">
        <div><dt>执行 Agent</dt><dd>{nameOf(state, task.agentId)}（主人：你）</dd></div>
        <div><dt>设备</dt><dd>{device.name}</dd></div>
        <div><dt>允许</dt><dd>{TASK_SCOPE.allow.join("；")}</dd></div>
        <div><dt>不允许</dt><dd>{TASK_SCOPE.deny.join("；")}</dd></div>
        <div><dt>结果去向</dt><dd>{TASK_SCOPE.result}</dd></div>
        <div><dt>期限</dt><dd>{TASK_SCOPE.ttl}</dd></div>
      </dl>
      {task.status === "requested" && (
        <>
          {blockers.map((b) => (
            <div key={b.text} className="blocker">
              <Reason>{b.text}</Reason>
              {b.fix && (
                <Btn small onClick={() => fix(b.fix)}>
                  {b.fix === "ability" ? "前往能力与设备" : "前往 Agent 管理"}
                </Btn>
              )}
            </div>
          ))}
          <div className="card-actions">
            <Btn variant="primary" disabled={blockers.length > 0} reason={blockers[0]?.text} onClick={() => dispatch({ type: "task/authorize", taskId: task.id })}>
              授权本次任务
            </Btn>
            <Btn onClick={() => dispatch({ type: "task/decline", taskId: task.id, result: "rejected" })}>拒绝</Btn>
            <Btn variant="text" onClick={() => dispatch({ type: "task/decline", taskId: task.id, result: "cancelled" })}>取消任务</Btn>
          </div>
        </>
      )}
      {isTaskLive(task) && (
        <div className="card-actions">
          <Btn variant="primary" onClick={() => dispatch({ type: "nav", patch: { taskOpen: true, detailsOpen: false } })}>查看执行</Btn>
          {task.control === "pendingStop" && (
            <Reason>
              {task.stopUnconfirmed ? "停止尚未得到设备确认" : "等待设备确认停止"}
              {task.status === "ending" ? "；授权已失效，电脑控制尚未确认释放。" : "；不代表 Agent 已停止。"}
            </Reason>
          )}
          {task.reason && <Reason>{task.reason}</Reason>}
        </div>
      )}
      {terminal && (
        <div className="card-actions">
          <span className="muted">{task.status === "done" ? "成果已发布一次，授权已失效。" : "本次授权已失效，不能复用。"}</span>
          {latest && <Btn small onClick={() => dispatch({ type: "task/new", convId: conv.id })}>{task.status === "rejected" ? "调整后重新申请" : "发起新的尝试"}</Btn>}
        </div>
      )}
    </div>
  );
}

const SHARE_STATUS = {
  pending: ["待你确认", "pending"],
  sent: ["已发布一次", "ok"],
  cancelled: ["已取消", "muted"],
  expired: ["已过期", "muted"],
  invalid: ["受众已变化，已失效", "warn"],
};

function ShareCard({ msg }) {
  const { state, dispatch } = useStore();
  const share = state.shares[msg.refId];
  if (!share) return null;
  const target = state.convs[share.target];
  const [label, tone] = SHARE_STATUS[share.status];
  const pending = share.status === "pending";
  const changed = pending && (!target || !canShareInto(state, target) || target.version !== share.version || (share.audienceKey && audienceKey(state, target) !== share.audienceKey));
  const frozen = pending && target && !changed && publishBlock(state, target);
  const asOwner = target && !target.members.includes(ME);
  const who = (id) => `${nameOf(state, id)}${isAgent(state, id) ? `（Agent · 主人：${nameOf(state, ownerOf(state, id))}）` : "（真人）"}`;
  return (
    <div className="card share-card">
      <div className="card-head">
        <Share2 size={18} aria-hidden="true" />
        <strong>分享确认</strong>
        <Tag tone={tone}>{label}</Tag>
      </div>
      <dl className="mini-kv">
        <div><dt>来源</dt><dd>{share.source || "你与自己 Agent 的私聊"}（唯一来源，仅所选内容）</dd></div>
        <div><dt>目标会话</dt><dd>{target ? `${convTitle(state, target)} · ${target.type === "agentGroup" ? "Agent 群（你以主人身份插话）" : "混合群"} · 确认时成员版本 v${share.version}` : "已不可用"}</dd></div>
        <div><dt>发言成员</dt><dd>{target ? target.members.map(who).join("、") : "—"}</dd></div>
        <div><dt>全部可见人</dt><dd>{target ? audience(state, target).map((id) => nameOf(state, id)).join("、") + "，及群内 Agent" : "—"}</dd></div>
        <div><dt>范围</dt><dd>一次性；不包含整段聊天或旧群历史，不沿用其他授权{asOwner ? "；以你的本人插话发布" : ""}</dd></div>
      </dl>
      <ul className="share-items">
        {share.items.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {pending && (
        <div className="card-actions">
          <Btn
            variant="primary"
            disabled={Boolean(changed || frozen)}
            reason={changed ? "目标会话的成员或可见人已变化，原确认作废" : "目标会话已冻结，不能发布"}
            onClick={() => dispatch({ type: "share/confirm", id: share.id })}
          >
            确认分享
          </Btn>
          <Btn onClick={() => dispatch({ type: "share/close", id: share.id, result: "cancelled" })}>取消</Btn>
          {changed && <Reason>目标会话的成员或可见人已变化，这份确认不能再使用。请取消后重新发起分享。</Reason>}
          {frozen && <Reason>目标会话已冻结，不能发布。恢复后可再次确认，不会重复发送。</Reason>}
        </div>
      )}
      {share.status === "invalid" && <Reason>目标会话的成员或可见人在确认前发生变化，这份确认已作废，未发布任何内容。</Reason>}
    </div>
  );
}

function Body({ msg, conv }) {
  const { state } = useStore();
  if (msg.kind === "image")
    return (
      <figure className="attachment-image">
        <img src={asset(msg.src)} alt={msg.text} />
        <figcaption>{msg.text} · 模拟附件</figcaption>
      </figure>
    );
  if (msg.kind === "file" || msg.kind === "result")
    return (
      <div className="card file-card">
        <FileText size={28} aria-hidden="true" />
        <div>
          <strong>{msg.text}</strong>
          <p className="muted">{msg.kind === "result" ? "任务成果 · 本地生成 · 仅发布到本私聊" : "模拟附件 · 仅本会话可见"}</p>
        </div>
      </div>
    );
  if (msg.kind === "task") return <TaskCard msg={msg} conv={conv} />;
  if (msg.kind === "share") return <ShareCard msg={msg} />;
  if (msg.kind === "shared")
    return (
      <div className="card shared-card">
        <div className="card-head">
          <Lock size={16} aria-hidden="true" />
          <strong>分享的摘要</strong>
        </div>
        <p className="muted">来源：{msg.source} · 仅所选内容</p>
        <ul className="share-items">
          {msg.items.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    );
  const quoted = msg.replyTo ? conv.messages.find((x) => x.id === msg.replyTo) : null;
  return (
    <div className="bubble">
      {quoted && (
        <blockquote>
          <strong>{quoted.from ? nameOf(state, quoted.from) : ""}</strong>
          {quoted.kind === "image" ? "[图片]" : quoted.text}
        </blockquote>
      )}
      {msg.text}
    </div>
  );
}

export function MessageItem({ msg, conv, onReply }) {
  const { state, dispatch } = useStore();
  if (msg.kind === "system")
    return (
      <li className="msg-system">
        <span>{msg.text}</span>
      </li>
    );
  const mine = msg.from === ME;
  const agent = isAgent(state, msg.from);
  const showReceipt = mine && conv.type === "human";
  return (
    <li className={`msg ${mine ? "mine" : "theirs"}`}>
      <Avatar id={msg.from} size={40} />
      <div className="msg-main">
        <div className="msg-meta">
          <strong>{nameOf(state, msg.from)}</strong>
          {agent && <Tag>Agent</Tag>}
          {agent && <span className="owner">主人：{nameOf(state, ownerOf(state, msg.from))}</span>}
          {msg.interject && <Tag tone="human">本人插话</Tag>}
          <time>{msg.at}</time>
        </div>
        <Body msg={msg} conv={conv} />
        <div className="msg-foot">
          {msg.status === "failed" ? (
            <>
              <span className="failed">
                <CircleAlert size={14} aria-hidden="true" /> 发送失败，未发布
              </span>
              <Btn small onClick={() => dispatch({ type: "msg/retry", convId: conv.id, msgId: msg.id })}>
                <RotateCw size={14} aria-hidden="true" /> 重试
              </Btn>
            </>
          ) : (
            showReceipt && (
              <span className="receipt">
                {msg.status === "read" ? (
                  <>
                    <Check size={13} aria-hidden="true" /> 已读
                  </>
                ) : (
                  "已发送"
                )}
              </span>
            )
          )}
          {(msg.kind === "text" || msg.kind === "image") && msg.status !== "failed" && (
            <button type="button" className="msg-action" onClick={() => onReply(msg)}>
              <Reply size={15} aria-hidden="true" /> 回复
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
