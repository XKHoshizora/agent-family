import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { TASK_STEPS, TASK_SCOPE } from "../data/copy.js";
import { activeTaskFor, nameOf, isTaskLive, taskPhase, taskRunBlock } from "../state/selectors.js";
import { Btn, IconBtn, Notice, Tag, KV, Reason } from "../ui/primitives.jsx";
import { X, Check, Circle, Monitor, RotateCw } from "../icons.js";

const OPERATOR = {
  agent: ["Agent 操作中", "ok"],
  pendingStop: ["操作者未确认", "pending"],
  human: ["你控制中", "solid"],
  returning: ["交还检查中", "pending"],
  none: ["无操作者", "muted"],
};
const GRANT = { pending: "待确认", active: "生效中（仅本任务）", void: "已失效，不能复用或恢复" };
const INTENT = { takeover: "接管", stop: "停止", end: "结束" };

export function TaskPanel({ conv }) {
  const { state, dispatch } = useStore();
  const [typed, setTyped] = useState("");
  const task = activeTaskFor(state, conv.id);
  const close = () => dispatch({ type: "nav", patch: { taskOpen: false } });
  if (!task)
    return (
      <div className="side">
        <header className="side-head">
          <h2>任务执行</h2>
          <IconBtn label="关闭" onClick={close}><X size={18} /></IconBtn>
        </header>
        <p className="muted pad">当前会话没有任务。</p>
      </div>
    );
  const device = state.devices[task.deviceId];
  const act = (type) => dispatch({ type, taskId: task.id });
  const live = isTaskLive(task);
  const [phase, phaseTone] = taskPhase(task);
  const [opLabel, opTone] = OPERATOR[task.control] || OPERATOR.none;
  const acting = task.status === "running" && task.control === "agent";
  const human = task.control === "human" && task.status === "running";
  const pendingStop = task.control === "pendingStop";
  const intent = INTENT[task.stopIntent] || "停止";
  const held = device.heldBy === task.id;
  const resumeBlock = task.status === "stopped" ? taskRunBlock(state, task) : null;

  return (
    <div className="side task-panel">
      <header className="side-head">
        <h2>任务执行</h2>
        <IconBtn label="关闭面板（不会结束任务）" onClick={close}><X size={18} /></IconBtn>
      </header>
      <div className="side-body">
        <p className="card-title">{task.title}</p>
        <div className="tag-row">
          <Tag tone={phaseTone}>{phase}</Tag>
          <Tag tone={opTone}>{opLabel}</Tag>
          <Tag tone={device.online ? "ok" : "warn"}>{device.short} · {device.online ? "在线" : "离线"}</Tag>
          {live && <Tag tone={held ? "pending" : "muted"}>{held ? "电脑由本任务占用" : "电脑未占用"}</Tag>}
        </div>

        <div className={`screen ${human ? "screen-human" : ""}`} aria-label="电脑画面（模拟）">
          <div className="screen-bar">
            <Monitor size={14} aria-hidden="true" /> {device.name} · 模拟画面
          </div>
          <div className="screen-body">
            {task.status === "done" ? (
              <p>已生成：镰仓一日行程.pdf</p>
            ) : live && !device.online ? (
              <p>设备离线，没有画面。无法确定电脑上的操作者。</p>
            ) : live ? (
              <>
                <div className="document-address">{device.short} / {task.folder || "旅行资料"} / 镰仓行程.md</div>
                <div className="document-tools" aria-hidden="true">正文 · 14　 B　 I　 U　 ≡</div>
                <article className="document-preview">
                  <h3>镰仓一日游 · 行程草稿</h3>
                  <span className="document-label">上午</span>
                  <ul><li>08:30 从东京出发</li><li>10:00 由比滨海边散步</li><li>11:00 长谷寺与海景</li></ul>
                  <span className="document-label">下午</span>
                  <ul><li>12:00 午餐与休息</li><li>13:30 小町通、咖啡与摄影</li><li>16:30 整理返程安排</li></ul>
                  {(task.edits || []).map((line, i) => <p key={i} className="typed">你的修改：{line}</p>)}
                </article>
                <small className="muted">模拟文档 · {TASK_STEPS[Math.min(task.step, TASK_STEPS.length - 1)]}</small>
              </>
            ) : (
              <p>没有进行中的画面</p>
            )}
          </div>
        </div>
        {acting && <Reason>你正在查看，不代表你有输入控制。同一时间只有一位操作者。每一步约 8 秒，继续前都会重新检查授权、来源会话与设备。</Reason>}

        {pendingStop && !task.stopUnconfirmed && (
          <Notice tone="pause">
            已请求{intent}，等待电脑侧确认 Agent 停止输入。收到确认前，
            {task.stopIntent === "takeover" ? "你还没有取得控制。" : task.stopIntent === "end" ? "任务尚未结束，电脑控制尚未释放。" : "任务尚未确认停止。"}
          </Notice>
        )}
        {pendingStop && task.stopUnconfirmed && (
          <Notice
            tone="warn"
            action={
              <Btn small disabled={!device.online} reason="设备离线，请求无法送达" onClick={() => act("task/retryStop")}>
                <RotateCw size={13} aria-hidden="true" /> 重新请求确认
              </Btn>
            }
          >
            <strong>{intent}未确认。</strong>
            {device.online ? "设备已恢复在线，但尚未收到停止确认。" : "设备离线，无法确定操作者。"}
            已阻止新增操作与成果发布；
            {task.stopIntent === "end" ? "本次授权已失效，但电脑控制尚未确认释放。" : "这不代表 Agent 已停止，也不代表电脑已释放。"}
            设备可达并确认后才会完成，不会自动恢复执行。
          </Notice>
        )}
        {task.control === "returning" && <Notice tone="pause">正在检查原授权、来源会话、范围、文件改动与设备状态，通过后才交还给 Agent。</Notice>}
        {["stopping", "stopped", "ending"].includes(task.status) && task.reason && <Notice tone="warn">{task.reason}</Notice>}
        {task.status === "stopped" && (
          <Notice tone="info">
            设备已确认 Agent 停止。电脑仍由本任务占用；继续前会重新检查。
            {resumeBlock ? `当前不能继续：${resumeBlock}。` : ""}
          </Notice>
        )}
        {task.status === "done" && <Notice tone="ok">成果已发布到本私聊一次。电脑控制已释放，本次授权已失效。</Notice>}
        {task.status === "ended" && <Notice tone="info">设备已确认停止，电脑控制已释放。任务未产生成果文件；再次执行是一次新的尝试，需要重新授权。</Notice>}
        {["rejected", "cancelled", "expired"].includes(task.status) && <Notice tone="info">任务未产生成果文件。再次执行是一次新的尝试，需要重新授权。</Notice>}

        {human && (
          <form
            className="human-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (!typed.trim()) return;
              dispatch({ type: "task/input", taskId: task.id, text: typed.trim() });
              setTyped("");
            }}
          >
            <label htmlFor="human-input">你的输入（模拟）</label>
            <div>
              <input id="human-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="例如：把返程时间改为 16:30" />
              <Btn small variant="primary" type="submit" disabled={!typed.trim()}>输入</Btn>
            </div>
          </form>
        )}

        <ol className="steps">
          {TASK_STEPS.map((step, i) => {
            const done = i < task.step || task.status === "done";
            const current = live && i === task.step;
            return (
              <li key={step} className={done ? "done" : current ? "current" : ""}>
                {done ? <Check size={15} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />}
                <span>{step}</span>
                {done && <small>完成</small>}
                {current && <small>{acting ? "进行中" : pendingStop ? "停止待确认" : "已停住"}</small>}
              </li>
            );
          })}
        </ol>

        <div className="task-controls">
          {acting && (
            <>
              <Btn variant="primary" onClick={() => act("task/takeover")}>请求接管</Btn>
              <Btn onClick={() => act("task/pause")}>暂停本任务</Btn>
              <Btn variant="text" onClick={() => dispatch({ type: "task/tick", taskId: task.id, token: task.token })}>演示：立即进入下一步</Btn>
            </>
          )}
          {human && <Btn variant="primary" onClick={() => act("task/return")}>交还控制</Btn>}
          {task.status === "stopped" && (
            <Btn variant="primary" disabled={Boolean(resumeBlock)} reason={resumeBlock || undefined} onClick={() => act("task/recheck")}>重新检查并继续</Btn>
          )}
          {live && task.status !== "ending" && <Btn variant="danger" onClick={() => act("task/end")}>结束任务</Btn>}
          {pendingStop && (
            <Btn variant="text" disabled={!device.online} reason="设备离线，收不到确认" onClick={() => act("sim/deviceStopAck")}>
              模拟设备事件：电脑确认 Agent 已停止
            </Btn>
          )}
        </div>
        {acting && <Reason>「演示：立即进入下一步」只跳过等待时间，仍会执行同样的检查；来源会话冻结或设备异常时不会前进。</Reason>}
        {pendingStop && <Reason>「模拟设备事件」代表电脑侧发回的确认，不是你的操作；设备离线时不会生效。</Reason>}
        {human && <Reason>关闭面板不会自动交还控制，需要明确交还或结束任务。</Reason>}

        <h3>本次授权</h3>
        <KV
          rows={[
            ["执行 Agent", `${nameOf(state, task.agentId)}（主人：你）`],
            ["授权状态", GRANT[task.grant]],
            ["电脑控制", !live ? "已释放" : held ? (pendingStop && task.stopIntent === "end" ? "尚未确认释放" : "由本任务独占") : "未占用"],
            ["允许", TASK_SCOPE.allow.join("；")],
            ["不允许", TASK_SCOPE.deny.join("；")],
            ["结果去向", TASK_SCOPE.result],
          ]}
        />
        <Reason>只有设备与执行 Agent 的主人可以查看、接管或结束。其他成员看不到电脑画面。来源会话冻结时任务停止，成果不会发布。</Reason>
      </div>
    </div>
  );
}
