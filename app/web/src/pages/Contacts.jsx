import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { isAgent, isMine, nameOf, ownerOf, entity, relation, myBlock, isPrivateType } from "../state/selectors.js";
import { Avatar, Tag, Btn, IconBtn, Notice, Reason, KV, Field } from "../ui/primitives.jsx";
import { ListHeader, SearchBox, Pills } from "./ChatList.jsx";
import { BlockModal, sharedConvs } from "./BlockModal.jsx";
import { ChevronLeft, UserPlus } from "../icons.js";

const REL = {
  established: ["已建立", "ok"],
  pending: ["待对方确认", "pending"],
  incoming: ["待你确认", "pending"],
  rejected: ["已拒绝", "warn"],
  withdrawn: ["已撤回", "muted"],
  expired: ["已过期", "muted"],
  removed: ["已解除", "muted"],
};

function mySubjects(state) {
  return [ME, ...Object.values(state.agents).filter((a) => a.ownerId === ME).map((a) => a.id)];
}

// Relations between any of my identities and the given target.
function relationsWith(state, target) {
  const mine = mySubjects(state);
  return Object.entries(state.relations)
    .map(([key, rel]) => {
      const [a, b] = key.split("|");
      const subject = mine.includes(a) && b === target ? a : mine.includes(b) && a === target ? b : null;
      return subject ? { key, rel, subject, initiatedByMe: a === subject } : null;
    })
    .filter(Boolean);
}

function findConv(state, a, b) {
  return Object.values(state.convs).find((c) => c.members.length === 2 && c.members.includes(a) && c.members.includes(b) && isPrivateType(c.type));
}

// Other people, their Agents, then my own Agents (so two of my Agents can be
// connected with a single owner confirmation).
function directory(state) {
  const people = Object.keys(state.people).filter((id) => id !== ME);
  const all = Object.values(state.agents);
  return [...people, ...all.filter((a) => a.ownerId !== ME).map((a) => a.id), ...all.filter((a) => a.ownerId === ME).map((a) => a.id)];
}

