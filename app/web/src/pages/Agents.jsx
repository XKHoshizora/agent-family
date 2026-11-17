import React, { useEffect, useState } from "react";
import { useStore } from "../data/store.jsx";
import { Avatar, Tag, Btn, IconBtn, Notice, Reason, KV, Modal } from "../ui/primitives.jsx";
import { ListHeader, Pills } from "./ChatList.jsx";
import { AgentForm, openAgentChat, refusalText, settled } from "./AgentForm.jsx";
import { levelLabel, modelLabel } from "./ModelPicker.jsx";
import { useAction } from "./useAction.js";
import { Plus, ChevronLeft, Pencil, Pause, Play, Trash2 } from "../icons.js";

const createdAtOf = (agent) => {
  const ms = Date.parse(agent.createdAt ?? "");
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
};

/** My Agents in the list's order: oldest first, the deleted ones last. */
export function myAgents(state) {
  return Object.values(state.agents).sort((a, b) => Number(a.deleted) - Number(b.deleted) || createdAtOf(a) - createdAtOf(b));
}

/** The status tag of an Agent; none while its record is not loaded (its model is not known yet). */
function StatusTag({ agent, long = false }) {
  if (agent.deleted) return <Tag tone="muted">已删除</Tag>;
  if (agent.paused) return <Tag tone="pending">{long ? "已暂停全部会话" : "已暂停"}</Tag>;
  if (!agent.loaded) return null;
  if (!agent.model) return <Tag tone="warn">未选模型</Tag>;
  return <Tag tone="ok">可回复</Tag>;
}

/** The first characters of a long text, for a summary line. */
const excerpt = (text, max = 200) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};

export function AgentsList() {
  const { state, dispatch, actions } = useStore();
  const { nav } = state;
  const agents = myAgents(state);
  const unloaded = agents.some((a) => !a.loaded);
  // An Agent known only by name (its record not loaded, e.g. the list failed on this connection): asked for once more
  // when the page opens (only then: the connection loads the list by itself).
  useEffect(() => {
    if (unloaded) actions.loadAgents();
  }, []);
  return (
    <>
      <ListHeader
        title="我的 Agent"
        action={
          <IconBtn label="创建 Agent" className="boxed" onClick={() => dispatch({ type: "nav", patch: { agentView: "create", pane: "main" } })}>
            <Plus size={20} />
          </IconBtn>
        }
      />
      <p className="list-note">这里只列出你拥有的 Agent。</p>
      <ul className="rows">
        {agents.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className={`row ${nav.agentId === a.id && nav.agentView !== "create" ? "active" : ""}`}
              onClick={() => dispatch({ type: "nav", patch: { agentId: a.id, agentView: "detail", pane: "main" } })}
            >
              <Avatar id={a.id} size={48} />
              <span className="row-body">
                <span className="row-top">
                  <span className="row-name">{a.name}</span>
                  <StatusTag agent={a} />
                </span>
                <span className="row-sub">
                  <span className="row-preview">{a.loaded ? `${a.field || "未填写擅长领域"} · ${modelLabel(state, a.model) ?? "未选择模型"}` : "正在读取…"}</span>
                </span>
              </span>
            </button>
          </li>
        ))}
        {agents.length === 0 && <li className="rows-empty">还没有 Agent，点右上角的“+”创建一个</li>}
      </ul>
    </>
  );
}

function Conversations({ agent }) {
  const { state, dispatch, actions } = useStore();
  const id = agent.conversationId;
  return (
    <>
      <p className="muted">这是你和它的专属会话：只有你们两个成员，只包含其中的消息与附件。</p>
      <ul className="member-rows">
        {id ? (
          <li>
            <Avatar id={agent.id} size={44} />
            <div className="member-body">
              <strong>
                {agent.name} <Tag>Agent 私聊</Tag> {agent.deleted && <Tag tone="muted">只能查看</Tag>}
              </strong>
              <p className="muted">{agent.deleted ? "它已删除，聊天记录仍可查看" : "你是发言成员"}</p>
            </div>
            <div className="member-actions">
              <Btn small variant="primary" onClick={() => openAgentChat(state, dispatch, actions, id)}>进入查看</Btn>
            </div>
          </li>
        ) : (
          <li className="rows-empty">它还没有参与任何会话</li>
        )}
      </ul>
    </>
  );
}

function DeleteModal({ agent, onClose }) {
  const { actions, dispatch } = useStore();
  const { busy, run } = useAction();
  const confirm = async () => {
    const res = await run("delete", () => settled(actions.deleteAgent(agent.id)), refusalText);
    if (!res.ok) return;
    dispatch({ type: "toast", text: `已删除${agent.name}` });
    onClose();
  };
  return (
    <Modal
      title={`删除${agent.name}`}
      onClose={onClose}
      footer={
        <>
          <Btn data-autofocus onClick={onClose}>取消</Btn>
          <Btn variant="danger" disabled={busy !== null} onClick={confirm}>
            {busy !== null ? "处理中…" : "确认删除"}
          </Btn>
        </>
      }
    >
      <p>
        你要删除 <strong>{agent.name}</strong>：
      </p>
      <ul className="plain-list">
        <li>删除后不可恢复。</li>
        <li>聊天记录会保留，只能查看。</li>
        <li>它不会再回复，账号名 {agent.handle} 也不会释放。</li>
      </ul>
    </Modal>
  );
}

