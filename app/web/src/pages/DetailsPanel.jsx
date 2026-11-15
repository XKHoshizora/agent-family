import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import {
  convTitle,
  TYPE_LABEL,
  viewerOwners,
  humansIn,
  isAgent,
  isMine,
  nameOf,
  ownerOf,
  otherMember,
  myBlock,
} from "../state/selectors.js";
import { Avatar, ConvAvatar, IdentityLine, IconBtn, Btn, Tag, Reason, KV } from "../ui/primitives.jsx";
import { BlockModal } from "./BlockModal.jsx";
import { X } from "../icons.js";

const NOT_GRANTED = {
  observed: "自动讨论、对方的 Agent、文件与电脑",
  human: "对方的 Agent、文件与电脑",
  agent: "其他会话、文件夹与电脑",
  pair: "彼此的工具、记忆、资料库与电脑",
  mixed: "好友关系、工具或设备授权",
  agentGroup: "电脑共享或私聊历史",
};

export function DetailsPanel({ conv }) {
  const { state, dispatch } = useStore();
  const [blockTarget, setBlockTarget] = useState(null);
  const owners = viewerOwners(state, conv);
  const other = otherMember(conv);
  const group = conv.type === "mixed" || conv.type === "agentGroup";
  const viewers = [...new Set([...humansIn(state, conv), ...owners])];
  const go = (patch) => dispatch({ type: "nav", patch: { pane: "main", ...patch } });

  return (
    <div className="side">
      <header className="side-head">
        <h2>会话资料</h2>
        <IconBtn label="关闭" onClick={() => dispatch({ type: "nav", patch: { detailsOpen: false } })}><X size={18} /></IconBtn>
      </header>
      <div className="side-body">
        <div className="side-hero">
          <ConvAvatar conv={conv} size={64} />
          <strong>{convTitle(state, conv)}</strong>
          <Tag tone="solid">{TYPE_LABEL[conv.type]}</Tag>
        </div>

        <h3>发言成员</h3>
        <ul className="side-list">
          {conv.members.map((id) => (
            <li key={id}>
              <Avatar id={id} size={36} />
              <IdentityLine id={id} />
            </li>
          ))}
        </ul>
        {owners.length > 0 && (
          <>
            <h3>可见主人</h3>
            <ul className="side-list">
              {owners.map((id) => (
                <li key={id}>
                  <Avatar id={id} size={36} />
                  <IdentityLine id={id} extra={id === ME ? <span className="owner">可用本人身份插话</span> : null} />
                </li>
              ))}
            </ul>
          </>
        )}
        <KV
          rows={[
            ["谁能看", viewers.map((id) => nameOf(state, id)).join("、") + (owners.length ? "，及参与的 Agent" : "")],
            ["主人可见范围", owners.length ? "该 Agent 合法参与期间，本会话中各方的消息与附件；不含加入前历史" : "不适用"],
            ["不随关系获得", NOT_GRANTED[conv.type]],
          ]}
        />

        <h3>操作</h3>
        <div className="stack-actions">
          {group && <Btn onClick={() => dispatch({ type: "nav", patch: { view: "profile", profileTab: "members", detailsOpen: false } })}>打开群资料</Btn>}
          {conv.type === "human" && <Btn onClick={() => go({ section: "contacts", contactId: other })}>查看联系人卡片</Btn>}
          {conv.type === "agent" && isMine(state, other) && (
            <>
              <Btn onClick={() => go({ section: "agents", agentId: other, agentView: "detail", agentTab: "profile" })}>管理这个 Agent</Btn>
              <Btn onClick={() => go({ section: "agents", agentId: other, agentView: "detail", agentTab: "ability" })}>能力与设备</Btn>
            </>
          )}
          {conv.type === "agent" && !isMine(state, other) && (
            <>
              <Btn onClick={() => go({ section: "contacts", contactId: other })}>查看 Agent 卡片</Btn>
              <Btn onClick={() => setBlockTarget(other)}>{myBlock(state, other) ? "解除拉黑" : "拉黑此 Agent"}</Btn>
              <Reason>这个 Agent 由{nameOf(state, ownerOf(state, other))}管理。它的角色、电脑与任务你无法查看或更改；你只能决定自己这一侧的确认。</Reason>
            </>
          )}
          {conv.type !== "agent" &&
            conv.members
              .filter((id) => isAgent(state, id) && !isMine(state, id))
              .map((id) => (
                <Btn key={id} onClick={() => setBlockTarget(id)}>
                  {myBlock(state, id) ? `解除对${nameOf(state, id)}的拉黑` : `拉黑${nameOf(state, id)}`}
                </Btn>
              ))}
        </div>
      </div>
      {blockTarget && <BlockModal target={blockTarget} onClose={() => setBlockTarget(null)} />}
    </div>
  );
}
