import React from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { nameOf, entity } from "../state/selectors.js";
import { Avatar, Btn, Tag, Reason } from "../ui/primitives.jsx";
import { ListHeader } from "./ChatList.jsx";
import { ChevronLeft, Laptop, Monitor } from "../icons.js";

export function SettingsList() {
  const { state, dispatch } = useStore();
  const agents = Object.values(state.agents).filter((a) => a.ownerId === ME);
  const self = entity(state, ME) || { name: "", handle: "" };
  return (
    <>
      <ListHeader title="设置" />
      <div className="settings-me">
        <Avatar id={ME} size={56} online />
        <div>
          <strong>{self.name}</strong>
          <p className="muted">{self.handle} · 真人账户</p>
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
      </ul>
    </>
  );
}

export function SettingsMain() {
  const { state, dispatch } = useStore();
  const self = entity(state, ME) || { name: "", handle: "" };
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
          <h2>{self.name} <Tag tone="human">真人</Tag></h2>
          <p className="muted">{self.handle}</p>
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
      </div>
    </section>
  );
}
