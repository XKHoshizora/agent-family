import React from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { nameOf, entity } from "../state/selectors.js";
import { Avatar, Btn, Tag } from "../ui/primitives.jsx";
import { ListHeader } from "./ChatList.jsx";
import { ChevronLeft } from "../icons.js";
import { useSession } from "../auth/AuthRoot.jsx";

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
            <span className="row-body"><span className="row-name">我的资料</span><span className="row-preview">身份与拉黑管理</span></span>
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
  const session = useSession();
  const signOut = async () => {
    const result = await session.signOut();
    if (!result.ok) dispatch({ type: "toast", text: "退出登录失败，请检查网络后重试" });
  };
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
        {session && (
          <>
            <h3>账户</h3>
            <div>
              <Btn variant="danger" onClick={signOut}>退出登录</Btn>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
