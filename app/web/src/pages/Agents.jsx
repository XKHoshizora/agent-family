import React, { useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { convTitle, TYPE_LABEL, viewerOwners, nameOf, publishBlock } from "../state/selectors.js";
import { Avatar, ConvAvatar, Tag, Btn, IconBtn, Notice, Reason, KV, Field, focusInvalid } from "../ui/primitives.jsx";
import { ListHeader, Pills } from "./ChatList.jsx";
import { Plus, ChevronLeft, Pencil, Pause, Play, Monitor, Laptop, Lock } from "../icons.js";

const PRIVATE_REPLY = ["收到消息时回复", "仅在我点名时回复"];
const GROUP_REPLY = ["被 @ 时回复", "不在群内回复"];
const EXEC = [
  ["none", "不使用电脑", "只对话；仍可使用已单独授权的模型或工具。"],
  ["virtual", "虚拟电脑", "独立桌面，与你的实际电脑隔离。"],
  ["physical", "实际电脑", "使用你已绑定的设备。"],
];
const CAPS = [
  ["browser", "浏览公开网页", "不含登录与支付"],
  ["folder", "读写指定文件夹", "仅下面填写的文件夹"],
  ["install", "安装软件", "风险较高，默认关闭"],
];

const myAgents = (state) => Object.values(state.agents).filter((a) => a.ownerId === ME);

export function AgentsList() {
  const { state, dispatch } = useStore();
  const { nav } = state;
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
      <p className="list-note">这里只列出你拥有的 Agent。其他人的 Agent 在通讯录中查看。</p>
      <ul className="rows">
        {myAgents(state).map((a) => (
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
                  {a.paused ? <Tag tone="pending">已暂停</Tag> : <Tag tone="ok">可回复</Tag>}
                </span>
                <span className="row-sub">
                  <span className="row-preview">
                    {a.field || "未填写擅长领域"} · {a.execMode === "none" ? "未分配电脑" : state.devices[a.device]?.short}
                  </span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function AgentForm({ agent }) {
  const { dispatch } = useStore();
  const [f, setF] = useState({
    name: agent?.name || "",
    intro: agent?.intro || "",
    role: agent?.role || "",
    field: agent?.field || "",
    privateReply: agent?.privateReply || PRIVATE_REPLY[0],
    groupReply: agent?.groupReply || GROUP_REPLY[0],
  });
  const [touched, setTouched] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const errors = {
    name: !f.name.trim() ? "请填写名称" : f.name.trim().length > 20 ? "名称不超过 20 个字" : "",
    role: f.role.trim().length < 10 ? "请用至少 10 个字说明它的角色" : "",
  };
  const invalid = Boolean(errors.name || errors.role);
  const back = () => dispatch({ type: "nav", patch: { agentView: "detail", pane: agent ? "main" : "list" } });
  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (invalid) { focusInvalid(e.currentTarget); return; }
    dispatch({ type: "agent/save", id: agent?.id, fields: { ...f, name: f.name.trim(), role: f.role.trim() } });
  };
  return (
    <section className="page" aria-label={agent ? "编辑 Agent" : "创建 Agent"}>
      <button type="button" className="back" onClick={back}>
        <ChevronLeft size={20} aria-hidden="true" /> 返回
      </button>
      <header className="profile-head">
        <Avatar id={agent?.id || "__new"} size={72} />
        <div>
          <p className="eyebrow">我的 Agent</p>
          <h2>{agent ? `编辑 ${agent.name}` : "创建 Agent"}</h2>
        </div>
      </header>
      <form className="page-body form" onSubmit={submit} noValidate>
        <Field label="名称" error={touched && errors.name}>
          <input value={f.name} onChange={set("name")} maxLength={24} placeholder="例如：我的美食助手" />
        </Field>
        <div className="field">
          <span className="field-label">主人</span>
          <p className="readonly"><Lock size={14} aria-hidden="true" /> 你（不可修改）</p>
        </div>
        <Field label="简介">
          <input value={f.intro} onChange={set("intro")} maxLength={40} placeholder="一句话介绍它能做什么" />
        </Field>
        <Field label="擅长领域">
          <input value={f.field} onChange={set("field")} maxLength={20} placeholder="例如：旅行规划" />
        </Field>
        <Field label="角色说明" hint="说明只影响它如何回复，不会授予文件、工具或电脑权限。" error={touched && errors.role}>
          <textarea rows={4} value={f.role} onChange={set("role")} maxLength={300} />
        </Field>
        <Field label="私聊回复方式">
          <select value={f.privateReply} onChange={set("privateReply")}>
            {PRIVATE_REPLY.map((x) => <option key={x}>{x}</option>)}
          </select>
        </Field>
        <Field label="群内回复方式">
          <select value={f.groupReply} onChange={set("groupReply")}>
            {GROUP_REPLY.map((x) => <option key={x}>{x}</option>)}
          </select>
        </Field>
        <Notice tone="info">
          {agent ? "保存不会改变它的电脑分配和已有授权。" : "创建后会生成一个专属会话。不会自动分配电脑，也不会自动授予任何文件夹；需要时在「能力与设备」中单独配置。"}
        </Notice>
        <div className="form-actions">
          <Btn onClick={back}>取消</Btn>
          <Btn variant="primary" type="submit">{agent ? "保存" : "创建 Agent"}</Btn>
        </div>
      </form>
    </section>
  );
}

function Ability({ agent }) {
  const { state, dispatch } = useStore();
  const [mode, setMode] = useState(agent.execMode);
  const [device, setDevice] = useState(agent.device);
  const [caps, setCaps] = useState(agent.caps);
  const [folder, setFolder] = useState(agent.folder);
  const devices = Object.values(state.devices).filter((d) => (mode === "virtual" ? d.type === "virtual" : d.type === "physical"));
  const busyTask = Object.values(state.tasks).some((t) => t.agentId === agent.id && ["running", "stopping", "stopped", "ending"].includes(t.status));
  const chosen = device ? state.devices[device] : null;
  const pick = (m) => {
    setMode(m);
    const first = Object.values(state.devices).find((d) => d.owner === ME && d.type === (m === "virtual" ? "virtual" : "physical"));
    setDevice(m === "none" ? null : first?.id || null);
    if (m === "none") setCaps({ browser: false, folder: false, install: false });
  };
  const reason = busyTask
    ? "该 Agent 有进行中的任务，请先结束任务再调整"
    : mode !== "none" && !device
      ? "请选择一台你拥有的设备"
      : caps.folder && !folder.trim()
        ? "请填写允许使用的文件夹名称"
        : "";
  const users = (id) => Object.values(state.agents).filter((a) => a.device === id && a.execMode !== "none").map((a) => a.name);

  return (
    <>
      <h3>执行方式</h3>
      <div className="radio-cards" role="radiogroup" aria-label="执行方式">
        {EXEC.map(([id, title, desc]) => (
          <label key={id} className={mode === id ? "active" : ""}>
            <input type="radio" name="exec" checked={mode === id} disabled={busyTask} onChange={() => pick(id)} />
            <span>
              <strong>{title}</strong>
              <small>{desc}</small>
            </span>
          </label>
        ))}
      </div>

      {mode !== "none" && (
        <>
          <h3>设备分配</h3>
          <ul className="device-rows">
            {devices.map((d) => {
              const mine = d.owner === ME;
              return (
                <li key={d.id} className={device === d.id ? "active" : ""}>
                  <label>
                    <input type="radio" name="device" checked={device === d.id} disabled={!mine || busyTask} onChange={() => setDevice(d.id)} />
                    {d.type === "virtual" ? <Monitor size={20} aria-hidden="true" /> : <Laptop size={20} aria-hidden="true" />}
                    <span className="member-body">
                      <strong>{d.name}</strong>
                      <small>
                        属于{nameOf(state, d.owner)}
                        {mine ? (users(d.id).length ? ` · 已分配给：${users(d.id).join("、")}` : " · 尚未分配") : " · 你没有分配或管理权限（只读）"}
                      </small>
                    </span>
                    <Tag tone={!d.online ? "warn" : d.busy ? "pending" : "ok"}>{!d.online ? "离线" : d.busy ? "使用中" : "空闲"}</Tag>
                  </label>
                </li>
              );
            })}
          </ul>
          {chosen && !chosen.online && <Reason>设备离线：可以保留分配，但离线期间无法启动任务。</Reason>}
          {chosen && chosen.busy && <Reason>设备正在被使用：同一时间只有一位操作者，新任务需要排队。</Reason>}

          <h3>可申请的能力上限</h3>
          <fieldset className="checks">
            <legend className="sr-only">能力上限</legend>
            {CAPS.map(([id, title, desc]) => (
              <label key={id}>
                <input type="checkbox" checked={caps[id]} disabled={busyTask} onChange={(e) => setCaps({ ...caps, [id]: e.target.checked })} />
                <span>
                  {title} <small>{desc}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {caps.folder && (
            <Field label="允许使用的文件夹" hint="只是上限。每次任务仍会列出具体读写范围并单独确认。">
              <input value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={30} placeholder="例如：旅行资料" />
            </Field>
          )}
        </>
      )}

      <Notice tone="info">
        这是这个 Agent 自己的上限，每个 Agent 独立配置。分配设备不会启动任务，也不会自动授权；每次任务都要单独确认，且不能超过这里的上限。
      </Notice>
      <div className="form-actions">
        <Reason>{reason}</Reason>
        <Btn
          variant="primary"
          disabled={Boolean(reason)}
          reason={reason}
          onClick={() => dispatch({ type: "agent/ability", id: agent.id, execMode: mode, device, caps, folder: caps.folder ? folder.trim() : "" })}
        >
          保存能力与设备
        </Btn>
      </div>
    </>
  );
}

function Conversations({ agent }) {
  const { state, dispatch } = useStore();
  const list = state.order.map((id) => state.convs[id]).filter((c) => c && c.members.includes(agent.id));
  return (
    <>
      <p className="muted">作为主人，你可以进入查看这个 Agent 合法参与的会话；只包含其中的消息与附件。</p>
      <ul className="member-rows">
        {list.map((c) => (
          <li key={c.id}>
            <ConvAvatar conv={c} size={44} />
            <div className="member-body">
              <strong>
                {convTitle(state, c)} <Tag>{TYPE_LABEL[c.type]}</Tag> {publishBlock(state, c) && <Tag tone="pending">已冻结</Tag>}
              </strong>
              <p className="muted">
                可见主人：{viewerOwners(state, c).map((id) => nameOf(state, id)).join("、")}
                {c.members.includes(ME) ? " · 你是发言成员" : " · 你以主人身份查看，可用本人身份插话"}
              </p>
            </div>
            <div className="member-actions">
              <Btn small variant="primary" onClick={() => dispatch({ type: "nav/openConv", convId: c.id })}>进入查看</Btn>
            </div>
          </li>
        ))}
        {list.length === 0 && <li className="rows-empty">它还没有参与任何会话</li>}
      </ul>
    </>
  );
}

export function AgentMain() {
  const { state, dispatch } = useStore();
  const { nav } = state;
  const agent = state.agents[nav.agentId];
  if (nav.agentView === "create") return <AgentForm key="create" />;
  if (!agent || agent.ownerId !== ME) return <div className="empty-main">选择一个 Agent</div>;
  if (nav.agentView === "edit") return <AgentForm key={agent.id} agent={agent} />;
  const device = agent.device ? state.devices[agent.device] : null;
  const running = Object.values(state.tasks).find((t) => t.agentId === agent.id && ["running", "stopping", "stopped", "ending"].includes(t.status));

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
            {agent.name} <Tag>Agent</Tag> {agent.paused ? <Tag tone="pending">已暂停全部会话</Tag> : <Tag tone="ok">可回复</Tag>}
          </h2>
          <p className="muted">{agent.handle} · 主人：你</p>
        </div>
        <div className="head-actions">
          <Btn onClick={() => dispatch({ type: "nav", patch: { agentView: "edit" } })}><Pencil size={16} aria-hidden="true" /> 编辑</Btn>
          <Btn variant={agent.paused ? "primary" : "ghost"} onClick={() => dispatch({ type: "agent/pause", id: agent.id, paused: !agent.paused })}>
            {agent.paused ? <><Play size={16} aria-hidden="true" /> 恢复全部会话</> : <><Pause size={16} aria-hidden="true" /> 暂停全部会话</>}
          </Btn>
        </div>
      </header>
      <Pills
        label="Agent 分区"
        value={nav.agentTab}
        onChange={(id) => dispatch({ type: "nav", patch: { agentTab: id } })}
        options={[
          ["profile", "资料"],
          ["convs", "参与的会话"],
          ["ability", "能力与设备"],
        ]}
      />
      <div className="page-body">
        {agent.paused && <Notice tone="pause">已暂停全部会话：它不会有新回复或新任务。与「停止生成」不同，这不是只中断一次回复。恢复后，已暂停的讨论和任务不会自动继续。</Notice>}
        {running && <Notice tone="info">它有一个{running.status === "running" ? "执行中" : running.status === "stopped" ? "已确认停止" : "停止或结束尚待设备确认"}的任务。暂停全部会话会请求停止该任务，以设备确认为准。</Notice>}
        {nav.agentTab === "profile" && (
          <>
            <p className="lead">{agent.intro || "还没有简介。"}</p>
            <KV
              rows={[
                ["主人", "你（不可修改）"],
                ["擅长领域", agent.field || "未填写"],
                ["角色说明", agent.role || "未填写"],
                ["私聊回复方式", agent.privateReply],
                ["群内回复方式", agent.groupReply],
                ["附件", agent.attach],
                ["电脑", agent.execMode === "none" ? "未分配" : `${device?.name}${agent.paused ? "（已绑定，不代表正在执行）" : ""}`],
              ]}
            />
            <Reason>角色说明与回复偏好不授予任何资源访问。电脑和任务分别在「能力与设备」和每次任务确认中决定。</Reason>
          </>
        )}
        {nav.agentTab === "convs" && <Conversations agent={agent} />}
        {nav.agentTab === "ability" && (
          <Ability key={`${agent.id}:${agent.execMode}:${agent.device}:${JSON.stringify(agent.caps)}:${agent.folder}`} agent={agent} />
        )}
      </div>
    </section>
  );
}
