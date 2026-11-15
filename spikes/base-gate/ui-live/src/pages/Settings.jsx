import React, { useState } from "react";
import { useStore, resetDemo } from "../state/store.jsx";
import { ME, PEOPLE } from "../data/identities.js";
import { nameOf } from "../state/selectors.js";
import { Avatar, Btn, KV, Modal, Notice, Tag, Reason } from "../ui/primitives.jsx";
import { ListHeader } from "./ChatList.jsx";
import { ChevronLeft, FlaskConical, RotateCw, Laptop, Monitor } from "../icons.js";

export function SettingsList() {
  const { state, dispatch } = useStore();
  const agents = Object.values(state.agents).filter((a) => a.ownerId === ME);
  return (
    <>
      <ListHeader title="设置" />
      <div className="settings-me">
        <Avatar id={ME} size={56} online />
        <div>
          <strong>{PEOPLE.me.name}</strong>
          <p className="muted">{PEOPLE.me.handle} · 真人账户</p>
        </div>
      </div>
      <ul className="rows">
        <li className="rows-label">快捷入口</li>
        <li>
          <button type="button" className="row slim" onClick={() => dispatch({ type: "nav", patch: { pane: "main" } })}>
            <span className="row-body"><span className="row-name">我的资料与设备</span><span className="row-preview">身份、设备归属与拉黑管理</span></span>
          </button>
        </li>
        <li>
          <button type="button" className="row slim" onClick={() => dispatch({ type: "nav", patch: { section: "agents", pane: "list" } })}>
            <span className="row-body"><span className="row-name">我的 Agent</span><span className="row-preview">{agents.map((a) => a.name).join("、")}</span></span>
          </button>
        </li>
        <li>
          <button type="button" className="row slim" onClick={() => dispatch({ type: "nav", patch: { section: "contacts", pane: "list" } })}>
            <span className="row-body"><span className="row-name">通讯录与申请</span><span className="row-preview">好友、他人的 Agent、待处理申请</span></span>
          </button>
        </li>
        <li>
          <button type="button" className="row slim" onClick={() => dispatch({ type: "nav", patch: { demoOpen: true } })}>
            <span className="row-body"><span className="row-name">演示状态</span><span className="row-preview">模拟对方确认、失败与设备异常</span></span>
          </button>
        </li>
      </ul>
      <p className="proto-label">交互原型 · 模拟数据</p>
    </>
  );
}

export function SettingsMain() {
  const { state, dispatch } = useStore();
  const [confirm, setConfirm] = useState(false);
  const mineBlocks = state.blocks.filter((b) => b.by === ME);
  return (
    <section className="page" aria-label="设置">
      <button type="button" className="back only-mobile" onClick={() => dispatch({ type: "nav", patch: { pane: "list" } })}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回
      </button>
      <header className="profile-head">
        <Avatar id={ME} size={84} online />
        <div>
          <p className="eyebrow">我的资料</p>
          <h2>{PEOPLE.me.name} <Tag tone="human">真人</Tag></h2>
          <p className="muted">{PEOPLE.me.handle}</p>
        </div>
      </header>
      <div className="page-body">
        <h3>设备与归属</h3>
        <ul className="device-rows static">
          {Object.values(state.devices).map((d) => (
            <li key={d.id}>
              <div className="device-static">
                {d.type === "virtual" ? <Monitor size={20} aria-hidden="true" /> : <Laptop size={20} aria-hidden="true" />}
                <span className="member-body">
                  <strong>{d.name}</strong>
                  <small>属于{nameOf(state, d.owner)}{d.owner === ME ? "" : " · 你没有分配或管理权限"}</small>
                </span>
                <Tag tone={!d.online ? "warn" : d.busy ? "pending" : "ok"}>{!d.online ? "离线" : d.busy ? "使用中" : "空闲"}</Tag>
              </div>
            </li>
          ))}
        </ul>
        <Reason>设备分配在「Agent → 能力与设备」中按 Agent 单独配置；跨主人不共享设备。</Reason>

        <h3>我的拉黑</h3>
        {mineBlocks.length === 0 ? (
          <p className="muted">你没有拉黑任何 Agent。</p>
        ) : (
          <ul className="member-rows">
            {mineBlocks.map((b) => (
              <li key={b.target}>
                <Avatar id={b.target} size={40} />
                <div className="member-body"><strong>{nameOf(state, b.target)}</strong><p className="muted">只有你可以解除自己的拉黑</p></div>
                <div className="member-actions">
                  <Btn small onClick={() => dispatch({ type: "nav", patch: { section: "contacts", contactId: b.target, pane: "main" } })}>查看</Btn>
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3>关于此原型</h3>
        <KV
          rows={[
            ["性质", "交互原型 · 模拟数据"],
            ["数据", "全部为本地示例；没有真实账号、模型调用或电脑操作"],
            ["保存", "仅保存在本浏览器，重置后回到初始示例"],
          ]}
        />
        <div className="stack-actions row-actions">
          <Btn onClick={() => dispatch({ type: "nav", patch: { demoOpen: true } })}><FlaskConical size={16} aria-hidden="true" /> 打开演示状态</Btn>
          <Btn variant="danger" onClick={() => setConfirm(true)}><RotateCw size={16} aria-hidden="true" /> 重置演示</Btn>
        </div>
      </div>
      {confirm && (
        <Modal
          title="重置演示"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Btn data-autofocus onClick={() => setConfirm(false)}>取消</Btn>
              <Btn variant="danger" onClick={() => (setConfirm(false), resetDemo(dispatch))}>重置</Btn>
            </>
          }
        >
          <p>将清除本原型在此浏览器中保存的示例状态，并回到初始场景。不会影响其他任何数据。</p>
          <Notice tone="info">只清除本原型自己的保存项。</Notice>
        </Modal>
      )}
    </section>
  );
}
