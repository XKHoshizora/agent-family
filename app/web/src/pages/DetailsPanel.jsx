import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { convTitle, TYPE_LABEL, nameOf, otherMember } from "../state/selectors.js";
import { blockedMe, iBlocked } from "../state/social.js";
import { Avatar, ConvAvatar, IdentityLine, IconBtn, Btn, Tag, KV, Reason } from "../ui/primitives.jsx";
import { BlockModal } from "./BlockModal.jsx";
import { X } from "../icons.js";

export function DetailsPanel({ conv }) {
  const { state, dispatch } = useStore();
  const other = otherMember(conv);
  const group = conv.type === "group";
  const [blockOpen, setBlockOpen] = useState(false);
  const blocked = !group && iBlocked(state, other);
  const blockedByThem = !group && blockedMe(state, other);
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
        <KV rows={[["谁能看", conv.members.map((id) => nameOf(state, id)).join("、")]]} />

        <h3>操作</h3>
        <div className="stack-actions">
          {group && <Btn onClick={() => dispatch({ type: "nav", patch: { view: "profile", profileTab: "members", detailsOpen: false } })}>打开群资料</Btn>}
          {conv.type === "human" && <Btn onClick={() => go({ section: "contacts", contactId: other })}>查看联系人卡片</Btn>}
          {conv.type === "human" && (
            <Btn variant={blocked ? "ghost" : "danger"} onClick={() => setBlockOpen(true)}>{blocked ? "解除我的拉黑" : "拉黑此用户"}</Btn>
          )}
          {conv.type === "human" && blockedByThem && <Reason>对方拉黑了你，只能由对方解除。</Reason>}
        </div>
      </div>
      {blockOpen && <BlockModal target={other} onClose={() => setBlockOpen(false)} />}
    </div>
  );
}