export function ContactsList() {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const q = query.trim().toLowerCase();
  const open = (id) => dispatch({ type: "nav", patch: { contactId: id, pane: "main" } });
  const rows = directory(state)
    .filter((id) => (filter === "people" ? !isAgent(state, id) : filter === "agents" ? isAgent(state, id) : true))
    .filter((id) => {
      const e = entity(state, id);
      return !q || e.name.toLowerCase().includes(q) || e.handle.toLowerCase().includes(q);
    });
  const requests = rows.flatMap((id) => relationsWith(state, id).filter((r) => ["pending", "incoming"].includes(r.rel.status)).map((r) => ({ ...r, target: id })));

  return (
    <>
      <ListHeader
        title="通讯录"
        action={
          <IconBtn label="添加好友或 Agent" className="boxed" onClick={() => {setQuery("");setFilter("all");document.querySelector(".list-col .search input")?.focus();}}>
            <UserPlus size={20} />
          </IconBtn>
        }
      />
      <SearchBox value={query} onChange={setQuery} placeholder="搜索名字或账号，添加好友、Agent" />
      <Pills
        label="联系人筛选"
        value={filter}
        onChange={setFilter}
        options={[
          ["all", "全部"],
          ["people", "真人"],
          ["agents", "Agent"],
        ]}
      />
      <ul className="rows">
        {requests.length > 0 && <li className="rows-label">待处理的申请</li>}
        {requests.map((r) => (
          <li key={r.key}>
            <button type="button" className="row" onClick={() => open(r.target)}>
              <Avatar id={r.target} size={48} />
              <span className="row-body">
                <span className="row-top">
                  <span className="row-name">{nameOf(state, r.target)}</span>
                  <Tag tone="pending">{REL[r.rel.status][0]}</Tag>
                </span>
                <span className="row-sub">
                  <span className="row-preview">
                    {r.rel.status === "incoming" ? `申请联系 ${nameOf(state, r.subject)}` : `以「${nameOf(state, r.subject)}」的身份申请`}
                  </span>
                </span>
              </span>
            </button>
          </li>
        ))}
        <li className="rows-label">联系人与 Agent</li>
        {rows.map((id) => {
          const rel = relation(state, ME, id);
          const agent = isAgent(state, id);
          return (
            <li key={id}>
              <button type="button" className={`row ${state.nav.contactId === id ? "active" : ""}`} onClick={() => open(id)}>
                <Avatar id={id} size={48} />
                <span className="row-body">
                  <span className="row-top">
                    <span className="row-name">{nameOf(state, id)}</span>
                    {agent ? <Tag>Agent</Tag> : <Tag tone="human">真人</Tag>}
                  </span>
                  <span className="row-sub">
                    <span className="row-preview">
                      {agent ? `主人：${nameOf(state, ownerOf(state, id))} · ` : ""}
                      {isMine(state, id) ? "我的 Agent" : rel ? REL[rel.status][0] : "未添加"}
                      {myBlock(state, id) ? " · 已拉黑" : ""}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {rows.length === 0 && <li className="rows-empty">没有找到匹配的联系人或 Agent</li>}
      </ul>
    </>
  );
}

export function ContactCard() {
  const { state, dispatch } = useStore();
  const id = state.nav.contactId;
  const who = entity(state, id);
  const [picked, setSubject] = useState(ME);
  const [blockOpen, setBlockOpen] = useState(false);
  if (!who || id === ME) return <div className="empty-main">选择一位联系人或 Agent</div>;
  const agent = isAgent(state, id);
  const own = isMine(state, id);
  const owner = ownerOf(state, id);
  const rels = relationsWith(state, id);
  // My own Agent as target: only my other Agents can be connected to it (I already have its private chat).
  const subjects = mySubjects(state).filter((s) => s !== id && !(own && s === ME));
  const subject = subjects.includes(picked) ? picked : subjects[0] || ME;
  const current = rels.find((r) => r.subject === subject);
  const blocked = own ? null : myBlock(state, id);
  const active = current && ["pending", "incoming", "established"].includes(current.rel.status);
  // Agent of mine ↔ a human who is not me: an owner-observed private chat, no auto-discussion.
  const observed = !agent && subject !== ME;
  const applyReason = !subjects.length
    ? "你没有其他 Agent 可以与它建立联系"
    : blocked
      ? "你已拉黑这个 Agent，需先解除拉黑"
      : current?.rel.status === "established"
        ? "该身份已与对方建立联系"
        : active
          ? "已有待处理的申请，不会重复发送"
          : "";
  const openConv = (a) => {
    const conv = findConv(state, a, id);
    if (conv) dispatch({ type: "nav/openConv", convId: conv.id });
    else dispatch({ type: "toast", text: "会话尚未创建" });
  };
  const viewers = own
    ? `仅你（双方唯一的主人）与这两个 Agent`
    : agent
      ? `申请的真人或 Agent、${who.name}、其主人${nameOf(state, owner)}${subject !== ME ? "，以及你（作为主人）" : ""}`
      : subject === ME
        ? `你与${who.name}两位真人`
        : `${nameOf(state, subject)}（Agent）、你（作为主人，可查看并插话）与${who.name}`;

  return (
    <section className="page" aria-label="联系人卡片">
      <button type="button" className="back only-mobile" onClick={() => dispatch({ type: "nav", patch: { pane: "list" } })}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回通讯录
      </button>
      <header className="profile-head">
        <Avatar id={id} size={84} />
        <div>
          <p className="eyebrow">{agent ? "Agent 卡片" : "联系人卡片"}</p>
          <h2>
            {who.name} {agent ? <Tag>Agent</Tag> : <Tag tone="human">真人</Tag>} {blocked && <Tag tone="warn">已拉黑</Tag>}
          </h2>
          <p className="muted">
            {who.handle}
            {agent ? ` · 主人：${nameOf(state, owner)}` : ""}
          </p>
        </div>
      </header>
      <div className="page-body">
        {agent && <p className="lead">{who.intro}</p>}
        <KV
          rows={[
            ["身份", own ? "Agent · 由你拥有并管理" : agent ? `Agent · 由${nameOf(state, owner)}拥有并管理（只读）` : "真人账户"],
            ["这段会话谁能看", viewers],
            ["主人可见范围", agent || observed ? "仅该 Agent 参与的这段会话的消息与附件，不含其他私聊、电脑或文件" : "不适用"],
            ["不随关系获得", agent ? "对方电脑、其他会话和整个资料库" : "对方的 Agent、文件与电脑"],
          ]}
        />

        <h3>联系与申请</h3>
        {rels.length === 0 && <p className="muted">你的任何身份都还没有与对方建立联系。</p>}
        <ul className="rel-rows">
          {rels.map((r) => {
            const [label, tone] = REL[r.rel.status];
            return (
              <li key={r.key}>
                <Avatar id={r.subject} size={36} />
                <div className="member-body">
                  <strong>
                    {r.initiatedByMe ? `${nameOf(state, r.subject)} → ${who.name}` : `${who.name} → ${nameOf(state, r.subject)}`}
                  </strong>
                  <p className="muted">
                    {r.rel.status === "incoming"
                      ? `对方发起 · ${r.rel.at} · 需要你（${r.subject === ME ? "本人" : "主人"}）确认 · 24 小时内有效`
                      : r.rel.status === "pending"
                        ? `你发起 · ${r.rel.at} · 等待${agent ? `${who.name}的主人${nameOf(state, owner)}` : who.name}确认 · 24 小时内有效`
                        : r.rel.status === "established"
                          ? own
                            ? "同一主人：你已作为唯一主人确认一次；不自动开始讨论，不授予工具或电脑"
                            : !agent && r.subject !== ME
                              ? "关系已建立：Agent 与真人的私聊，你作为主人可查看并插话；不支持自动讨论"
                              : "关系已建立；不自动开始讨论，不授予工具或电脑"
                          : "本次申请未生效，可重新申请"}
                  </p>
                </div>
                <Tag tone={tone}>{label}</Tag>
                <div className="member-actions">
                  {r.rel.status === "pending" && <Btn small onClick={() => dispatch({ type: "rel/withdraw", key: r.key })}>撤回</Btn>}
                  {r.rel.status === "incoming" && (
                    <>
                      <Btn small variant="primary" onClick={() => dispatch({ type: "rel/accept", key: r.key })}>同意</Btn>
                      <Btn small onClick={() => dispatch({ type: "rel/reject", key: r.key })}>拒绝</Btn>
                    </>
                  )}
                  {r.rel.status === "established" && (
                    <>
                      <Btn small variant="primary" onClick={() => openConv(r.subject)}>{r.subject === ME ? "发消息" : "打开会话"}</Btn>
                      {r.subject === ME && <Btn small onClick={() => dispatch({ type: "rel/remove", target: id })}>{agent ? "解除联系" : "解除好友"}</Btn>}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="apply-box">
          <Field
            label={own ? "让我的哪个 Agent 与它建立联系" : "以谁的身份申请"}
            hint={own ? "两个 Agent 都属于你：你是唯一需要确认的人，点击即确认一次并立即生效，不会等待任何外部回应。" : "只能以你本人或你拥有的 Agent 发起。接收方会看到双方主体、主人和可见人。"}
          >
            <select value={subject} onChange={(e) => setSubject(e.target.value)}>
              {subjects.map((s) => (
                <option key={s} value={s}>
                  {s === ME ? "我本人" : `${nameOf(state, s)}（我的 Agent）`}
                </option>
              ))}
            </select>
          </Field>
          <Btn variant="primary" disabled={Boolean(applyReason)} reason={applyReason} onClick={() => dispatch({ type: "rel/apply", subject, target: id })}>
            <UserPlus size={16} aria-hidden="true" /> {own ? "作为唯一主人确认并建立联系" : agent ? "申请联系这个 Agent" : subject === ME ? "添加好友" : "申请联系"}
          </Btn>
          <Reason>{applyReason}</Reason>
          {observed && !applyReason && (
            <Reason>对方确认后会建立「{nameOf(state, subject)} 与 {who.name}」的私聊：你作为主人可查看并以本人身份插话。它不是 Agent 之间的会话，不支持自动讨论。</Reason>
          )}
        </div>

        {agent && !own && (
          <>
            <h3>拉黑</h3>
            {blocked ? (
              <Notice tone="warn" action={<Btn small onClick={() => setBlockOpen(true)}>解除拉黑</Btn>}>
                你已拉黑{who.name}：你本人及你的 Agent 不再与它产生新的直接互动。
                {sharedConvs(state, id).length > 0 && " 共同会话已冻结，解除后也需手动恢复。"}
              </Notice>
            ) : (
              <div className="stack-actions">
                <Btn variant="danger" onClick={() => setBlockOpen(true)}>拉黑此 Agent</Btn>
                <Reason>只针对这个 Agent，不会拉黑其主人或该主人的其他 Agent。</Reason>
              </div>
            )}
          </>
        )}
      </div>
      {blockOpen && <BlockModal target={id} onClose={() => setBlockOpen(false)} />}
    </section>
  );
}
