import { DiscussionFields } from "./Discussion";
import { DEFAULT_DISCUSSION, type DiscussionSettings } from "../shared/types";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Settings2,
  KeyRound,
  UsersRound,
  ShieldCheck,
  RefreshCw,
  Plus,
  ExternalLink,
  Check,
  Link2,
  UserRound,
  LogOut,
} from "lucide-react";
import { toast } from "sonner";
import { api, post, patch, copy } from "./api";
import { Modal, Field, ErrorBox, Spinner, CopyButton } from "./components";
import {
  MODE_LABELS,
  type Mode,
  type UserSession,
  type Room,
} from "../shared/types";
type SettingsTab = "general" | "models" | "members" | "line" | "security";
export function Settings({
  open,
  onClose,
  me,
  initialTab = "general",
}: {
  open: boolean;
  onClose: () => void;
  me: UserSession;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings", me.workspace.id],
    queryFn: () => api("/api/settings"),
    enabled: open,
  });
  const members = useQuery({
    queryKey: ["members", me.workspace.id],
    queryFn: () => api<any[]>("/api/members"),
    enabled: open && tab === "members",
  });
  const audits = useQuery({
    queryKey: ["audit", me.workspace.id],
    queryFn: () => api<any[]>("/api/audit"),
    enabled:
      open &&
      tab === "security" &&
      ["owner", "admin"].includes(me.workspace.role),
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<any>(null);
  const [invite, setInvite] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [workspaceName, setWorkspaceName] = useState(me.workspace.name);
  const [lineSecret, setLineSecret] = useState("");
  const [lineToken, setLineToken] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const isAdmin = ["owner", "admin"].includes(me.workspace.role);
  const data = settings.data;
  async function action(
    name: string,
    fn: () => Promise<any>,
    success?: string,
  ) {
    setBusy(name);
    setError("");
    try {
      const result = await fn();
      await client.invalidateQueries();
      if (success) toast.success(success);
      return result;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  const tabs = [
    { id: "general", label: "偏好与账户", icon: Settings2 },
    { id: "models", label: "模型服务", icon: KeyRound },
    { id: "members", label: "团队成员", icon: UsersRound },
    { id: "line", label: "LINE 连接", icon: Link2 },
    { id: "security", label: "权限与记录", icon: ShieldCheck },
  ] as const;
  return (
    <Modal
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="空间设置"
      description="管理伙伴的模型、团队协作与 LINE 连接。"
      wide
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => {
                setTab(t.id);
                setError("");
              }}
            >
              <t.icon size={17} />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <ErrorBox error={error || settings.error?.message} />
          {settings.isPending ? (
            <Spinner />
          ) : tab === "general" ? (
            <>
              <h3>你的工作空间</h3>
              <p className="muted">
                私人群聊仅自己可见；团队群聊对空间成员开放。
              </p>
              <Field label="空间名称">
                <div className="input-action">
                  <input
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                    maxLength={60}
                    disabled={!isAdmin}
                  />
                  {isAdmin && (
                    <button
                      className="button"
                      disabled={!!busy || !workspaceName.trim()}
                      onClick={() =>
                        action(
                          "name",
                          () =>
                            patch("/api/workspace", { name: workspaceName }),
                          "名称已保存",
                        )
                      }
                    >
                      保存
                    </button>
                  )}
                </div>
              </Field>
              <div className="usage-summary">
                <div>
                  <span className="eyebrow">今日 AI 调用</span>
                  <strong>
                    {data?.usage.calls || 0}
                    <small> / {data?.usage.limit || 0}</small>
                  </strong>
                </div>
                <div>
                  <span className="eyebrow">已记录用量</span>
                  <strong>
                    {(data?.usage.tokens || 0).toLocaleString()}
                    <small> tokens</small>
                  </strong>
                </div>
              </div>
              <p className="hint">
                进行中任务已预留 {data?.usage.reserved || 0}{" "}
                次；未使用部分会在结束后释放。额度按任务开始的 UTC
                日期归属，失败请求仍计入已用次数。
              </p>
              <p className="hint">
                按 UTC
                日期重置。讨论模式每位伙伴最多回答两轮；工具追问可能增加模型请求。服务商账单以其实际计费为准。
              </p>
              <div className="section-divider" />
              <h3>账户</h3>
              <div className="account-line">
                <UserRound size={20} />
                <div>
                  <strong>{me.user.name}</strong>
                  <p className="muted">{me.user.email}</p>
                </div>
              </div>
              <details className="settings-details">
                <summary>修改密码</summary>
                <Field label="当前密码">
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </Field>
                <Field label="新密码">
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    minLength={10}
                    autoComplete="new-password"
                  />
                </Field>
                <button
                  className="button"
                  disabled={
                    !!busy || !currentPassword || newPassword.length < 10
                  }
                  onClick={() =>
                    action(
                      "password",
                      async () => {
                        await post("/api/auth/change-password", {
                          currentPassword,
                          newPassword,
                          revokeOtherSessions: true,
                        });
                        setCurrentPassword("");
                        setNewPassword("");
                      },
                      "密码已更新，其他设备已退出",
                    )
                  }
                >
                  更新密码
                </button>
              </details>
              <button
                className="text-button danger"
                onClick={() =>
                  action("logout", async () => {
                    window.dispatchEvent(new Event("af-logout"));
                    await post("/api/auth/sign-out");
                    for (const key of Object.keys(sessionStorage))
                      if (key.startsWith("af-")) sessionStorage.removeItem(key);
                    location.reload();
                  })
                }
              >
                <LogOut size={15} />
                退出登录
              </button>
            </>
          ) : tab === "models" ? (
            <>
              <div className="section-heading">
                <h3>模型服务</h3>
                {isAdmin && (
                  <button
                    className="button compact"
                    onClick={() =>
                      setProvider({
                        id: "",
                        kind: "compatible",
                        baseUrl: "https://api.canalapi.com/v1",
                        models: [],
                        apiKey: "",
                      })
                    }
                  >
                    <Plus size={15} />
                    添加
                  </button>
                )}
              </div>
              <p className="muted">
                模型密钥只在服务端使用。伙伴的名称、角色和模型可在群聊右侧单独设置。
              </p>
              {!isAdmin ? (
                <div className="info-box">
                  请联系管理员配置模型服务。你可以在群聊中使用已经开放的模型。
                </div>
              ) : (
                <>
                  {data?.providers?.map((p: any) => (
                    <div className="provider-row" key={p.id}>
                      <div className="provider-heading">
                        <strong>{p.id === "canal" ? "CanalAPI" : p.id}</strong>
                        <span className="status-dot">已配置密钥</span>
                      </div>
                      <p className="hint break-word">{p.baseUrl}</p>
                      <p>{p.models.length} 个已配置模型</p>
                      <div className="button-row">
                        <button
                          className="button compact"
                          onClick={() => setProvider({ ...p, apiKey: "" })}
                        >
                          编辑配置
                        </button>
                        {["compatible", "openai"].includes(p.kind) && (
                          <button
                            className="button compact"
                            disabled={!!busy}
                            onClick={() =>
                              action(`refresh-${p.id}`, async () => {
                                const r = await post(
                                  `/api/settings/providers/${p.id}/refresh`,
                                );
                                toast.success(`已读取 ${r.count} 个模型`);
                              })
                            }
                          >
                            <RefreshCw
                              size={14}
                              className={
                                busy === `refresh-${p.id}` ? "spin" : ""
                              }
                            />
                            读取可用模型
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {!data?.providers?.length && (
                    <div className="info-box">
                      还没有配置模型服务。添加服务后，就能邀请 AI 伙伴回答。
                    </div>
                  )}
                  <p className="hint">
                    支持 OpenAI 兼容服务，以及 OpenAI、Anthropic、Google
                    原生接口。自建服务地址需由部署管理员加入允许列表。
                  </p>
                </>
              )}
            </>
          ) : tab === "members" ? (
            <>
              <h3>一起工作的成员</h3>
              <p className="muted">
                成员可以使用团队群聊。只读成员可以查看记录，不能发起 AI 调用。
              </p>
              {members.data?.map((m) => (
                <div className="member-row" key={m.id}>
                  <div>
                    <strong>
                      {m.name}
                      {m.id === me.user.id ? "（你）" : ""}
                    </strong>
                    <small>{m.email}</small>
                  </div>
                  {me.workspace.role === "owner" && m.id !== me.user.id ? (
                    <select
                      aria-label={`${m.name}的权限`}
                      value={m.role}
                      onChange={(e) =>
                        action(
                          "role",
                          () =>
                            patch(`/api/members/${m.id}`, {
                              role: e.target.value,
                            }),
                          "权限已更新",
                        )
                      }
                    >
                      <option value="admin">管理员</option>
                      <option value="member">成员</option>
                      <option value="viewer">只读</option>
                    </select>
                  ) : (
                    <span className="tag">
                      {
                        {
                          owner: "所有者",
                          admin: "管理员",
                          member: "成员",
                          viewer: "只读",
                        }[m.role as string]
                      }
                    </span>
                  )}
                </div>
              ))}
              {isAdmin && (
                <>
                  <div className="section-divider" />
                  <h3>邀请新成员</h3>
                  <p className="hint">
                    邀请链接有效期为 24
                    小时，仅可使用一次。只向希望加入空间的人分享。
                  </p>
                  <div className="input-action">
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                      aria-label="邀请成员权限"
                    >
                      <option value="member">成员</option>
                      <option value="viewer">只读成员</option>
                      {me.workspace.role === "owner" && (
                        <option value="admin">管理员</option>
                      )}
                    </select>
                    <button
                      className="button primary"
                      disabled={!!busy}
                      onClick={() =>
                        action("invite", async () => {
                          const r = await post("/api/invites", {
                            role: inviteRole,
                          });
                          setInvite(r.url);
                        })
                      }
                    >
                      创建邀请
                    </button>
                  </div>
                  {invite && (
                    <div className="invite-result">
                      <code>{invite}</code>
                      <CopyButton text={invite} label="复制邀请" />
                    </div>
                  )}
                </>
              )}
            </>
          ) : tab === "line" ? (
            <>
              <h3>把伙伴带进 LINE 群</h3>
              <p className="muted">
                通过一个 LINE
                官方账号，让不同伙伴用各自的名字发言。网页与群聊共享已发送给
                Agent Family 的对话。
              </p>
              <div className="connection-state">
                <span
                  className={`indicator ${data?.line?.enabled ? "online" : ""}`}
                />
                <strong>
                  {data?.line?.enabled
                    ? "连接服务已启用"
                    : data?.line?.verified
                      ? "凭据已验证，尚未启用"
                      : data?.line
                        ? "待验证凭据"
                        : "尚未配置"}
                </strong>
              </div>
              {!isAdmin ? (
                <div className="info-box">请联系管理员配置 LINE 官方账号。</div>
              ) : (
                <>
                  <ol className="setup-steps">
                    <li>
                      创建 LINE Messaging API channel，并开启「Allow bot to join
                      group chats」。
                    </li>
                    <li>保存下方凭据，验证后启用连接服务。</li>
                    <li>
                      在 LINE Developers 设置 Webhook URL、开启 Use
                      webhook，然后在群聊中完成双向绑定。
                    </li>
                  </ol>
                  <a
                    className="inline-link"
                    href="https://developers.line.biz/en/docs/messaging-api/getting-started/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看 LINE 官方说明 <ExternalLink size={13} />
                  </a>
                  <Field
                    label="Channel secret"
                    hint={
                      data?.line ? "已有值不会显示。留空表示沿用。" : undefined
                    }
                  >
                    <input
                      type="password"
                      value={lineSecret}
                      onChange={(e) => setLineSecret(e.target.value)}
                      autoComplete="off"
                      placeholder={
                        data?.line
                          ? "已保存，填写以替换"
                          : "从 LINE Developers 获取"
                      }
                    />
                  </Field>
                  <Field label="Channel access token">
                    <textarea
                      rows={2}
                      className="secret-input"
                      value={lineToken}
                      onChange={(e) => setLineToken(e.target.value)}
                      autoComplete="off"
                      placeholder={
                        data?.line ? "已保存，填写以替换" : "仅服务端保存"
                      }
                    />
                  </Field>
                  <div className="button-row">
                    <button
                      className="button"
                      disabled={!!busy || (!lineSecret && !lineToken)}
                      onClick={() =>
                        action(
                          "line-save",
                          async () => {
                            await api("/api/settings/line", {
                              method: "PUT",
                              body: JSON.stringify({
                                ...(lineSecret ? { secret: lineSecret } : {}),
                                ...(lineToken ? { token: lineToken } : {}),
                              }),
                            });
                            setLineSecret("");
                            setLineToken("");
                          },
                          "凭据已保存，请验证后启用",
                        )
                      }
                    >
                      保存凭据
                    </button>
                    {data?.line && (
                      <button
                        className="button"
                        disabled={!!busy}
                        onClick={() =>
                          action("line-verify", async () => {
                            const r = await post("/api/settings/line/verify");
                            toast.success(`已验证：${r.displayName}`);
                          })
                        }
                      >
                        {busy === "line-verify" ? (
                          <Spinner label="验证中" />
                        ) : (
                          <>
                            <Check size={15} />
                            验证凭据
                          </>
                        )}
                      </button>
                    )}
                    {data?.line?.verified && (
                      <button
                        className={`button ${data.line.enabled ? "" : "primary"}`}
                        disabled={!!busy}
                        onClick={() =>
                          action(
                            "line-toggle",
                            () =>
                              patch("/api/settings/line", {
                                enabled: !data.line.enabled,
                              }),
                            data.line.enabled ? "连接已停用" : "连接服务已启用",
                          )
                        }
                      >
                        {data.line.enabled ? "停用连接" : "启用连接"}
                      </button>
                    )}
                  </div>
                  {data?.line && (
                    <Field
                      label="Webhook URL"
                      hint="LINE 需要可公开访问的 HTTPS 地址。localhost 仅供本机使用，不能接收 LINE 回调。"
                    >
                      <div className="invite-result">
                        <code>
                          {location.origin}
                          {data.line.webhookPath}
                        </code>
                        <CopyButton
                          text={location.origin + data.line.webhookPath}
                        />
                      </div>
                    </Field>
                  )}
                  <div className="info-box">
                    只处理群里的 <code>/af 问题</code>、<code>/家族 问题</code>{" "}
                    和绑定指令。普通群聊消息不会保存。较长任务可能使用 LINE Push
                    推送，受官方账号消息额度限制。
                  </div>
                  {data?.line?.recentEvents?.length > 0 && (
                    <>
                      <h4>最近接收</h4>
                      {data.line.recentEvents.map((e: any) => (
                        <div className="audit-row" key={e.id}>
                          <span>
                            {new Date(e.createdAt).toLocaleTimeString()}
                          </span>
                          <span>{e.status}</span>
                          {e.error && <small>{e.error}</small>}
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <h3>权限与安全边界</h3>
              <div className="permission-list">
                <p>
                  <ShieldCheck size={18} />
                  <span>
                    <strong>工具按群、按伙伴开放</strong>
                    <br />
                    可查看时间、读取本群笔记、保存草稿。伙伴不能访问其他群或提升自己的权限。
                  </span>
                </p>
                <p>
                  <KeyRound size={18} />
                  <span>
                    <strong>密钥留在服务端</strong>
                    <br />
                    模型与 LINE 凭据加密保存。管理员可以替换，不能从页面读回。
                  </span>
                </p>
                <p>
                  <UsersRound size={18} />
                  <span>
                    <strong>外部操作由人掌握</strong>
                    <br />
                    本版不执行终端命令、不自动发布代码、不写入公司业务系统。生成代码可保存为草稿并下载。
                  </span>
                </p>
              </div>
              <h4>最近操作</h4>
              {isAdmin ? (
                <div className="audit-list">
                  {audits.data?.length ? (
                    audits.data.map((a) => (
                      <div className="audit-row" key={a.id}>
                        <span>{a.actor}</span>
                        <span>{a.action}</span>
                        <small>{new Date(a.createdAt).toLocaleString()}</small>
                      </div>
                    ))
                  ) : (
                    <p className="hint">还没有操作记录。</p>
                  )}
                </div>
              ) : (
                <p className="hint">操作记录由管理员查看。</p>
              )}
            </>
          )}
        </div>
      </div>
      {provider && (
        <ProviderEditor
          provider={provider}
          onClose={() => setProvider(null)}
          onSaved={() => {
            setProvider(null);
            void client.invalidateQueries();
          }}
        />
      )}
    </Modal>
  );
}
function ProviderEditor({
  provider,
  onClose,
  onSaved,
}: {
  provider: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    ...provider,
    models: provider.models.join("\n"),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (key: string, value: string) =>
    setForm((f: any) => ({ ...f, [key]: value }));
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title={provider.id ? "编辑模型服务" : "添加模型服务"}
      description="密钥仅用于服务器连接模型，保存后不再返回。"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("/api/settings/providers", {
              method: "PUT",
              body: JSON.stringify({
                ...form,
                models: form.models
                  .split(/[\n,]/)
                  .map((s: string) => s.trim())
                  .filter(Boolean),
                apiKey: form.apiKey || undefined,
              }),
            });
            toast.success("模型服务已保存");
            onSaved();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBox error={error} />
        <Field
          label="服务名称"
          hint="使用英文字母、数字、短横线，例如 canal 或 my-openai。"
        >
          <input
            value={form.id}
            required
            maxLength={40}
            disabled={!!provider.id}
            pattern="[a-zA-Z0-9_-]+"
            onChange={(e) => update("id", e.target.value)}
          />
        </Field>
        <Field label="接口类型">
          <select
            value={form.kind}
            onChange={(e) => {
              const kind = e.target.value;
              setForm((f: any) => ({
                ...f,
                kind,
                baseUrl: {
                  compatible: "https://api.canalapi.com/v1",
                  openai: "https://api.openai.com/v1",
                  anthropic: "https://api.anthropic.com/v1",
                  google: "https://generativelanguage.googleapis.com/v1beta",
                }[kind],
              }));
            }}
          >
            <option value="compatible">OpenAI 兼容（含 CanalAPI）</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic / Claude</option>
            <option value="google">Google / Gemini</option>
          </select>
        </Field>
        <Field label="服务地址">
          <input
            type="url"
            required
            value={form.baseUrl}
            onChange={(e) => update("baseUrl", e.target.value)}
          />
        </Field>
        <Field
          label="API 密钥"
          hint={provider.id ? "留空沿用已保存密钥。" : undefined}
        >
          <input
            type="password"
            required={!provider.id}
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => update("apiKey", e.target.value)}
          />
        </Field>
        <Field
          label="模型名称"
          hint="每行一个完整模型 ID。兼容服务可保存后点击「读取可用模型」。"
        >
          <textarea
            rows={4}
            value={form.models}
            onChange={(e) => update("models", e.target.value)}
            placeholder="填写服务商实际支持的模型名称"
          />
        </Field>
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "保存中…" : "保存服务"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function LineDialog({
  room,
  onClose,
  onSettings,
}: {
  room: Room;
  onClose: () => void;
  onSettings: () => void;
}) {
  const client = useQueryClient();
  const state = useQuery({
    queryKey: ["room-line", room.id],
    queryFn: () => api(`/api/rooms/${room.id}/line`),
    refetchInterval: 3000,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shareContext, setShareContext] = useState(false);
  const [policy, setPolicy] = useState<{
    mode: Mode;
    shareTools: boolean;
    discussion: DiscussionSettings;
  } | null>(null);
  const selectedPolicy = policy || {
    mode: state.data?.mode || "parallel",
    shareTools: !!state.data?.shareTools,
    discussion: state.data?.discussion || DEFAULT_DISCUSSION,
  };
  async function action(url: string, method = "POST", body: unknown = {}) {
    setBusy(true);
    setError("");
    try {
      await api(url, {
        method,
        body: method !== "DELETE" ? JSON.stringify(body) : undefined,
      });
      await client.invalidateQueries();
      setPolicy(null);
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
      title="连接 LINE 群聊"
      description={`将「${room.name}」与一个 LINE 群连接。`}
    >
      <ErrorBox error={error || state.error?.message} />
      <div className="line-dialog-icon">
        <Link2 size={28} />
      </div>
      <fieldset className="line-policy-fields" disabled={busy}>
        <Field
          label="LINE 默认聊天方式"
          hint="独立于网页发送框；未点名的单人模式由第一位启用伙伴回答。"
        >
          <select
            value={selectedPolicy.mode}
            onChange={(e) =>
              setPolicy({ ...selectedPolicy, mode: e.target.value as Mode })
            }
          >
            {(Object.keys(MODE_LABELS) as Mode[]).map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </Field>
        {selectedPolicy.mode === "free" && (
          <>
            <DiscussionFields
              value={selectedPolicy.discussion}
              onChange={(discussion) =>
                setPolicy({ ...selectedPolicy, discussion })
              }
            />
            <p className="hint">
              群内可用 /af 停止、/af 状态、/af 轮数 5（或 无限制）、/af 额度
              30。修改默认设置只影响下一次讨论，当前讨论用上述指令或网页「调整讨论」。
            </p>
          </>
        )}
        <label className="check-field">
          <input
            type="checkbox"
            checked={selectedPolicy.shareTools}
            onChange={(e) =>
              setPolicy({ ...selectedPolicy, shareTools: e.target.checked })
            }
          />
          <span>
            允许 LINE 群成员通过工具使用本群全部笔记和项目（包含绑定前资料）
          </span>
        </label>
      </fieldset>
      <p className="hint">
        默认只读取本次绑定后的 LINE 对话，不读取网页发言。更改资料共享开关会清空
        LINE 可用上下文、停止旧任务的后续访问；网页记录保留。
      </p>
      {state.data?.resources && (
        <p className="hint">
          网页现有 {state.data.resources.messages} 条消息、
          {state.data.resources.notes} 份笔记、{state.data.resources.files}{" "}
          个项目文件。建议为 LINE 新建专用群。
        </p>
      )}
      {state.data?.usage && (
        <p className="hint">
          LINE 今日已用 {state.data.usage.lineCalls} 次，预留{" "}
          {state.data.usage.lineReserved} 次，上限 {state.data.usage.lineLimit}{" "}
          次；同时受空间总额度约束，不含 LINE 消息费用。
        </p>
      )}
      {state.data?.linked ? (
        <>
          <h3 className="center">这个群已经连接 LINE</h3>
          <p className="muted center">
            在 LINE 群发送 <code>/af 你的问题</code>{" "}
            即可邀请伙伴回答。点名时使用 <code>/af @小文 你的问题</code>。
          </p>
          <div className="info-box">
            LINE 对话会保存到网页。只有明确开启资料共享后，笔记和项目才可进入
            LINE 回答；该权限面向整个 LINE 群，而非某一位成员。
          </div>
          <button
            className="button primary full"
            disabled={busy || !policy}
            onClick={() =>
              action(`/api/rooms/${room.id}/line`, "PATCH", selectedPolicy)
            }
          >
            保存 LINE 设置
          </button>
          <button
            className="button danger full"
            disabled={busy}
            onClick={() => action(`/api/rooms/${room.id}/line`, "DELETE")}
          >
            解除连接
          </button>
        </>
      ) : (
        <>
          <ol className="setup-steps">
            <li>管理员先配置 LINE 官方账号，并将它邀请进目标群。</li>
            <li>生成绑定码，在目标 LINE 群发送指令。</li>
            <li>回到这里确认。绑定码 10 分钟有效。</li>
          </ol>
          {state.data?.challenge ? (
            <div className="binding-code">
              <span>在 LINE 群发送</span>
              <code>/绑定 {state.data.challenge.code}</code>
              <CopyButton
                text={`/绑定 ${state.data.challenge.code}`}
                label="复制指令"
              />
              <p className="hint">
                {state.data.challenge.received
                  ? `收到来自「${state.data.challenge.groupName || "LINE 群"}」的请求，请确认目标群。`
                  : "等待 LINE 群发来绑定请求…"}
              </p>
            </div>
          ) : (
            <button
              className="button primary full"
              disabled={busy}
              onClick={() => action(`/api/rooms/${room.id}/line/challenge`)}
            >
              生成绑定码
            </button>
          )}
          {state.data?.challenge?.received ? (
            <>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={shareContext}
                  onChange={(e) => setShareContext(e.target.checked)}
                />
                <span>
                  我已告知群成员：LINE
                  对话会保存到网页，并按上方选择的范围使用资料
                </span>
              </label>
              <button
                className="button primary full"
                disabled={busy || !shareContext}
                onClick={() =>
                  action(`/api/rooms/${room.id}/line/confirm`, "POST", {
                    shareContext: true,
                    ...selectedPolicy,
                  })
                }
              >
                确认连接此群
              </button>
            </>
          ) : null}
          <div className="info-box">
            确认后，LINE 群成员使用 /af
            发送的内容将保存在网页并发送给模型服务。默认不读取绑定前对话、网页消息、笔记和项目；请先告知群成员。
          </div>
          <button className="text-button full" onClick={onSettings}>
            打开 LINE 服务设置
          </button>
        </>
      )}
    </Modal>
  );
}