function AgentDetail({ agent }) {
  const { state, dispatch, actions } = useStore();
  const { busy, run } = useAction();
  const [deleting, setDeleting] = useState(false);
  const { nav } = state;
  const tab = nav.agentTab ?? "profile";
  const live = agent.loaded && !agent.deleted;
  const note = nav.agentNote?.agentId === agent.id ? nav.agentNote.text : null;
  const toggle = () => run("pause", () => settled(agent.paused ? actions.resumeAgent(agent.id) : actions.pauseAgent(agent.id)), refusalText);

  return (
    <section className="page" aria-label="Agent 管理">
      <button type="button" className="back only-mobile" onClick={() => dispatch({ type: "nav", patch: { pane: "list" } })}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回我的 Agent
      </button>
      <header className="profile-head">
        <Avatar id={agent.id} size={84} />
        <div className="grow">
          <p className="eyebrow">我的 Agent</p>
          <h2>
            {agent.name} <Tag>Agent</Tag> <StatusTag agent={agent} long />
          </h2>
          <p className="muted">{agent.handle} · 主人：你</p>
        </div>
        {live && (
          <div className="head-actions">
            <Btn onClick={() => dispatch({ type: "nav", patch: { agentView: "edit" } })}>
              <Pencil size={16} aria-hidden="true" /> 编辑
            </Btn>
            <Btn variant={agent.paused ? "primary" : "ghost"} disabled={busy !== null} onClick={toggle}>
              {busy === "pause" ? (
                "处理中…"
              ) : agent.paused ? (
                <>
                  <Play size={16} aria-hidden="true" /> 恢复全部会话
                </>
              ) : (
                <>
                  <Pause size={16} aria-hidden="true" /> 暂停全部会话
                </>
              )}
            </Btn>
          </div>
        )}
      </header>
      {!agent.loaded ? (
        <div className="page-body">
          <p className="muted">正在读取它的资料…</p>
        </div>
      ) : (
        <>
          <Pills
            label="Agent 分区"
            value={tab}
            onChange={(id) => dispatch({ type: "nav", patch: { agentTab: id } })}
            options={[
              ["profile", "资料"],
              ["convs", "参与的会话"],
              ["ability", "能力与设备"],
            ]}
          />
          <div className="page-body">
            {note && (
              <Notice tone="warn" action={<Btn small onClick={() => dispatch({ type: "nav", patch: { agentNote: null } })}>知道了</Btn>}>
                {note}
              </Notice>
            )}
            {agent.deleted && <Notice tone="info">这个 Agent 已删除：它不再回复，聊天记录会保留，只能查看。</Notice>}
            {!agent.deleted && agent.paused && (
              <Notice tone="pause">已暂停全部会话：它不会有新回复。与「停止生成」不同，这不是只中断一次回复。恢复后，暂停期间收到的消息不会补上回复。</Notice>
            )}
            {tab === "profile" && (
              <>
                <p className="lead">{agent.intro || "还没有简介。"}</p>
                <KV
                  rows={[
                    ["主人", "你（不可修改）"],
                    ["擅长领域", agent.field || "未填写"],
                    ["模型", modelLabel(state, agent.model) ?? "未选择"],
                    ["思考程度", levelLabel(agent.reasoning)],
                    ["人格文档", agent.persona ? excerpt(agent.persona) : "未填写（它会先在会话里问你几个问题）"],
                    ["私聊回复方式", agent.privateReply],
                  ]}
                />
                <Reason>人格文档只影响它如何回复，不授予任何权限。</Reason>
                {live && (
                  <div className="stack-actions row-actions">
                    <Btn variant="danger" onClick={() => setDeleting(true)}>
                      <Trash2 size={16} aria-hidden="true" /> 删除 Agent
                    </Btn>
                  </div>
                )}
              </>
            )}
            {tab === "convs" && <Conversations agent={agent} />}
            {tab === "ability" && <p className="muted">尚未开放</p>}
          </div>
        </>
      )}
      {deleting && <DeleteModal agent={agent} onClose={() => setDeleting(false)} />}
    </section>
  );
}

export function AgentMain() {
  const { state } = useStore();
  const { nav } = state;
  const agent = state.agents[nav.agentId];
  if (nav.agentView === "create") return <AgentForm key="create" />;
  if (!agent) return <div className="empty-main">选择一个 Agent</div>;
  // A form opens only on a loaded record (never an empty form that could wipe the persona) of an Agent not deleted.
  if (nav.agentView === "edit" && agent.loaded && !agent.deleted) return <AgentForm key={agent.id} agent={agent} />;
  return <AgentDetail agent={agent} />;
}
