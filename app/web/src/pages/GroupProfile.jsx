import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import {
  convTitle,
  agentsIn,
  humansIn,
  viewerOwners,
  nameOf,
  ownerOf,
  isAgent,
  isMine,
  publishBlock,
  myBlock,
  blocksFor,
} from "../state/selectors.js";
import { Avatar, ConvAvatar, Tag, Btn, Notice, Reason, IdentityLine, KV } from "../ui/primitives.jsx";
import { Pills } from "./ChatList.jsx";
import { BlockModal } from "./BlockModal.jsx";
import { ChevronLeft, CirclePause } from "../icons.js";

function Members({ conv }) {
  const { state, dispatch } = useStore();
  const [blockTarget, setBlockTarget] = useState(null);
  const admin = conv.admin === ME;
  const owners = viewerOwners(state, conv);
  return (
    <>
      <h3>发言成员</h3>
      <ul className="member-rows">
        {conv.members.map((id) => {
          const agent = isAgent(state, id);
          const mine = isMine(state, id);
          const blocked = agent && myBlock(state, id);
          return (
            <li key={id}>
              <Avatar id={id} size={44} />
              <div className="member-body">
                <IdentityLine id={id} extra={conv.cutoffs[id] ? <Tag tone="muted">仅见 {conv.cutoffs[id]} 之后</Tag> : null} />
                <p className="muted">
                  {agent
                    ? "由其主人管理"
                    : id === conv.admin
                      ? "群管理员"
                      : "真人成员"}
                </p>
              </div>
              <div className="member-actions">
                {mine && <Btn small onClick={() => dispatch({ type: "group/remove", convId: conv.id, memberId: id })}>撤回我的 Agent</Btn>}
                {agent && !mine && (
                  <Btn small onClick={() => setBlockTarget(id)}>{blocked ? "解除拉黑" : "拉黑此 Agent"}</Btn>
                )}
                {!mine && id !== ME && (
                  <Btn small disabled={!admin} reason="只有群管理员可以移除成员" onClick={() => dispatch({ type: "group/remove", convId: conv.id, memberId: id })}>
                    移除
                  </Btn>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <h3>可见主人</h3>
      <ul className="member-rows">
        {owners.map((id) => (
          <li key={id}>
            <Avatar id={id} size={44} />
            <div className="member-body">
              <IdentityLine id={id} />
              <p className="muted">
                因 {agentsIn(state, conv).filter((a) => ownerOf(state, a) === id).map((a) => nameOf(state, a)).join("、")} 参与而可查看相关消息与附件；不含其他私聊、电脑画面或文件。
              </p>
            </div>
          </li>
        ))}
      </ul>
      <Reason>旁观主人不计入发言成员数。撤回自己的 Agent 立即生效，不会被其他人否决；成员变化后本群会暂停并需重新检查。</Reason>
      {blockTarget && <BlockModal target={blockTarget} onClose={() => setBlockTarget(null)} />}
    </>
  );
}

function GroupSettings({ conv }) {
  const { state, dispatch } = useStore();
  const block = publishBlock(state, conv);
  const blocks = blocksFor(state, conv);
  return (
    <>
      <h3>发布状态</h3>
      {block ? <Notice tone="pending">{block.text}</Notice> : <Notice tone="ok">本群可正常发布新消息。</Notice>}
      <KV
        rows={[
          ["群管理员", nameOf(state, conv.admin)],
          ["拉黑冲突", blocks.length ? blocks.map((b) => `${b.by === ME ? "你" : nameOf(state, b.by)} → ${nameOf(state, b.target)}`).join("；") : "无"],
        ]}
      />
      <h3>我的操作</h3>
      <div className="stack-actions">
        <div>
          <Btn variant="danger" onClick={() => dispatch({ type: "group/exit", convId: conv.id })}>退出本群</Btn>
          <Reason>退出后你和你的 Agent 停止接收新内容；已取得的历史不承诺被远端抹除。</Reason>
        </div>
      </div>
    </>
  );
}

export function GroupProfile({ conv }) {
  const { state, dispatch } = useStore();
  const tab = state.nav.profileTab;
  const agents = agentsIn(state, conv).length;
  const humans = humansIn(state, conv).length;
  return (
    <section className="page profile" aria-label="群资料">
      <button type="button" className="back" onClick={() => dispatch({ type: "nav", patch: { view: "chat" } })}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回群聊
      </button>
      <header className="profile-head">
        <ConvAvatar conv={conv} size={84} />
        <div>
          <p className="eyebrow">群资料</p>
          <h2>
            {convTitle(state, conv)}
            {publishBlock(state, conv) && <Tag tone="pending"><CirclePause size={13} aria-hidden="true" /> 已冻结</Tag>}
          </h2>
          <p className="muted">
            当前：{humans > 0 ? `${humans} 位真人 · ` : ""}{agents} 个 Agent · {viewerOwners(state, conv).length} 位主人
          </p>
        </div>
      </header>
      <Pills
        label="群资料分区"
        value={tab}
        onChange={(id) => dispatch({ type: "nav", patch: { profileTab: id } })}
        options={[
          ["members", "群成员"],
          ["settings", "群设置"],
        ]}
      />
      <div className="page-body">
        {tab === "members" && <Members conv={conv} />}
        {tab === "settings" && <GroupSettings conv={conv} />}
      </div>
    </section>
  );
}
