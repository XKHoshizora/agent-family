import { DiscussionFields, DiscussionEditor } from "./Discussion";
import { DEFAULT_DISCUSSION } from "../shared/types";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  MessageCircle,
  Settings2,
  Link2,
  Menu,
  UsersRound,
  ChevronDown,
  ArrowUp,
  Square,
  Paperclip,
  X,
  MoreHorizontal,
  ArrowDown,
  Download,
  BookOpen,
  Check,
  LockKeyhole,
  Globe,
  Lightbulb,
  PenLine,
  Code2,
  BriefcaseBusiness,
  Archive,
  ArrowRight,
  FileText,
  Trash2,
  RefreshCw,
  PanelRightClose,
} from "lucide-react";
import { toast } from "sonner";
import { api, post, patch, setWorkspace, download, workspaceId } from "./api";
import {
  Avatar,
  Logo,
  Modal,
  Field,
  ErrorBox,
  Drawer,
  Spinner,
  Markdown,
  CopyButton,
} from "./components";
import { Auth } from "./Auth";
import { Settings, LineDialog } from "./Settings";
import { Project } from "./Project";
import { planExecution, mentionedAgents } from "../shared/execution";
import {
  MODE_LABELS,
  COLORS,
  type Agent,
  type Room,
  type Message,
  type Run,
  type Note,
  type ModelOption,
  type Mode,
  type UserSession,
} from "../shared/types";
type RoomDetail = {
  room: Room;
  messages: Message[];
  runs: Run[];
  notes: Note[];
  pendingChanges: number;
};
type Me = UserSession & {
  workspaces: { id: string; name: string; role: string }[];
};
export function App() {
  const client = useQueryClient();
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: () => api("/api/setup/status"),
  });
  const me = useQuery({
    queryKey: ["me", workspaceId],
    queryFn: () => api<Me>("/api/me"),
  });
  const invite = new URLSearchParams(location.search).get("invite");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  useEffect(() => {
    const expire = () => {
      void client.invalidateQueries({ queryKey: ["me"] });
    };
    window.addEventListener("af-auth-expired", expire);
    return () => window.removeEventListener("af-auth-expired", expire);
  }, [client]);
  if (setup.isPending || me.isPending)
    return (
      <div className="full-loading">
        <Logo />
        <Spinner label="正在打开你的空间" />
      </div>
    );
  if (!me.data || [401, 403].includes((me.error as any)?.status))
    return <Auth setup={!!setup.data?.required} invite={invite} />;
  if (invite)
    return (
      <div className="invite-page">
        <Logo />
        <h1>加入新的工作空间</h1>
        <p className="muted">使用当前账户 {me.data.user.email} 接受邀请。</p>
        <ErrorBox error={joinError} />
        <div className="button-row">
          <button
            className="button"
            onClick={() => {
              history.replaceState(null, "", location.pathname);
              location.reload();
            }}
          >
            暂不加入
          </button>
          <button
            className="button primary"
            disabled={joining}
            onClick={async () => {
              setJoining(true);
              try {
                const r = await post("/api/invites/accept", { token: invite });
                setWorkspace(r.workspaceId);
                history.replaceState(null, "", location.pathname);
                await client.invalidateQueries();
                location.reload();
              } catch (e: any) {
                setJoinError(e.message);
                setJoining(false);
              }
            }}
          >
            接受邀请
          </button>
        </div>
      </div>
    );
  return <Workspace me={me.data} />;
}
function Workspace({ me }: { me: Me }) {
  const client = useQueryClient();
  const rooms = useQuery({
    queryKey: ["rooms", me.workspace.id],
    queryFn: () => api<Room[]>("/api/rooms"),
  });
  const models = useQuery({
    queryKey: ["models", me.workspace.id],
    queryFn: () => api<ModelOption[]>("/api/models"),
  });
  const [selected, setSelected] = useState(
    localStorage.getItem(`af-room-${me.workspace.id}`) || "",
  );
  const roomId = rooms.data?.some((r) => r.id === selected)
    ? selected
    : rooms.data?.[0]?.id;
  const detail = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => api<RoomDetail>(`/api/rooms/${roomId}`),
    enabled: !!roomId,
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) =>
        ["running", "queued"].includes(r.status),
      )
        ? 5000
        : false,
  });
  const room = detail.data?.room;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [settings, setSettings] = useState<
    false | "general" | "models" | "members" | "line" | "security"
  >(false);
  const [lineOpen, setLineOpen] = useState(false);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [editRoom, setEditRoom] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("free");
  const [discussion, setDiscussion] = useState(DEFAULT_DISCUSSION);
  const [editDiscussion, setEditDiscussion] = useState(false);
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const [draftRun, setDraftRun] = useState<string | null>(null);
  const [shareToLine, setShareToLine] = useState(false);
  const submission = useRef<{
    runId: string;
    content: string;
    share: boolean;
    id: string;
  } | null>(null);
  const [attachment, setAttachment] = useState<{
    name: string;
    content: string;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [nearBottom, setNearBottom] = useState(true);
  const [connection, setConnection] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const firstScroll = useRef(true);
  const canWrite = me.workspace.role !== "viewer";
  const canEdit =
    !!room &&
    (room.createdBy === me.user.id ||
      ["owner", "admin"].includes(me.workspace.role));
  const active = detail.data?.runs.find((r) =>
    ["running", "queued"].includes(r.status),
  );
  const canInterject = active?.mode === "free";
  const messages = detail.data?.messages || [];
  const lastRun = detail.data?.runs[0];
  const enabledAgents = room?.agents.filter((a) => a.enabled) || [];
  let planned: ReturnType<typeof planExecution> | undefined;
  let planningError = "";
  try {
    planned = planExecution(
      enabledAgents,
      message + (attachment?.content || ""),
      mode,
      mode === "single" ? [target || enabledAgents[0]?.id] : undefined,
    );
  } catch (e: any) {
    planningError = e.message;
  }
  const directMentions = mentionedAgents(enabledAgents, message);
  useEffect(() => {
    if (mode === "single" && directMentions.length === 1)
      setTarget(directMentions[0].id);
  }, [mode, message, roomId]);
  useEffect(() => {
    setMode("free");
    setTarget("");
    setDiscussion(DEFAULT_DISCUSSION);
    setEditDiscussion(false);
    setDraftRun(null);
    setShareToLine(false);
    submission.current = null;
    setMessage(sessionStorage.getItem(`af-draft-${roomId}`) || "");
    setAttachment(null);
    setSendError("");
    firstScroll.current = true;
    setNearBottom(true);
  }, [roomId]);
  useEffect(() => {
    if (!message.trim() && !attachment) setDraftRun(null);
  }, [message, attachment]);
  useEffect(() => {
    if (roomId) sessionStorage.setItem(`af-draft-${roomId}`, message);
  }, [message, roomId]);
  useEffect(() => {
    if (!roomId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource(`/api/rooms/${roomId}/events`);
    source.addEventListener("ready", () => setConnection(true));
    source.addEventListener("change", () => {
      setConnection(true);
      if (!timer)
        timer = setTimeout(() => {
          void client.invalidateQueries({ queryKey: ["room", roomId] });
          timer = undefined;
        }, 650);
    });
    source.onerror = () => {
      setConnection(false);
      void client.invalidateQueries({ queryKey: ["me"] });
    };
    const closeStream = () => source.close();
    window.addEventListener("af-logout", closeStream);
    return () => {
      source.close();
      window.removeEventListener("af-logout", closeStream);
      if (timer) clearTimeout(timer);
    };
  }, [roomId, client]);
  useEffect(() => {
    const el = scroller.current;
    if (el && (nearBottom || firstScroll.current)) {
      el.scrollTop = el.scrollHeight;
      firstScroll.current = false;
    }
  }, [detail.data, nearBottom]);
  useEffect(() => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height = `${Math.min(input.current.scrollHeight, 180)}px`;
    }
  }, [message]);
  function selectRoom(id: string) {
    setSelected(id);
    localStorage.setItem(`af-room-${me.workspace.id}`, id);
    setSidebarOpen(false);
  }
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (
      !room ||
      !canWrite ||
      sending ||
      (active && !canInterject) ||
      (!message.trim() && !attachment)
    )
      return;
    setSendError("");
    const content =
      message.trim() +
      (attachment
        ? `\n\n[文本附件：${attachment.name}]\n${attachment.content}`
        : "");
    if (content.length > 12000) {
      setSendError("内容加附件最多 12,000 字符，请适当精简。");
      return;
    }
    const joinRunId = canInterject ? active.id : draftRun;
    if (!joinRunId && !enabledAgents.length) {
      setSendError("请先启用至少一位伙伴。");
      return;
    }
    if (!joinRunId && (planningError || !planned)) {
      setSendError(planningError);
      return;
    }
    if (!joinRunId && planned?.agents.some((a) => !a.model)) {
      setSendError("请先给每位启用的伙伴选择模型。");
      return;
    }
    if (joinRunId && active?.source === "line" && !shareToLine) {
      setSendError("请先勾选将这条补充分享给 LINE 群。");
      return;
    }
    if (
      joinRunId &&
      (!submission.current ||
        submission.current.runId !== joinRunId ||
        submission.current.content !== content ||
        submission.current.share !== shareToLine)
    )
      submission.current = {
        runId: joinRunId,
        content,
        share: shareToLine,
        id: crypto.randomUUID(),
      };
    const sentText = message,
      sentAttachment = attachment;
    setSending(true);
    try {
      await post(
        `/api/rooms/${room.id}/messages`,
        joinRunId
          ? {
              content,
              runId: joinRunId,
              clientMessageId: submission.current!.id,
              shareToLine,
            }
          : {
              content,
              mode,
              ...(mode === "free" ? { discussion } : {}),
              ...(mode === "single"
                ? { targets: planned!.agents.map((a) => a.id) }
                : {}),
            },
      );
      setMessage((current) => (current === sentText ? "" : current));
      setAttachment((current) => (current === sentAttachment ? null : current));
      setShareToLine(false);
      submission.current = null;
      if (!joinRunId) setDraftRun(null);
      if (joinRunId) toast("补充已加入当前讨论");
      setNearBottom(true);
      await client.invalidateQueries({ queryKey: ["room", room.id] });
      await client.invalidateQueries({ queryKey: ["rooms"] });
    } catch (e: any) {
      setSendError(e.message);
    } finally {
      setSending(false);
    }
  }
  async function stop() {
    if (!room || !active) return;
    try {
      await post(`/api/rooms/${room.id}/cancel`, { runId: active.id });
      await client.invalidateQueries({ queryKey: ["room", room.id] });
      toast("已停止，生成的内容会保留");
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  async function attach(file?: File) {
    if (!file) return;
    if (file.size > 80000) {
      toast.error("请选择 80 KB 以内的文本文件。");
      return;
    }
    if (
      !/\.(txt|md|csv|json|js|ts|tsx|jsx|py|html|css|sql|yaml|yml|xml|log)$/i.test(
        file.name,
      )
    ) {
      toast.error("暂支持文本、Markdown、CSV、JSON 和代码文件。");
      return;
    }
    const content = await file.text();
    if (content.includes("\u0000")) {
      toast.error("无法读取二进制文件，请使用文本文件。");
      return;
    }
    if (content.length > 10000) {
      toast.error("附件文字最多 10,000 字符，请精简后再上传。");
      return;
    }
    setAttachment({ name: file.name, content });
    input.current?.focus();
  }
  const sidebar = (
    <>
      <div className="sidebar-top">
        <Logo />
        <button
          className="icon-button mobile-only"
          aria-label="关闭群聊列表"
          onClick={() => setSidebarOpen(false)}
        >
          <X size={20} />
        </button>
      </div>
      <button
        className="new-chat"
        onClick={() => setNewRoom(true)}
        disabled={!canWrite}
      >
        <Plus size={19} />
        新建群聊
      </button>
      <div className="sidebar-section-label">
        我的群聊 <span>{rooms.data?.length || 0}</span>
      </div>
      <nav className="room-list" aria-label="群聊列表">
        {rooms.isPending ? (
          <Spinner />
        ) : rooms.error ? (
          <ErrorBox error={rooms.error.message} />
        ) : (
          rooms.data?.map((r) => (
            <button
              className={`room-link ${r.id === roomId ? "selected" : ""}`}
              key={r.id}
              onClick={() => selectRoom(r.id)}
            >
              <MessageCircle size={18} />
              <span>{r.name}</span>
              {r.visibility === "team" && (
                <UsersRound size={13} className="room-meta-icon" />
              )}
              {r.lineLinked && (
                <span className="tiny-dot" title="已连接 LINE" />
              )}
            </button>
          ))
        )}
        {rooms.data?.length === 0 && (
          <p className="sidebar-empty">
            还没有群聊。
            <br />
            为一个想法，邀请几位伙伴吧。
          </p>
        )}
      </nav>
      <div className="sidebar-bottom">
        <button
          className="sidebar-action"
          onClick={() =>
            room && canEdit ? setLineOpen(true) : setSettings("line")
          }
        >
          <Link2 size={18} />
          <span>连接 LINE</span>
          <ArrowRight size={14} />
        </button>
        <button
          className="sidebar-action"
          onClick={() => setSettings("general")}
        >
          <Settings2 size={18} />
          <span>设置</span>
        </button>
        <div className="profile-area">
          <button
            className="profile-button"
            onClick={() => setSettings("general")}
          >
            <Avatar name={me.user.name} color="neutral" size="small" />
            <span>
              <strong>{me.user.name}</strong>
              <small>{me.workspace.name}</small>
            </span>
            <ChevronDown size={15} />
          </button>
          {me.workspaces.length > 1 && (
            <select
              aria-label="切换工作空间"
              value={me.workspace.id}
              onChange={(e) => {
                setWorkspace(e.target.value);
                location.reload();
              }}
            >
              {me.workspaces.map((w) => (
                <option value={w.id} key={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </>
  );
  const members = room && (
    <>
      <div className="members-heading">
        <h2>群里的伙伴</h2>
        <div>
          {canEdit && room.agents.length < 5 && (
            <button
              className="icon-button"
              aria-label="添加 AI 伙伴"
              onClick={() =>
                setEditAgent({
                  id: crypto.randomUUID(),
                  name: "新伙伴",
                  model: models.data?.[0]?.id || "",
                  provider: models.data?.[0]?.provider || "canal",
                  persona: "用清晰、实用的语言帮助用户，保持独立判断。",
                  color: COLORS[room.agents.length % COLORS.length],
                  enabled: true,
                  tools: false,
                })
              }
            >
              <Plus size={18} />
            </button>
          )}
          <button
            className="icon-button drawer-close"
            aria-label="关闭伙伴列表"
            onClick={() => setMembersOpen(false)}
          >
            <PanelRightClose size={18} />
          </button>
        </div>
      </div>
      <div className="agent-list">
        {room.agents.map((a) => (
          <div
            className={`agent-item ${a.enabled ? "" : "disabled"}`}
            key={a.id}
          >
            <button
              className="agent-identity"
              onClick={() =>
                canEdit
                  ? setEditAgent(a)
                  : toast("只有群聊创建者或管理员可以修改伙伴")
              }
              aria-label={`设置伙伴 ${a.name}`}
            >
              <Avatar name={a.name} color={a.color} />
              <span>
                <strong>{a.name}</strong>
                <small title={a.model || "待选择模型"}>
                  {a.model ? modelFamily(a.model) : "待选择模型"} ·{" "}
                  {a.persona.includes("代码") || a.name === "开发者"
                    ? "开发创作"
                    : a.color === "sage"
                      ? "理清思路"
                      : a.color === "clay"
                        ? "表达创作"
                        : "多角度探索"}
                </small>
              </span>
            </button>
            {canEdit && (
              <button
                className="icon-button"
                aria-label={`编辑 ${a.name}`}
                onClick={() => setEditAgent(a)}
              >
                <MoreHorizontal size={18} />
              </button>
            )}
          </div>
        ))}
      </div>
      {models.data?.length === 0 && (
        <div className="model-setup-callout">
          <p>先连接模型，让伙伴开始思考。</p>
          <button
            className="button compact full"
            onClick={() => setSettings("models")}
          >
            设置模型服务 <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="panel-divider" />
      <h3 className="panel-label">聊天方式</h3>
      <div className="mode-options" role="radiogroup" aria-label="聊天方式">
        {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={mode === m}
            className={mode === m ? "chosen" : ""}
            onClick={() => setMode(m)}
          >
            <span className="radio-dot">{mode === m && <span />}</span>
            <span>{MODE_LABELS[m]}</span>
          </button>
        ))}
      </div>
      <p className="mode-explanation">
        {mode === "parallel"
          ? "先独立回答，再比较不同观点。"
          : mode === "free"
            ? "伙伴可以点名、提问和接话；逐个发言，随时调整轮数和额度。"
            : mode === "discuss"
              ? "先各自思考，再互相回应一轮。最多两轮，随时可以停止。"
              : "选择一位伙伴，或在输入框里 @ 点名。"}
      </p>
      <div className="panel-divider" />
      <div className="line-panel">
        <div className="line-panel-title">
          <Link2 size={18} />
          <h3>{room.lineLinked ? "已连接 LINE" : "把这个群带到 LINE"}</h3>
        </div>
        <p>
          {room.lineLinked
            ? "在 LINE 群里发送 /af 问题，继续和伙伴聊。"
            : "熟悉的群聊，多几个好伙伴。"}
        </p>
        <button
          className="button full"
          onClick={() => (canEdit ? setLineOpen(true) : setSettings("line"))}
        >
          {room.lineLinked ? "管理连接" : "连接群聊"}
          <ArrowRight size={14} />
        </button>
      </div>
      <div className="members-foot">
        <LockKeyhole size={13} />
        <span>
          {room.lineLinked
            ? "已共享给 LINE 群"
            : room.visibility === "private"
              ? "私人群聊，仅你可见"
              : "团队群聊，空间成员可见"}
        </span>
      </div>
    </>
  );
  return (
    <div className="workspace">
      <aside className="sidebar desktop-sidebar">{sidebar}</aside>
      <Drawer
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        title="群聊列表"
        side="left"
      >
        {sidebar}
      </Drawer>
      <main className="conversation">
        <header className="chat-header">
          <button
            className="icon-button mobile-only"
            aria-label="打开群聊列表"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={21} />
          </button>
          <div className="chat-title">
            <h1>
              <span className="room-name">{room?.name || "你的 AI 群聊"}</span>
              {room?.visibility === "private" ? (
                <LockKeyhole size={13} />
              ) : (
                room && <UsersRound size={14} />
              )}
            </h1>
            <p>{room?.description || "多个视角，一起想得更远"}</p>
          </div>
          <div className="header-actions">
            {room && (
              <>
                {room.projectMode !== "off" && (
                  <button
                    className="icon-button"
                    title="项目工作台"
                    aria-label="打开项目工作台"
                    onClick={() => setProjectOpen(true)}
                  >
                    <Code2 size={19} />
                    {detail.data?.pendingChanges ? (
                      <span className="count-dot">
                        {detail.data.pendingChanges}
                      </span>
                    ) : null}
                  </button>
                )}
                <button
                  className="icon-button"
                  title="群聊笔记"
                  aria-label="打开群聊笔记"
                  onClick={() => setNotesOpen(true)}
                >
                  <BookOpen size={19} />
                  {detail.data?.notes.length ? (
                    <span className="count-dot">
                      {detail.data.notes.length}
                    </span>
                  ) : null}
                </button>
                <button
                  className="icon-button show-members"
                  aria-label="打开伙伴列表"
                  onClick={() => setMembersOpen(true)}
                >
                  <UsersRound size={20} />
                </button>
                <button
                  className="icon-button"
                  aria-label="群聊设置与导出"
                  title="群聊设置与导出"
                  onClick={() => setEditRoom(true)}
                >
                  <MoreHorizontal size={21} />
                </button>
              </>
            )}
          </div>
        </header>
        {!connection && roomId && (
          <div className="connection-banner">
            正在重新连接。已发送的内容会保留，回答状态会自动刷新。
          </div>
        )}
        {detail.isPending && roomId ? (
          <div className="full-loading">
            <Spinner label="正在读取群聊" />
          </div>
        ) : detail.error ? (
          <div className="center-state">
            <ErrorBox error={detail.error.message} />
            <button className="button" onClick={() => detail.refetch()}>
              重新加载
            </button>
          </div>
        ) : !room ? (
          <div className="center-state">
            <div className="welcome-symbol">
              <MessageCircle size={36} />
            </div>
            <h2>为新的想法，开一个群</h2>
            <p>邀请几位不同的 AI 伙伴，一起聊聊。</p>
            <button
              className="button primary"
              disabled={!canWrite}
              onClick={() => setNewRoom(true)}
            >
              <Plus size={17} />
              创建第一个群聊
            </button>
          </div>
        ) : (
          <>
            <div
              className="message-scroller"
              ref={scroller}
              onScroll={() => {
                const el = scroller.current;
                if (el)
                  setNearBottom(
                    el.scrollHeight - el.scrollTop - el.clientHeight < 150,
                  );
              }}
            >
              {messages.length === 0 ? (
                <div className="empty-conversation">
                  <div className="welcome-avatars">
                    {room.agents
                      .filter((a) => a.enabled)
                      .slice(0, 3)
                      .map((a) => (
                        <Avatar
                          key={a.id}
                          name={a.name}
                          color={a.color}
                          size="large"
                        />
                      ))}
                  </div>
                  <h2>一个问题，听听大家怎么说</h2>
                  <p>点名一位伙伴，或邀请大家一起讨论。</p>
                  <div className="suggestions">
                    {[
                      {
                        icon: Lightbulb,
                        label: "一起想个好主意",
                        text: "我想做一件有意思的新事情。请从各自的角度，帮我想几个值得尝试的方向。",
                      },
                      {
                        icon: ArrowRight,
                        label: "帮我比较几个选择",
                        text: "我正在几个选择之间犹豫。请先问我最关键的问题，再帮我比较利弊。",
                      },
                      {
                        icon: MessageCircle,
                        label: "从不同角度看问题",
                        text: "我有一个想法，想听听不同意见。请分别从实用性、创造性和潜在风险来帮我分析。",
                      },
                    ].map((s) => (
                      <button
                        key={s.label}
                        onClick={() => {
                          setMessage(s.text);
                          input.current?.focus();
                        }}
                      >
                        <s.icon size={16} />
                        {s.label}
                      </button>
                    ))}
                  </div>
                  {!enabledAgents.some((a) => a.model) && (
                    <button
                      className="setup-reminder"
                      onClick={() => setSettings("models")}
                    >
                      <KeyRoundIcon />
                      开始之前，先为伙伴连接模型 <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              ) : (
                <div className="messages">
                  <div className="conversation-start">
                    <span>
                      对话开始于{" "}
                      {new Date(messages[0].createdAt).toLocaleDateString(
                        "zh-CN",
                      )}
                    </span>
                  </div>
                  {messages.map((m, index) => (
                    <MessageView
                      key={m.id}
                      message={m}
                      onProject={
                        room.projectMode !== "off"
                          ? () => setProjectOpen(true)
                          : undefined
                      }
                      replyAuthor={
                        messages.find((p) => p.id === m.discussion?.replyTo)
                          ?.author
                      }
                      nextAuthor={
                        room.agents.find(
                          (a) => a.id === m.discussion?.nextAgentId,
                        )?.name
                      }
                      agent={room.agents.find((a) => a.id === m.agentId)}
                      showRound={
                        m.role === "assistant" &&
                        index > 0 &&
                        messages
                          .slice(0, index)
                          .some(
                            (prev) =>
                              prev.runId === m.runId &&
                              prev.agentId === m.agentId &&
                              prev.role === "assistant",
                          )
                      }
                      onSave={
                        canWrite
                          ? () => {
                              setNotesOpen(true);
                              sessionStorage.setItem(
                                "af-note-draft",
                                m.content,
                              );
                            }
                          : undefined
                      }
                    />
                  ))}
                  {active && (
                    <div className="run-status">
                      <span className="breathing-dot" />
                      伙伴们正在思考
                      <span>
                        {canInterject ? "可以随时插话或停止" : "可以随时停止"}
                      </span>
                    </div>
                  )}
                  {lastRun?.notice && (
                    <div className="run-notice">{lastRun.notice}</div>
                  )}
                  {lastRun &&
                    ["partial", "failed", "interrupted"].includes(
                      lastRun.status,
                    ) && (
                      <div className="run-notice">
                        {lastRun.error ||
                          "这轮没有全部完成。你可以重新发送，或在伙伴设置中换一个模型。"}
                      </div>
                    )}
                </div>
              )}
            </div>
            {!nearBottom && (
              <button
                className="jump-bottom"
                onClick={() => {
                  setNearBottom(true);
                  scroller.current?.scrollTo({
                    top: scroller.current.scrollHeight,
                    behavior: "smooth",
                  });
                }}
              >
                <ArrowDown size={15} />
                回到最新
              </button>
            )}
            <div className="composer-wrap">
              <ErrorBox error={sendError} />
              {attachment && (
                <div className="attachment-chip">
                  <FileText size={14} />
                  <span>{attachment.name}</span>
                  <small>
                    {attachment.content.length.toLocaleString()} 字符
                  </small>
                  <button
                    className="icon-button"
                    aria-label="移除附件"
                    onClick={() => setAttachment(null)}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              {active?.mode === "free" && active.discussion && (
                <div className="discussion-progress" role="status">
                  <span>
                    自由讨论 · 已发言 {active.turns || 0} 次 · 调用{" "}
                    {active.callsUsed || 0}/{active.discussion.maxCalls} 次 ·{" "}
                    {active.discussion.maxRounds === null
                      ? "不限轮数"
                      : `最多 ${active.discussion.maxRounds} 轮`}
                  </span>
                  {canWrite && (
                    <button
                      className="button ghost"
                      onClick={() => setEditDiscussion(true)}
                    >
                      调整讨论
                    </button>
                  )}
                </div>
              )}
              {editDiscussion && active?.discussion && (
                <DiscussionEditor
                  run={active}
                  roomId={room.id}
                  onClose={() => setEditDiscussion(false)}
                  onSaved={() => {
                    void client.invalidateQueries({
                      queryKey: ["room", room.id],
                    });
                  }}
                />
              )}
              <form
                className={`composer ${active ? "busy" : ""}`}
                onSubmit={send}
              >
                <div className="composer-top">
                  <select
                    disabled={!!active}
                    value={active?.mode || mode}
                    onChange={(e) => setMode(e.target.value as Mode)}
                    aria-label="本轮聊天方式"
                  >
                    {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
                      <option key={m} value={m}>
                        {MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                  {mode === "single" && (
                    <select
                      value={target || enabledAgents[0]?.id || ""}
                      onChange={(e) => setTarget(e.target.value)}
                      aria-label="选择回答的伙伴"
                    >
                      {enabledAgents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <span className="composer-tip">
                    {mode === "discuss"
                      ? "每位伙伴最多两轮"
                      : "输入 @名字 可以点名"}
                  </span>
                </div>
                {mode === "free" && !active && (
                  <details className="discussion-options">
                    <summary>
                      讨论设置 ·{" "}
                      {discussion.maxRounds === null
                        ? "不限轮数"
                        : `${discussion.maxRounds} 轮`}{" "}
                      · 最多 {discussion.maxCalls} 次调用
                    </summary>
                    <DiscussionFields
                      value={discussion}
                      onChange={setDiscussion}
                    />
                  </details>
                )}
                <p className="composer-budget">
                  {active?.mode === "free" && active.discussion
                    ? `当前讨论已调用 ${active.callsUsed || 0}/${active.discussion.maxCalls} 次；未用预留会释放，可随时调整或停止。`
                    : mode === "free" && planned
                      ? `全部 ${planned.agents.length} 位伙伴参与，点名决定首位；每次发言按需预留，单次上限 ${discussion.maxCalls} 次调用。`
                      : planned
                        ? `本次 ${planned.minimum === planned.maximum ? planned.minimum : `${planned.minimum}–${planned.maximum}`} 次模型调用，预留最多 ${planned.maximum} 次；未使用部分会释放。${planned.notice}`
                        : planningError}
                </p>
                {canInterject && (
                  <p className="interjection-hint">
                    可直接补充要求或 @伙伴点名；当前发言会让出。
                    {active.pendingInputs
                      ? `还有 ${active.pendingInputs} 条补充等待回应。`
                      : ""}
                  </p>
                )}
                {canInterject && active.source === "line" && (
                  <label className="check-field interjection-share">
                    <input
                      type="checkbox"
                      checked={shareToLine}
                      onChange={(e) => setShareToLine(e.target.checked)}
                    />
                    将这条补充分享给 LINE 群，可能进入群内回答
                  </label>
                )}
                {!active && draftRun && message.trim() && (
                  <p className="interjection-hint">
                    原讨论已结束，补充草稿尚未发送。
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setDraftRun(null);
                        submission.current = null;
                      }}
                    >
                      改为新讨论草稿
                    </button>
                  </p>
                )}
                <textarea
                  ref={input}
                  aria-label="消息"
                  placeholder={
                    canWrite
                      ? canInterject
                        ? "补充要求，或 @伙伴点名接话…"
                        : "有什么想和大家聊的？"
                      : "你当前只有查看权限"
                  }
                  value={message}
                  onChange={(e) => {
                    setMessage(e.target.value);
                    if (canInterject) setDraftRun(active.id);
                    else if (!e.target.value.trim()) setDraftRun(null);
                  }}
                  maxLength={12000}
                  rows={2}
                  disabled={!canWrite}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    accept=".txt,.md,.csv,.json,.js,.ts,.tsx,.jsx,.py,.html,.css,.sql,.yaml,.yml,.xml,.log"
                    onChange={(e) => {
                      void attach(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button attachment-button"
                    aria-label="添加文本附件"
                    title="添加文本或代码附件（最多 80 KB）"
                    disabled={!canWrite}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Paperclip size={19} />
                  </button>
                  <span className="composer-keyhint">
                    {message.length > 10000
                      ? `${message.length.toLocaleString()} / 12,000`
                      : "Shift + Enter 换行"}
                  </span>
                  {active && (
                    <button
                      type="button"
                      className="stop-button"
                      onClick={stop}
                    >
                      <Square size={13} fill="currentColor" />
                      停止
                    </button>
                  )}
                  {(!active || canInterject) && (
                    <button
                      className="send-button"
                      aria-label={
                        canInterject || draftRun ? "发送补充" : "发送消息"
                      }
                      disabled={
                        sending || !canWrite || (!message.trim() && !attachment)
                      }
                    >
                      {sending ? (
                        <RefreshCw className="spin" size={18} />
                      ) : (
                        <ArrowUp size={21} />
                      )}
                    </button>
                  )}
                </div>
              </form>
              <p className="composer-disclaimer">
                AI 的回答可能有误，请核实重要信息。
                <span>内容会发送给所选模型服务。</span>
              </p>
            </div>
          </>
        )}
      </main>
      <aside className="members-panel desktop-members">{members}</aside>
      <Drawer
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        title="群里的伙伴"
        side="right"
      >
        {members}
      </Drawer>
      {newRoom && (
        <NewRoom
          onClose={() => setNewRoom(false)}
          onCreate={(id) => {
            setNewRoom(false);
            void client.invalidateQueries({ queryKey: ["rooms"] });
            selectRoom(id);
          }}
        />
      )}
      {settings && (
        <Settings
          key={settings}
          open
          onClose={() => setSettings(false)}
          me={me}
          initialTab={settings}
        />
      )}{" "}
      {room && lineOpen && (
        <LineDialog
          room={room}
          onClose={() => setLineOpen(false)}
          onSettings={() => {
            setLineOpen(false);
            setSettings("line");
          }}
        />
      )}
      {room && editAgent && (
        <AgentEditor
          agent={editAgent}
          room={room}
          models={models.data || []}
          onClose={() => setEditAgent(null)}
          onModels={() => {
            setEditAgent(null);
            setSettings("models");
          }}
          onSaved={() => {
            setEditAgent(null);
            void client.invalidateQueries({ queryKey: ["room", room.id] });
          }}
        />
      )}
      {room && editRoom && (
        <RoomSettings
          room={room}
          canEdit={canEdit}
          onClose={() => setEditRoom(false)}
          onChange={() => {
            setEditRoom(false);
            void client.invalidateQueries();
          }}
        />
      )}
      {room && notesOpen && (
        <Notes
          room={room}
          notes={detail.data?.notes || []}
          canWrite={canWrite}
          onClose={() => setNotesOpen(false)}
        />
      )}
      {room && projectOpen && (
        <Project
          room={room}
          canWrite={canWrite}
          canReview={canEdit}
          onClose={() => setProjectOpen(false)}
          onContinue={(prompt) => {
            setProjectOpen(false);
            setMessage(prompt);
            input.current?.focus();
          }}
        />
      )}
    </div>
  );
}
function KeyRoundIcon() {
  return <Settings2 size={14} />;
}
function modelFamily(model: string) {
  return /claude/i.test(model)
    ? "Claude"
    : /gemini/i.test(model)
      ? "Gemini"
      : /gpt|chatgpt|o[134]/i.test(model)
        ? "GPT"
        : model.split("/").pop();
}
function MessageView({
  message: m,
  agent,
  showRound,
  onSave,
  onProject,
  replyAuthor,
  nextAuthor,
}: {
  replyAuthor?: string;
  nextAuthor?: string;
  message: Message;
  agent?: Agent;
  showRound: boolean;
  onSave?: () => void;
  onProject?: () => void;
}) {
  const user = m.role === "user";
  return (
    <article
      id={`message-${m.id}`}
      className={`message ${user ? "user-message" : "agent-message"} ${m.status === "error" ? "message-error" : ""}`}
    >
      <Avatar
        name={m.author}
        color={user ? "neutral" : agent?.color || "sage"}
        size="small"
      />
      <div className="message-main">
        <div className="message-meta">
          <strong>{m.author}</strong>
          {m.model && (
            <span className="model-label" title={m.model}>
              {m.model}
            </span>
          )}
          {m.discussion ? (
            <span className="round-label">
              第 {m.round} 轮 · 发言 {m.discussion.turn}
            </span>
          ) : (
            showRound && <span className="round-label">回应伙伴</span>
          )}
          {m.source === "line" && <span className="tag">LINE</span>}
          {m.interjection && (
            <span className="tag interjection-state">
              {m.interjection.answeredBy ? "补充 · 已回应" : "补充 · 待回应"}
              {m.interjection.sharedToLine ? " · 已分享至 LINE" : ""}
            </span>
          )}
          <time dateTime={m.createdAt}>
            {new Date(m.createdAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        {m.discussion && (
          <div className="discussion-relation">
            {replyAuthor && (
              <a href={`#message-${m.discussion.replyTo}`}>
                接着 {replyAuthor} 的发言
              </a>
            )}
            {nextAuthor && <span> → 邀请 {nextAuthor} 接话</span>}
            {m.discussion.action === "pass" && <span> · 暂无补充</span>}
          </div>
        )}
        {m.toolEvents.length > 0 && (
          <div className="tool-events">
            {m.toolEvents.map((t, i) => (
              <span key={i}>
                {t.result === "未完成" ? (
                  <X size={12} />
                ) : t.result ? (
                  <Check size={12} />
                ) : (
                  <RefreshCw size={12} />
                )}{" "}
                {t.label}
                {t.result === "未完成" ? " · 未完成" : ""}
              </span>
            ))}
          </div>
        )}
        {!user && m.reasoning && (
          <details className="reasoning-panel">
            <summary>
              思考内容<span>模型提供</span>
            </summary>
            <div
              className="reasoning-content"
              tabIndex={0}
              role="region"
              aria-label={`${m.author}的思考内容`}
            >
              <Markdown text={m.reasoning} />
            </div>
          </details>
        )}
        {m.content ? (
          <Markdown text={m.content} />
        ) : m.status === "streaming" ? (
          <div
            className="thinking"
            role="status"
            aria-label={`${m.author}正在思考`}
          >
            <span />
            <span />
            <span />
          </div>
        ) : m.status === "complete" ? (
          <p className="message-state">本次未返回正式回答。</p>
        ) : null}
        {m.status === "streaming" && m.content && (
          <span className="stream-caret" aria-label="正在生成" />
        )}
        {m.status === "cancelled" && (
          <span className="message-state">已停止</span>
        )}
        {m.status !== "streaming" && m.content && (
          <div className="message-actions">
            <CopyButton text={m.content} />
            {onProject &&
              m.toolEvents.some(
                (t) =>
                  t.name === "propose_project_changes" && t.result === "已完成",
              ) && (
                <button className="text-button" onClick={onProject}>
                  <Code2 size={14} />
                  查看项目变更
                </button>
              )}
            {!user && onSave && (
              <button className="text-button" onClick={onSave}>
                <BookOpen size={14} />
                存为笔记
              </button>
            )}
            {m.tokens > 0 && <span>{m.tokens.toLocaleString()} tokens</span>}
          </div>
        )}
      </div>
    </article>
  );
}
function NewRoom({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("general");
  const [visibility, setVisibility] = useState("private");
  const [projectMode, setProjectMode] = useState("shared");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const templates = [
    {
      id: "general",
      name: "自由聊天",
      hint: "多个视角，碰撞灵感",
      icon: MessageCircle,
    },
    {
      id: "writing",
      name: "内容创作",
      hint: "策划、写作与编辑",
      icon: PenLine,
    },
    {
      id: "coding",
      name: "协作开发",
      hint: "架构、代码草稿与审查",
      icon: Code2,
    },
    {
      id: "business",
      name: "团队工作",
      hint: "整理方案，审视风险",
      icon: BriefcaseBusiness,
    },
  ];
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="邀请伙伴，开个新群"
      description="从一个想法开始，伙伴和模型随时可以调整。"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const r = await post<Room>("/api/rooms", {
              name:
                name.trim() || templates.find((t) => t.id === template)!.name,
              template,
              visibility,
              projectMode,
            });
            onCreate(r.id);
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBox error={error} />
        <Field label="群聊名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：我的灵感客厅"
            maxLength={60}
            autoFocus
          />
        </Field>
        <div className="field">
          <span>这次想一起做什么？</span>
          <div className="template-grid">
            {templates.map((t) => (
              <button
                type="button"
                key={t.id}
                className={template === t.id ? "active" : ""}
                onClick={() => setTemplate(t.id)}
              >
                <t.icon size={20} />
                <strong>{t.name}</strong>
                <small>{t.hint}</small>
              </button>
            ))}
          </div>
        </div>
        {template === "coding" && (
          <>
            <Field label="开发方式">
              <select
                value={projectMode}
                onChange={(e) => setProjectMode(e.target.value)}
              >
                <option value="shared">共同开发 · 围绕同一个项目协作</option>
                <option value="independent">
                  独立开发 · 每位伙伴使用自己的分支
                </option>
              </select>
            </Field>
            <p className="hint">
              代码变更先交由你审查，批准后保存到项目，可下载
              ZIP。当前不执行终端命令或自动部署。
            </p>
          </>
        )}
        <Field label="谁可以看到这个群">
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
          >
            <option value="private">仅自己 · 私人群聊</option>
            <option value="team">空间内所有成员 · 团队群聊</option>
          </select>
        </Field>
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "正在创建…" : "创建群聊"}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
function AgentEditor({
  agent,
  room,
  models,
  onClose,
  onSaved,
  onModels,
}: {
  agent: Agent;
  room: Room;
  models: ModelOption[];
  onClose: () => void;
  onSaved: () => void;
  onModels: () => void;
}) {
  const [form, setForm] = useState(agent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const exists = room.agents.some((a) => a.id === agent.id);
  const update = (key: string, value: any) =>
    setForm((f) => ({ ...f, [key]: value }));
  async function save(remove = false) {
    setBusy(true);
    setError("");
    try {
      const agents = remove
        ? room.agents.filter((a) => a.id !== agent.id)
        : exists
          ? room.agents.map((a) => (a.id === form.id ? form : a))
          : [...room.agents, form];
      await patch(`/api/rooms/${room.id}`, { agents });
      toast.success(remove ? "伙伴已离开此群，历史仍然保留" : "伙伴设置已保存");
      onSaved();
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
      title={exists ? "认识这位伙伴" : "邀请新伙伴"}
      description="名字和角色决定分工；模型决定实际使用的 AI 服务。"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ErrorBox error={error} />
        <div className="agent-editor-intro">
          <Avatar name={form.name} color={form.color} size="large" />
          <div className="color-options" aria-label="伙伴颜色">
            {COLORS.map((c) => (
              <button
                type="button"
                aria-label={`选择${{ sage: "绿色", clay: "橙色", blue: "蓝色", violet: "紫色", gold: "金色" }[c]}`}
                aria-pressed={form.color === c}
                className={`color-option ${c}`}
                key={c}
                onClick={() => update("color", c)}
              >
                {form.color === c && <Check size={15} />}
              </button>
            ))}
          </div>
        </div>
        <Field label="伙伴名字" hint="输入 @名字 可以单独邀请这位伙伴。">
          <input
            value={form.name}
            required
            maxLength={20}
            onChange={(e) => update("name", e.target.value)}
            pattern="[^\s@]+"
          />
        </Field>
        <Field label="使用的模型">
          <select
            required
            value={form.model ? `${form.provider}::${form.model}` : ""}
            onChange={(e) => {
              const [provider, ...rest] = e.target.value.split("::");
              setForm((f) => ({ ...f, provider, model: rest.join("::") }));
            }}
          >
            <option value="">请选择模型</option>
            {["GPT", "Claude", "Gemini", "其他"].map((family) => (
              <optgroup key={family} label={family}>
                {models
                  .filter((m) => m.family === family)
                  .map((m) => (
                    <option
                      key={m.provider + m.id}
                      value={`${m.provider}::${m.id}`}
                    >
                      {m.id} · {m.provider}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
        {models.length === 0 && (
          <button type="button" className="text-button" onClick={onModels}>
            先设置模型服务 <ArrowRight size={14} />
          </button>
        )}
        <Field label="角色与擅长的事">
          <textarea
            rows={4}
            value={form.persona}
            onChange={(e) => update("persona", e.target.value)}
            maxLength={4000}
          />
        </Field>
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => update("enabled", e.target.checked)}
          />
          <span>参与群聊回答</span>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.tools}
            onChange={(e) => update("tools", e.target.checked)}
          />
          <span>
            允许使用本群工具
            <small>查看时间、读取本群笔记、按要求保存草稿。</small>
          </span>
        </label>
        <div className="modal-footer">
          {exists && room.agents.length > 1 && (
            <button
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={() => save(true)}
            >
              <Trash2 size={15} />
              移出群聊
            </button>
          )}
          <div className="spacer" />
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy || !form.model}>
            {busy ? "保存中…" : "保存伙伴"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function RoomSettings({
  room,
  canEdit,
  onClose,
  onChange,
}: {
  room: Room;
  canEdit: boolean;
  onClose: () => void;
  onChange: () => void;
}) {
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description);
  const [visibility, setVisibility] = useState(room.visibility);
  const [projectMode, setProjectMode] = useState(room.projectMode);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="群聊设置"
      description="整理这个群的名字、可见范围和对话记录。"
    >
      <ErrorBox error={error} />
      <Field label="群聊名称">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          disabled={!canEdit}
        />
      </Field>
      <Field label="一句话介绍">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="多个视角，一起想得更远"
          maxLength={300}
          disabled={!canEdit}
        />
      </Field>
      <Field label="可见范围">
        <select
          value={visibility}
          disabled={!canEdit}
          onChange={(e) => setVisibility(e.target.value as "team" | "private")}
        >
          <option value="private">仅群聊创建者</option>
          <option value="team">空间所有成员</option>
        </select>
      </Field>
      {visibility !== room.visibility && visibility === "team" && (
        <div className="info-box">
          保存后，这个群的全部历史和笔记将对空间成员可见。
        </div>
      )}
      <Field
        label="项目协作"
        hint="开启后，允许使用工具的伙伴可以读取项目、提交文件变更；变更需要你审查后保存。"
      >
        <select
          disabled={!canEdit}
          value={projectMode}
          onChange={(e) =>
            setProjectMode(e.target.value as Room["projectMode"])
          }
        >
          <option value="off">关闭 · 只聊天与保存笔记</option>
          <option value="shared">共同开发 · 共享项目</option>
          <option value="independent">独立开发 · 每位伙伴一个分支</option>
        </select>
      </Field>
      <div className="button-row">
        <a className="button" href={`/api/rooms/${room.id}/export`} download>
          <Download size={16} />
          导出 Markdown
        </a>
        <a
          className="button"
          href={`/api/rooms/${room.id}/export?format=json`}
          download
        >
          导出 JSON
        </a>
      </div>
      {canEdit && (
        <>
          <div className="section-divider" />
          {confirmArchive ? (
            <div className="archive-confirm">
              <p>
                归档后将从列表隐藏，LINE 连接会解除。已有记录保留在数据库中。
              </p>
              <div className="button-row">
                <button
                  className="button"
                  onClick={() => setConfirmArchive(false)}
                >
                  取消
                </button>
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`/api/rooms/${room.id}`, { method: "DELETE" });
                      toast.success("群聊已归档");
                      onChange();
                    } catch (e: any) {
                      setError(e.message);
                      setBusy(false);
                    }
                  }}
                >
                  确认归档
                </button>
              </div>
            </div>
          ) : (
            <button
              className="text-button danger"
              onClick={() => setConfirmArchive(true)}
            >
              <Archive size={15} />
              归档这个群
            </button>
          )}
          <div className="modal-footer">
            <button className="button" onClick={onClose}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy || !name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await patch(`/api/rooms/${room.id}`, {
                    name,
                    description,
                    visibility,
                    projectMode,
                  });
                  onChange();
                } catch (e: any) {
                  setError(e.message);
                  setBusy(false);
                }
              }}
            >
              保存设置
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
function Notes({
  room,
  notes,
  canWrite,
  onClose,
}: {
  room: Room;
  notes: Note[];
  canWrite: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const initial = sessionStorage.getItem("af-note-draft");
  const [selected, setSelected] = useState<Note | null>(null);
  const [editing, setEditing] = useState(!!initial);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState(initial || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    sessionStorage.removeItem("af-note-draft");
  }, []);
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="群聊笔记"
      description="把有用的想法和代码草稿留下来。开启工具的伙伴可以读取本群笔记。"
      wide
    >
      <ErrorBox error={error} />
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await post(`/api/rooms/${room.id}/notes`, { title, content });
              await client.invalidateQueries({ queryKey: ["room", room.id] });
              setEditing(false);
              setTitle("");
              setContent("");
              toast.success("笔记已保存");
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="标题">
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="给这份笔记一个名字"
            />
          </Field>
          <Field label="内容">
            <textarea
              className="note-editor"
              required
              rows={12}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={50000}
            />
          </Field>
          <div className="modal-footer">
            <button
              type="button"
              className="button"
              onClick={() => setEditing(false)}
            >
              取消
            </button>
            <button className="button primary" disabled={busy}>
              保存笔记
            </button>
          </div>
        </form>
      ) : selected ? (
        <>
          <button className="text-button" onClick={() => setSelected(null)}>
            ← 返回笔记列表
          </button>
          <h3>{selected.title}</h3>
          <div className="note-preview">
            <Markdown text={selected.content} />
          </div>
          <div className="modal-footer">
            <CopyButton text={selected.content} />
            <button
              className="button"
              onClick={() =>
                download(
                  `${selected.title.replace(/[<>:"/\\|?*]/g, "_")}.md`,
                  selected.content,
                  "text/markdown",
                )
              }
            >
              <Download size={15} />
              下载
            </button>
            {canWrite && (
              <button
                className="button danger"
                onClick={async () => {
                  try {
                    await api(`/api/rooms/${room.id}/notes/${selected.id}`, {
                      method: "DELETE",
                    });
                    setSelected(null);
                    await client.invalidateQueries({
                      queryKey: ["room", room.id],
                    });
                    toast.success("笔记已删除");
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                <Trash2 size={15} />
                删除
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="section-heading">
            <p className="muted">{notes.length} 份笔记 · 仅在本群共享</p>
            {canWrite && (
              <button
                className="button primary compact"
                onClick={() => {
                  setContent("");
                  setTitle("");
                  setEditing(true);
                }}
              >
                <Plus size={15} />
                新建笔记
              </button>
            )}
          </div>
          {notes.length ? (
            <div className="notes-list">
              {notes.map((n) => (
                <button key={n.id} onClick={() => setSelected(n)}>
                  <FileText size={21} />
                  <span>
                    <strong>{n.title}</strong>
                    <small>
                      {new Date(n.createdAt).toLocaleString("zh-CN")} ·{" "}
                      {n.createdBy.startsWith("agent:")
                        ? "AI 草稿"
                        : "成员笔记"}
                    </small>
                  </span>
                  <ArrowRight size={16} />
                </button>
              ))}
            </div>
          ) : (
            <div className="notes-empty">
              <BookOpen size={32} />
              <h3>好想法，值得留下来</h3>
              <p>
                点击回答下方的「存为笔记」，
                <br />
                或新建一份大家都能参考的资料。
              </p>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
