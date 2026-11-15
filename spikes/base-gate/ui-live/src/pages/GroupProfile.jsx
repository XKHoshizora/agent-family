import React, { useState } from "react";
import { useStore } from "../state/store.jsx";
import { ME, PEOPLE } from "../data/identities.js";
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
  canManage,
  requiredApprovers,
  rolesInPlan,
  myBlock,
  blocksFor,
  uniq,
} from "../state/selectors.js";
import { Avatar, ConvAvatar, Tag, Btn, Notice, Reason, IdentityLine, Field, KV } from "../ui/primitives.jsx";
import { Pills } from "./ChatList.jsx";
import { BlockModal } from "./BlockModal.jsx";
import { FreezeNotice } from "./Recovery.jsx";
import { ChevronLeft, Info, CirclePause } from "../icons.js";

const APPROVAL = { pending: ["待确认", "pending"], approved: ["已确认", "ok"], rejected: ["已拒绝", "warn"] };
const EXP_STATUS = {
  pending: ["扩员待确认", "pending"],
  approved: ["已加入生效", "ok"],
  rejected: ["已被拒绝", "warn"],
  withdrawn: ["已撤回", "muted"],
  expired: ["已过期", "muted"],
};

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
                    ? `${state.agents[id].paused ? "已暂停全部会话" : conv.myPause && mine ? "你已在本会话暂停它" : "群内被 @ 时回复"} · 由其主人管理`
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

function Expansion({ conv }) {
  const { state, dispatch } = useStore();
  const [agree, setAgree] = useState(false);
  const [candidate, setCandidate] = useState("");
  const e = conv.expansion;
  const pending = e?.status === "pending";
  const block = publishBlock(state, conv);
  const candidates = [...Object.keys(PEOPLE), ...Object.keys(state.agents)].filter((id) => !conv.members.includes(id) && (conv.type === "mixed" || isAgent(state, id)));
  const ownersNow = viewerOwners(state, conv);
  const plan = pending ? e.candidate : candidate;
  const ownersAfter = plan ? uniq([...ownersNow, ...(isAgent(state, plan) ? [ownerOf(state, plan)] : [])]) : ownersNow;
  const names = (ids) => ids.map((id) => nameOf(state, id)).join("、");
  const myVote = pending ? e.approvals[ME] : null;

  return (
    <>
      <h3>当前群成员</h3>
      <ul className="member-rows compact">
        {conv.members.map((id) => (
          <li key={id}>
            <Avatar id={id} size={36} />
            <IdentityLine id={id} />
          </li>
        ))}
      </ul>

      <h3>扩员申请</h3>
      {e && (
        <div className="exp-block">
          <div className="exp-candidate">
            <Avatar id={e.candidate} size={40} />
            <IdentityLine id={e.candidate} extra={<Tag tone={EXP_STATUS[e.status][1]}>{e.status === "pending" ? "拟加入" : EXP_STATUS[e.status][0]}</Tag>} />
          </div>
          <p className="exp-meta">
            成员方案 v{e.version} · 有效期 24 小时 · 发起人：{nameOf(state, e.initiator)}
            {e.joinedAt ? ` · 加入生效时间 ${e.joinedAt}` : ""}
          </p>
          <ul className="approvals">
            {Object.entries(e.approvals).map(([id, v]) => (
              <li key={id}>
                <Avatar id={id} size={36} />
                <span>
                  <strong>{nameOf(state, id)}</strong>
                  <small>{rolesInPlan(state, conv, e.candidate, id).join(" · ") || "相关主人"}</small>
                </span>
                <Tag tone={APPROVAL[v][1]}>{APPROVAL[v][0]}</Tag>
              </li>
            ))}
          </ul>
          <ul className="info-lines">
            <li><Info size={15} aria-hidden="true" /> 同一位真人只确认一次，界面列出其全部角色；群管理员身份不能代替这些确认。</li>
            <li><Info size={15} aria-hidden="true" /> 范围：仅加入生效后的新消息；旧附件与摘要不会自动开放。</li>
            <li><Info size={15} aria-hidden="true" /> 名单改变，原确认失效；任一拒绝、撤回或过期则本次不生效，可按原名单发起恢复确认。</li>
            <li><Info size={15} aria-hidden="true" /> 方案结束后本群不会一键恢复：需由届时名单中所有必需的人确认新的摘要、目标与剩余轮次。</li>
          </ul>
        </div>
      )}
      {!e && <p className="muted">暂无扩员申请。</p>}

      {block && <FreezeNotice conv={conv} />}

      {!pending && (
        <div className="exp-new">
          <Field label="发起新的扩员方案" hint="提交后立即冻结本群新增消息、附件与讨论，直到方案结束并手动恢复。">
            <select value={candidate} onChange={(ev) => setCandidate(ev.target.value)}>
              <option value="">选择要加入的成员</option>
              {candidates.map((id) => (
                <option key={id} value={id}>
                  {nameOf(state, id)}{isAgent(state, id) ? `（Agent · 主人：${nameOf(state, ownerOf(state, id))}）` : "（真人）"}
                </option>
              ))}
            </select>
          </Field>
          {candidate && <p className="muted">需要确认的人：{names(requiredApprovers(state, conv, candidate))}</p>}
          <Btn variant="primary" disabled={!candidate} reason="请先选择成员" onClick={() => (dispatch({ type: "exp/propose", convId: conv.id, candidate }), setCandidate(""))}>
            提交扩员方案
          </Btn>
        </div>
      )}

      <h3>可见范围变化</h3>
      <KV
        rows={[
          ["当前可查看的主人", names(ownersNow)],
          ["生效后可查看的主人", plan ? names(ownersAfter) : "—"],
          ["新成员与新主人可见历史", "仅加入生效后的新消息"],
          ["设备与文件", "入群不授予任何电脑、文件或工具权限"],
        ]}
      />

      {pending && (
        <div className="exp-footer">
          <label className="check">
            <input type="checkbox" checked={agree} disabled={myVote !== "pending"} onChange={(ev) => setAgree(ev.target.checked)} />
            <span>我同意本次成员与可见范围变更</span>
          </label>
          <span className="spacer" />
          {e.initiator === ME ? (
            <Btn onClick={() => dispatch({ type: "exp/withdraw", convId: conv.id })}>撤回我的方案</Btn>
          ) : (
            <span className="muted">发起人{nameOf(state, e.initiator)}可撤回</span>
          )}
          {myVote === "pending" ? (
            <>
              <Btn onClick={() => dispatch({ type: "exp/reject", convId: conv.id })}>拒绝本次扩员</Btn>
              <Btn variant="primary" disabled={!agree} reason="请先勾选同意" onClick={() => (dispatch({ type: "exp/approve", convId: conv.id }), setAgree(false))}>
                确认扩员
              </Btn>
            </>
          ) : (
            <span className="muted">你已确认，等待其他人各自确认（你不能替别人确认）</span>
          )}
        </div>
      )}
    </>
  );
}

