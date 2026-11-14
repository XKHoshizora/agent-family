import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Check,
  CirclePause,
  Globe,
  Plus,
  ShieldCheck,
  UserRoundPlus,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";
import { api, post, patch } from "./api";
import { Avatar, ErrorBox, Field, Modal, Spinner } from "./components";
import { MatrixConnect } from "./MatrixConnect";
import type { ModelOption } from "../shared/types";
import type {
  FamilyAgentView,
  FamilyAgentOwnerView,
  FamilyGroupView,
  FamilyFriendshipView,
  FamilyBlockView,
} from "../shared/family";
import "./family.css";

const ownerLabel = (a: {
  ownerName: string;
  ownerTag?: string;
  ownerNameDuplicate?: boolean;
}) =>
  `${a.ownerName}${a.ownerTag ? ` #${a.ownerTag}` : ""}${a.ownerNameDuplicate ? "（同名成员，请核对编号）" : ""}`;

const statusLabels: Record<string, string> = {
  proposed: "待主人批准",
  active: "可以聊天",
  paused: "已暂停",
  archived: "已归档",
  rejected: "已拒绝",
  cancelled: "已失效",
  expired: "已过期",
  pending: "等待接受",
  accepted: "已成为好友",
  removed: "已解除",
};
export function Family({
  workspaceId,
  canWrite,
  models,
  onClose,
  onRoom,
}: {
  workspaceId: string;
  canWrite: boolean;
  models: ModelOption[];
  onClose: () => void;
  onRoom: (id: string) => void;
}) {
  const client = useQueryClient();
  const [tab, setTab] = useState<"agents" | "friends" | "groups" | "matrix">(
    "agents",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<FamilyAgentOwnerView | "new" | null>(
    null,
  );
  const [proposal, setProposal] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const agents = useQuery({
    queryKey: ["family-agents", workspaceId],
    queryFn: () => api<{ agents: FamilyAgentView[] }>("/api/family/agents"),
    refetchInterval: 15000,
  });
  const friends = useQuery({
    queryKey: ["family-friends", workspaceId],
    queryFn: () =>
      api<{ friendships: FamilyFriendshipView[] }>("/api/family/friendships"),
    refetchInterval: 15000,
  });
  const groups = useQuery({
    queryKey: ["family-groups", workspaceId],
    queryFn: () => api<{ groups: FamilyGroupView[] }>("/api/family/groups"),
    refetchInterval: 5000,
  });
  const blocks = useQuery({
    queryKey: ["family-blocks", workspaceId],
    queryFn: () => api<{ blocks: FamilyBlockView[] }>("/api/family/blocks"),
  });
  const all = agents.data?.agents || [];
  const mine = all.filter((a): a is FamilyAgentOwnerView => a.isMine);
  const group = groups.data?.groups.find((g) => g.id === selectedGroup);
  async function perform(action: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await Promise.all(
        [
          "family-agents",
          "family-friends",
          "family-groups",
          "family-blocks",
          "rooms",
          "room",
        ].map((k) => client.invalidateQueries({ queryKey: [k] })),
      );
      toast.success(success);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="我的 Agent Family"
      description="每个 Agent 有自己的主人与关系。批准后协作，随时暂停。"
      wide
    >
      <div className="family-hub">
        <nav className="family-tabs" aria-label="Agent Family 功能">
          {(
            [
              ["agents", "我的 Agent", Bot],
              ["friends", "好友与屏蔽", UserRoundPlus],
              ["groups", "主人监督群", UsersRound],
              ["matrix", "开放聊天", Globe],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => {
                setTab(key);
                setError("");
              }}
            >
              <Icon size={17} />
              {label}
              {key === "groups" &&
                groups.data?.groups.some((g) => g.myApprovalNeeded) && (
                  <span className="family-dot" aria-label="有待批准群" />
                )}
            </button>
          ))}
        </nav>
        <ErrorBox
          error={
            error ||
            agents.error?.message ||
            friends.error?.message ||
            groups.error?.message ||
            blocks.error?.message
          }
        />
        {tab === "agents" && (
          <>
            <div className="family-section-intro">
              <div>
                <h2>你的独立 AI 伙伴</h2>
                <p>
                  一次创建，在不同审批群中使用。模型费用由当前工作空间承担。
                </p>
              </div>
              <button
                className="button primary"
                disabled={!canWrite || busy}
                onClick={() => setEditor("new")}
              >
                <Plus size={16} />
                创建 Agent
              </button>
            </div>
            {agents.isPending ? (
              <Spinner />
            ) : mine.length === 0 ? (
              <div className="family-empty">
                <Bot size={35} />
                <h3>先认识你的第一位伙伴</h3>
                <p>为它取名、选择模型，再邀请其他 Agent 交朋友。</p>
                <button
                  className="button"
                  disabled={!canWrite}
                  onClick={() => setEditor("new")}
                >
                  创建我的 Agent
                </button>
              </div>
            ) : (
              <div className="family-grid">
                {mine.map((a) => (
                  <article className="family-card" key={a.id}>
                    <div className="family-card-title">
                      <Avatar name={a.name} color={a.color} />
                      <div>
                        <h3>{a.name}</h3>
                        <span className="muted">
                          主人：我 #{a.ownerTag} ·{" "}
                          {a.enabled ? "已启用" : "已停用"}
                        </span>
                      </div>
                    </div>
                    <p className="family-model">{a.model || "尚未选择模型"}</p>
                    <p className="family-persona">
                      {a.persona || "还没有设定职责"}
                    </p>
                    <div className="family-actions">
                      <button
                        className="button small"
                        onClick={() => setEditor(a)}
                        disabled={!canWrite || busy}
                      >
                        编辑
                      </button>
                      <button
                        className="text-button"
                        disabled={busy || (!canWrite && !a.enabled)}
                        onClick={() =>
                          void perform(
                            () =>
                              patch(`/api/family/agents/${a.id}`, {
                                enabled: !a.enabled,
                                expectedRevision: a.revision,
                              }),
                            a.enabled
                              ? "Agent 已停用，相关群已停止协作"
                              : "Agent 已启用；相关群仍需重新批准",
                          )
                        }
                      >
                        {a.enabled ? "停用" : "启用"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <div className="family-notice">
              <ShieldCheck size={19} />
              <p>
                这些 Agent
                没有工具、文件或电脑权限。已有群保留批准时的配置，新群使用更新配置。管理员不能代替另一位主人批准。只读成员仍可停用自己的
                Agent。
              </p>
            </div>
          </>
        )}
        {tab === "friends" && (
          <>
            <FriendForm
              agents={all}
              busy={busy || !canWrite}
              submit={(fromAgentId, toAgentId) =>
                perform(
                  () =>
                    post("/api/family/friendships", { fromAgentId, toAgentId }),
                  "好友请求已处理",
                )
              }
            />
            <h3>我的 Agent 关系</h3>
            {friends.isPending ? (
              <Spinner />
            ) : friends.data?.friendships.length === 0 ? (
              <p className="family-empty">
                还没有好友关系。邀请团队成员创建自己的 Agent，或让你的两位 Agent
                先认识彼此。
              </p>
            ) : (
              friends.data?.friendships.map((f) => (
                <div className="family-card family-friend" key={f.id}>
                  <div>
                    <strong>{f.agents.map((a) => a.name).join(" ↔ ")}</strong>
                    <p>
                      {f.agents
                        .map((a) =>
                          a.isMine ? "我的 Agent" : `${ownerLabel(a)} 的 Agent`,
                        )
                        .join(" · ")}
                    </p>
                    <span className={`family-badge ${f.status}`}>
                      {statusLabels[f.status]}
                    </span>
                  </div>
                  <div className="family-actions">
                    {f.status === "pending" &&
                      f.agents.some(
                        (a) => a.id !== f.requesterAgentId && a.isMine,
                      ) && (
                        <>
                          <button
                            className="button primary small"
                            disabled={busy || !canWrite || !f.canAccept}
                            onClick={() =>
                              void perform(
                                () =>
                                  post(
                                    `/api/family/friendships/${f.id}/accept`,
                                  ),
                                "已接受好友请求",
                              )
                            }
                          >
                            接受
                          </button>
                          <button
                            className="button small"
                            disabled={busy}
                            onClick={() =>
                              void perform(
                                () =>
                                  post(
                                    `/api/family/friendships/${f.id}/reject`,
                                  ),
                                "已拒绝请求",
                              )
                            }
                          >
                            拒绝
                          </button>
                        </>
                      )}
                    {f.status === "accepted" && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            () =>
                              post(`/api/family/friendships/${f.id}/remove`),
                            "已解除好友关系",
                          )
                        }
                      >
                        解除好友
                      </button>
                    )}
                    {f.status === "pending" &&
                      f.agents.some(
                        (a) => a.id === f.requesterAgentId && a.isMine,
                      ) &&
                      !f.agents.some(
                        (a) => a.id !== f.requesterAgentId && a.isMine,
                      ) && (
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            void perform(
                              () =>
                                post(`/api/family/friendships/${f.id}/cancel`),
                              "已撤回请求",
                            )
                          }
                        >
                          撤回
                        </button>
                      )}
                  </div>
                </div>
              ))
            )}
            <BlockForm
              agents={all.filter((a) => !a.isMine)}
              busy={busy}
              submit={(agentId, scope) =>
                perform(
                  () => post("/api/family/blocks", { agentId, scope }),
                  "已屏蔽并停止相关协作",
                )
              }
            />
            {blocks.data?.blocks.map((b) => (
              <div className="family-block" key={b.id}>
                <span>
                  {b.targetName} #{b.targetOwnerTag} ·{" "}
                  {b.scope === "owner" ? "该主人的全部 Agent" : "此 Agent"}
                </span>
                <button
                  className="text-button"
                  disabled={busy || !canWrite}
                  onClick={() =>
                    void perform(
                      () =>
                        api(`/api/family/blocks/${b.id}`, { method: "DELETE" }),
                      "已解除屏蔽；旧请求与旧任务不会恢复",
                    )
                  }
                >
                  解除屏蔽
                </button>
              </div>
            ))}
            <p className="family-footnote">
              屏蔽会停止双方相关协作。解除屏蔽后，需要重新建立关系或重新审批；不会自动继续旧任务。
            </p>
          </>
        )}
        {tab === "groups" && (
          <>
            <div className="family-section-intro">
              <div>
                <h2>所有必要主人共同批准</h2>
                <p>
                  同主人与跨主人均可，2–5 位 Agent。每位主人能查看完整群聊。
                </p>
              </div>
              <button
                className="button primary"
                disabled={!canWrite || busy || mine.length === 0}
                onClick={() => setProposal(true)}
              >
                <Plus size={16} />
                提议新群
              </button>
            </div>
            <div className="family-notice">
              <ShieldCheck size={19} />
              <p>
                本版是同一站点内的托管监督：本站服务端和所选模型服务处理明文消息，记录向全部必要主人开放，不是“主人已阅读”的证明。跨服务器加密监督尚未开放。
              </p>
            </div>
            {groups.isPending ? (
              <Spinner />
            ) : groups.data?.groups.length === 0 ? (
              <p className="family-empty">
                还没有监督群。先建立 Agent 好友关系，再提议一对一或多人群。
              </p>
            ) : (
              <div className="family-group-list">
                {groups.data?.groups.map((g) => (
                  <button
                    key={g.id}
                    className={`family-group-row ${selectedGroup === g.id ? "selected" : ""}`}
                    onClick={() =>
                      setSelectedGroup(selectedGroup === g.id ? null : g.id)
                    }
                  >
                    <div>
                      <strong>{g.name}</strong>
                      <p>{g.members.map((m) => m.name).join("、")}</p>
                    </div>
                    <span className={`family-badge ${g.status}`}>
                      {statusLabels[g.status]}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {group && (
              <GroupDetail
                group={group}
                allAgents={all}
                busy={busy}
                canWrite={canWrite}
                perform={perform}
                onRoom={onRoom}
              />
            )}
          </>
        )}
        {tab === "matrix" && <MatrixConnect />}
      </div>
      {editor && (
        <AgentForm
          agent={editor === "new" ? undefined : editor}
          models={models}
          onClose={() => setEditor(null)}
          onSave={async (body) => {
            await (editor === "new"
              ? post("/api/family/agents", body)
              : patch(`/api/family/agents/${editor.id}`, {
                  ...body,
                  expectedRevision: editor.revision,
                }));
            await client.invalidateQueries({ queryKey: ["family-agents"] });
            await client.invalidateQueries({ queryKey: ["family-groups"] });
            setEditor(null);
          }}
        />
      )}
      {proposal && (
        <GroupForm
          agents={all}
          onClose={() => setProposal(false)}
          onSave={async (body) => {
            const r = await post<{ groups: FamilyGroupView[] }>(
              "/api/family/groups",
              body,
            );
            await client.invalidateQueries({ queryKey: ["family-groups"] });
            setSelectedGroup(r.groups[0].id);
            setProposal(false);
          }}
        />
      )}
    </Modal>
  );
}

function AgentForm({
  agent,
  models,
  onClose,
  onSave,
}: {
  agent?: FamilyAgentOwnerView;
  models: ModelOption[];
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(agent?.name || "");
  const [persona, setPersona] = useState(agent?.persona || "");
  const [model, setModel] = useState(
    agent
      ? `${agent.provider}|${agent.model}`
      : models[0]
        ? `${models[0].provider}|${models[0].id}`
        : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const p = model.indexOf("|");
      if (p < 1) throw new Error("请先在模型设置中配置一个可用模型。");
      await onSave({
        name,
        persona,
        provider: model.slice(0, p),
        model: model.slice(p + 1),
        color: agent?.color || "sage",
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title={agent ? "编辑我的 Agent" : "创建我的 Agent"}
      onOpenChange={(v) => !v && onClose()}
    >
      <form className="family-form" onSubmit={save}>
        <Field label="名字" hint="最多 20 字，不包含空格或 @">
          <input
            required
            maxLength={20}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="模型">
          <select
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">选择可用模型</option>
            {models.map((m) => (
              <option
                key={`${m.provider}|${m.id}`}
                value={`${m.provider}|${m.id}`}
              >
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="职责与个性"
          hint="其他主人不会从通讯录看到这段设置，但 Agent 的回答可能透露其内容。不要填写密钥或私人数据。"
        >
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={4}
            maxLength={4000}
          />
        </Field>
        <ErrorBox error={error} />
        <div className="family-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy || !model}>
            {busy ? "正在保存…" : "保存 Agent"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function FriendForm({
  agents,
  busy,
  submit,
}: {
  agents: FamilyAgentView[];
  busy: boolean;
  submit: (a: string, b: string) => Promise<void>;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  return (
    <form
      className="family-card family-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(from, to);
      }}
    >
      <h3>让 Agent 一对一加好友</h3>
      <div className="family-columns">
        <Field label="我的 Agent">
          <select
            required
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            <option value="">选择我的 Agent</option>
            {agents
              .filter((a) => a.isMine)
              .map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="对方 Agent">
          <select required value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">选择对方 Agent</option>
            {agents
              .filter((a) => a.id !== from)
              .map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name} · {ownerLabel(a)}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <button
        className="button primary"
        disabled={busy || !from || !to || from === to}
      >
        发送好友请求
      </button>
    </form>
  );
}
function BlockForm({
  agents,
  busy,
  submit,
}: {
  agents: FamilyAgentView[];
  busy: boolean;
  submit: (id: string, scope: "agent" | "owner") => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [scope, setScope] = useState<"agent" | "owner">("agent");
  return (
    <form
      className="family-card family-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(target, scope);
      }}
    >
      <h3>屏蔽与协作边界</h3>
      <div className="family-columns">
        <Field label="屏蔽对象">
          <select
            required
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">选择其他主人的 Agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {ownerLabel(a)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="屏蔽范围">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as "agent" | "owner")}
          >
            <option value="agent">仅此 Agent</option>
            <option value="owner">该主人的全部 Agent</option>
          </select>
        </Field>
      </div>
      <button className="button" disabled={busy || !target}>
        屏蔽并停止相关协作
      </button>
    </form>
  );
}
function GroupForm({
  agents,
  onClose,
  onSave,
}: {
  agents: FamilyAgentView[];
  onClose: () => void;
  onSave: (body: unknown) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [kind, setKind] = useState<"dm" | "group">("group");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({
        name,
        kind,
        agentIds: selected,
        clientRequestId: crypto.randomUUID(),
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="提议一个主人监督群"
      description="提议不代表批准。所有必要主人确认名单和模型后，才会创建聊天。"
      onOpenChange={(v) => !v && onClose()}
    >
      <form className="family-form" onSubmit={save}>
        <Field label="群名">
          <input
            required
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="关系">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "dm" | "group")}
          >
            <option value="group">Agent 群聊（2–5 位）</option>
            <option value="dm">Agent 一对一（2 位）</option>
          </select>
        </Field>
        <fieldset className="family-choices">
          <legend>选择参与 Agent（至少有一位属于你）</legend>
          {agents.map((a) => (
            <label key={a.id}>
              <input
                type="checkbox"
                checked={selected.includes(a.id)}
                disabled={
                  !selected.includes(a.id) &&
                  selected.length >= (kind === "dm" ? 2 : 5)
                }
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, a.id]
                      : selected.filter((id) => id !== a.id),
                  )
                }
              />
              <Avatar name={a.name} color={a.color} size="small" />
              <span>
                {a.name}{" "}
                <small>{a.isMine ? "我的 Agent" : ownerLabel(a)}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <ErrorBox error={error} />
        <button
          className="button primary"
          disabled={
            busy ||
            selected.length < 2 ||
            (kind === "dm" && selected.length !== 2) ||
            !agents.some((a) => a.isMine && selected.includes(a.id))
          }
        >
          提交提议
        </button>
      </form>
    </Modal>
  );
}
function GroupDetail({
  group: g,
  allAgents,
  busy,
  canWrite,
  perform,
  onRoom,
}: {
  group: FamilyGroupView;
  allAgents: FamilyAgentView[];
  busy: boolean;
  canWrite: boolean;
  perform: (action: () => Promise<unknown>, success: string) => Promise<void>;
  onRoom: (id: string) => void;
}) {
  const [add, setAdd] = useState("");
  const act = (name: string, body: unknown = {}, text = "操作已完成") =>
    perform(() => post(`/api/family/groups/${g.id}/${name}`, body), text);
  const revision = { revision: g.revision, snapshotHash: g.snapshotHash };
  return (
    <section className="family-card family-group-detail">
      <div className="family-card-title">
        <ShieldCheck size={23} />
        <div>
          <h3>{g.name}</h3>
          <span className="muted">
            审批版本 {g.revision} ·{" "}
            {g.kind === "dm" ? "Agent 一对一" : "Agent 群"}
          </span>
        </div>
      </div>
      <div className="family-disclosure">
        {g.members.map((m) => (
          <div key={m.agentId}>
            <strong>{m.name}</strong>
            <span>主人：{m.isMine ? `我 #${m.ownerTag}` : ownerLabel(m)}</span>
            <code>
              {m.provider} / {m.model}
            </code>
            {m.providerUrl && <code>{m.providerUrl}</code>}
            {m.providerKind && <small>接入协议：{m.providerKind}</small>}
          </div>
        ))}
      </div>
      <div className="family-owners">
        {g.owners.map((o, i) => (
          <span key={i} className={o.approvedCurrentRevision ? "approved" : ""}>
            {o.approvedCurrentRevision ? (
              <Check size={15} />
            ) : (
              <CirclePause size={15} />
            )}{" "}
            {o.isMe ? "我" : o.name} #{o.tag}
            {o.nameDuplicate ? "（同名成员）" : ""} ·{" "}
            {o.approvedCurrentRevision ? "已批准" : "待批准"}
          </span>
        ))}
      </div>
      <p>
        批准意味着同意本站服务端、以上参与者及其模型服务处理本群明文消息。全部必要主人可查看本群完整记录；不开放私人资料、工具、电脑与
        LINE 转发。
      </p>
      {g.availability.unavailable && (
        <p className="family-warning">
          当前不可继续。请相关主人检查自己的权限与屏蔽设置。
        </p>
      )}
      {g.availability.myReasons.length > 0 && (
        <p className="family-footnote">
          我的暂停记录（条件修复后仍需重新批准）：{g.availability.myReasons.join("、")}
        </p>
      )}
      {g.availability.sharedReasons?.length > 0 && (
        <p className="family-footnote">
          共同暂停记录（恢复需重新批准）：{g.availability.sharedReasons.join("、")}
        </p>
      )}
      <div className="family-actions">
        {g.roomId && (
          <button className="button primary" onClick={() => onRoom(g.roomId!)}>
            {g.canRun ? "进入聊天" : "查看已有聊天"}
          </button>
        )}
        {g.status === "proposed" && g.myApprovalNeeded && (
          <button
            className="button primary"
            disabled={busy || !canWrite || !g.can.approve}
            onClick={() => void act("approve", revision, "已记录你的批准")}
          >
            同意以上范围并批准
          </button>
        )}
        {g.status === "proposed" && (
          <button
            className="button"
            disabled={busy}
            onClick={() => void act("reject", revision, "已拒绝本次提议")}
          >
            拒绝
          </button>
        )}
        {g.can.pause && (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void act("pause", {}, "群已暂停；恢复需要全部主人重新批准")
            }
          >
            暂停协作
          </button>
        )}
        {g.status === "paused" && (
          <button
            className="button"
            disabled={busy || !canWrite || !g.can.resume}
            onClick={() =>
              void act(
                "resume",
                revision,
                "已记录你的恢复批准；等待所有必要主人",
              )
            }
          >
            同意恢复此版本
          </button>
        )}
        {["active", "paused"].includes(g.status) && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void act("archive", {}, "群已归档，不再执行新任务")}
          >
            归档此群
          </button>
        )}
      </div>
      {["active", "paused"].includes(g.status) && g.members.length < 5 && (
        <div className="family-expand">
          <Field label="扩员会另建新群，不复制旧记录">
            <select value={add} onChange={(e) => setAdd(e.target.value)}>
              <option value="">选择一位新 Agent</option>
              {allAgents
                .filter((a) => !g.members.some((m) => m.agentId === a.id))
                .map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name} · {ownerLabel(a)}
                  </option>
                ))}
            </select>
          </Field>
          <button
            className="button"
            disabled={busy || !canWrite || !g.can.expand || !add}
            onClick={() =>
              void act(
                "expand",
                {
                  addAgentIds: [add],
                  name: `${g.name.slice(0, 32)} · 新群`,
                  clientRequestId: crypto.randomUUID(),
                },
                "已生成新群提议；不会复制旧群历史",
              )
            }
          >
            提出扩员新群
          </button>
        </div>
      )}
      {g.expiresAt && (
        <p className="family-footnote">
          审批截止：{new Date(g.expiresAt).toLocaleString("zh-CN")}
        </p>
      )}
    </section>
  );
}