function GroupSettings({ conv }) {
  const { state, dispatch } = useStore();
  const block = publishBlock(state, conv);
  const blocks = blocksFor(state, conv);
  const mine = conv.members.filter((id) => isMine(state, id));
  return (
    <>
      <h3>发布状态</h3>
      {block ? (
        <FreezeNotice conv={conv} />
      ) : (
        <Notice tone="ok">本群可正常发布新消息。</Notice>
      )}
      <KV
        rows={[
          ["群管理员", nameOf(state, conv.admin)],
          ["成员方案版本", `v${conv.expansion?.status === "pending" ? conv.expansion.version : conv.version}`],
          ["主人可见状态", conv.visibility === "down" ? "暂时不可用" : "正常"],
          ["拉黑冲突", blocks.length ? blocks.map((b) => `${b.by === ME ? "你" : nameOf(state, b.by)} → ${nameOf(state, b.target)}`).join("；") : "无"],
          ["Agent 回复方式", "各 Agent 由其主人分别管理；本群没有控制所有 Agent 的总开关"],
          ["设备与工具", "入群不等于好友、工具或设备授权"],
        ]}
      />
      <h3>我的操作</h3>
      <div className="stack-actions">
        {mine.length > 0 && (
          <div>
            <Btn onClick={() => dispatch({ type: "conv/toggleMyPause", convId: conv.id })}>{conv.myPause ? "恢复本会话中我的 Agent" : "暂停本会话中我的 Agent"}</Btn>
            <Reason>只影响本会话里你自己的 Agent（{mine.map((id) => nameOf(state, id)).join("、")}），不影响别人的 Agent 和其他会话。</Reason>
          </div>
        )}
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
  const e = conv.expansion;
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
            {convTitle(state, conv)} {e && <Tag tone={EXP_STATUS[e.status][1]}>{EXP_STATUS[e.status][0]}</Tag>}
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
          ["expansion", "扩员与可见范围"],
          ["settings", "群设置"],
        ]}
      />
      <div className="page-body">
        {tab === "members" && <Members conv={conv} />}
        {tab === "expansion" && <Expansion conv={conv} />}
        {tab === "settings" && <GroupSettings conv={conv} />}
      </div>
    </section>
  );
}
