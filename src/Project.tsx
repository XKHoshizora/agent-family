import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { diffLines } from "diff";
import {
  Code2,
  FileCode2,
  Plus,
  GitBranch,
  Check,
  X,
  Download,
  ArrowRight,
  ShieldCheck,
  Upload,
  ChevronLeft,
} from "lucide-react";
import { toast } from "sonner";
import { api, post } from "./api";
import { Modal, Field, ErrorBox, Spinner, CopyButton } from "./components";
import type { Room, ChangeSet, ProjectFile } from "../shared/types";
type ProjectData = { mode: string; files: ProjectFile[]; changes: ChangeSet[] };
export function Project({
  room,
  canWrite,
  canReview,
  onClose,
  onContinue,
}: {
  room: Room;
  canWrite: boolean;
  canReview: boolean;
  onClose: () => void;
  onContinue: (prompt: string) => void;
}) {
  const client = useQueryClient();
  const project = useQuery({
    queryKey: ["project", room.id],
    queryFn: () => api<ProjectData>(`/api/rooms/${room.id}/project`),
    refetchInterval: 4000,
  });
  const [tab, setTab] = useState<"files" | "reviews">("files");
  const [branch, setBranch] = useState("main");
  const [path, setPath] = useState("");
  const [change, setChange] = useState<ChangeSet | null>(null);
  const [changePath, setChangePath] = useState("");
  const [editing, setEditing] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const data = project.data;
  const branches = Array.from(
    new Set([
      "main",
      ...(room.projectMode === "independent"
        ? room.agents.map((a) => `agent-${a.id}`)
        : []),
      ...(data?.files.map((f) => f.branch) || []),
    ]),
  );
  const files =
    data?.files.filter((f) => f.branch === branch && f.content !== null) || [];
  const selected = files.find((f) => f.path === path) || files[0];
  const branchName = (b: string) =>
    b === "main"
      ? "共享项目"
      : (room.agents.find((a) => `agent-${a.id}` === b)?.name || "已移除伙伴") +
        "的独立分支";
  const pending = data?.changes.filter((c) => c.status === "pending") || [];
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await client.invalidateQueries({ queryKey: ["project", room.id] });
      await client.invalidateQueries({ queryKey: ["room", room.id] });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const reviewFile =
    change?.files.find((f) => f.path === changePath) || change?.files[0];
  const oldFile =
    change && reviewFile
      ? data?.files.find(
          (f) => f.branch === change.branch && f.path === reviewFile.path,
        )
      : undefined;
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="项目工作台"
      description={
        room.projectMode === "independent"
          ? "每位伙伴在独立分支准备代码，审查后可合并到共享项目。"
          : "伙伴围绕同一份项目协作。文件变更必须经人类审查才能保存。"
      }
      wide
    >
      <ErrorBox error={error || project.error?.message} />
      <div className="project-tabs">
        <button
          className={tab === "files" ? "active" : ""}
          onClick={() => {
            setTab("files");
            setChange(null);
          }}
        >
          <Code2 size={16} />
          项目文件
        </button>
        <button
          className={tab === "reviews" ? "active" : ""}
          onClick={() => {
            setTab("reviews");
            setEditing(false);
          }}
        >
          <ShieldCheck size={16} />
          变更审查
          {pending.length > 0 && (
            <span className="review-badge">{pending.length}</span>
          )}
        </button>
        <span className="project-mode-tag">
          {room.projectMode === "independent" ? "独立开发" : "共同开发"}
        </span>
      </div>
      {project.isPending ? (
        <Spinner />
      ) : editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const old = data?.files.find(
                (f) => f.path === filePath && f.branch === branch,
              );
              await post(`/api/rooms/${room.id}/project/changes`, {
                branch,
                title: title || `更新 ${filePath}`,
                files: [
                  { path: filePath, content, baseVersion: old?.version || 0 },
                ],
              });
              setEditing(false);
              setTab("reviews");
              toast.success("已提交，等待审查");
            });
          }}
        >
          <Field
            label="文件路径"
            hint="项目内相对路径，例如 src/app.ts。不能上传密钥或 .env 文件。"
          >
            <input
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              required
              maxLength={180}
            />
          </Field>
          <Field label="变更说明">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="为什么需要这次修改？"
            />
          </Field>
          <Field label="文件内容">
            <textarea
              className="note-editor"
              rows={12}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={30000}
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
              提交审查
            </button>
          </div>
        </form>
      ) : tab === "files" ? (
        <>
          <div className="project-toolbar">
            <div className="branch-select">
              <GitBranch size={16} />
              <select
                value={branch}
                onChange={(e) => {
                  setBranch(e.target.value);
                  setPath("");
                }}
                aria-label="项目分支"
              >
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {branchName(b)}
                  </option>
                ))}
              </select>
            </div>
            {canWrite && (
              <>
                <label className="button compact file-upload-label">
                  <Upload size={14} />
                  导入文本
                  <input
                    type="file"
                    hidden
                    accept=".txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.html,.css,.sql,.yaml,.yml"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      if (file.size > 80000) {
                        toast.error("文件不能超过 80 KB");
                        return;
                      }
                      const text = await file.text();
                      if (text.length > 30000 || text.includes("\0")) {
                        toast.error("仅支持 30,000 字符以内的文本文件");
                        return;
                      }
                      setFilePath(file.name);
                      setContent(text);
                      setTitle(`导入 ${file.name}`);
                      setEditing(true);
                    }}
                  />
                </label>
                <button
                  className="button compact"
                  onClick={() => {
                    setFilePath("");
                    setContent("");
                    setTitle("");
                    setEditing(true);
                  }}
                >
                  <Plus size={14} />
                  新文件
                </button>
              </>
            )}
            {files.length > 0 && (
              <a
                className="button compact"
                href={`/api/rooms/${room.id}/project/export?branch=${encodeURIComponent(branch)}`}
                download
              >
                <Download size={14} />
                下载 ZIP
              </a>
            )}
          </div>
          {files.length ? (
            <div className="project-browser">
              <nav aria-label="项目文件列表">
                {files.map((f) => (
                  <button
                    key={f.path}
                    className={f.path === selected?.path ? "active" : ""}
                    onClick={() => setPath(f.path)}
                  >
                    <FileCode2 size={14} />
                    <span>{f.path}</span>
                  </button>
                ))}
              </nav>
              <div className="project-file">
                <div className="project-file-heading">
                  <span>{selected.path}</span>
                  <small>版本 {selected.version}</small>
                  <CopyButton text={selected.content || ""} />
                </div>
                <pre>
                  <code>{selected.content}</code>
                </pre>
                <div className="project-file-actions">
                  {canWrite && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setFilePath(selected.path);
                        setContent(selected.content || "");
                        setTitle("");
                        setEditing(true);
                      }}
                    >
                      编辑并提交审查
                    </button>
                  )}
                  {branch !== "main" && canWrite && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          const target = data?.files.find(
                            (f) =>
                              f.branch === "main" && f.path === selected.path,
                          );
                          await post(`/api/rooms/${room.id}/project/changes`, {
                            branch: "main",
                            title: `合并 ${branchName(branch)}：${selected.path}`,
                            files: [
                              {
                                path: selected.path,
                                content: selected.content,
                                baseVersion: target?.version || 0,
                              },
                            ],
                          });
                          setTab("reviews");
                          toast.success("合并请求已提交，请审查差异");
                        })
                      }
                    >
                      申请合并到共享项目 <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="project-empty">
              <Code2 size={35} />
              <h3>从需求到可审阅的代码</h3>
              <p>
                在群里描述想做的东西，伙伴会准备文件变更。
                <br />
                批准之后，项目文件会出现在这里。
              </p>
              <button
                className="button"
                onClick={() =>
                  onContinue(
                    "请帮我开发一个简单的待办事项网页，支持添加、完成和删除待办。先读取当前项目，再提交 HTML、CSS、JavaScript 文件变更供我审查。暂不执行或部署。",
                  )
                }
              >
                让伙伴开始开发 <ArrowRight size={15} />
              </button>
            </div>
          )}
        </>
      ) : change ? (
        <>
          <button className="text-button" onClick={() => setChange(null)}>
            <ChevronLeft size={14} />
            返回审查列表
          </button>
          <div className="change-heading">
            <h3>{change.title}</h3>
            <span className={`tag ${change.status}`}>
              {
                { pending: "等待审查", approved: "已批准", rejected: "已拒绝" }[
                  change.status
                ]
              }
            </span>
          </div>
          <p className="hint">
            {room.agents.find((a) => a.id === change.agentId)?.name ||
              "团队成员"}{" "}
            · {branchName(change.branch)} ·{" "}
            {new Date(change.createdAt).toLocaleString()}
          </p>
          <div className="change-file-tabs">
            {change.files.map((f) => (
              <button
                className={reviewFile?.path === f.path ? "active" : ""}
                key={f.path}
                onClick={() => setChangePath(f.path)}
              >
                {f.path}
                {f.content === null ? " · 删除" : ""}
              </button>
            ))}
          </div>
          {reviewFile && (
            <>
              <div className="diff-legend">
                <span className="removed">− 删除</span>
                <span className="added">+ 新增</span>
                <span>基于版本 {reviewFile.baseVersion}</span>
              </div>
              {change.status === "pending" &&
                (oldFile?.version || 0) !== reviewFile.baseVersion && (
                  <ErrorBox error="文件已被其他变更更新，这份提案不能直接批准。请让伙伴读取新版本后重新提交。" />
                )}
              <pre className="code-diff">
                {diffLines(
                  reviewFile.beforeContent !== undefined
                    ? reviewFile.beforeContent || ""
                    : oldFile?.content || "",
                  reviewFile.content || "",
                ).map((part, i) => (
                  <span
                    key={i}
                    className={
                      part.added
                        ? "added"
                        : part.removed
                          ? "removed"
                          : "unchanged"
                    }
                  >
                    {part.value.split("\n").map((line, j, arr) =>
                      j === arr.length - 1 && line === "" ? null : (
                        <span className="diff-line" key={j}>
                          <i>{part.added ? "+" : part.removed ? "−" : " "}</i>
                          {line}
                          {"\n"}
                        </span>
                      ),
                    )}
                  </span>
                ))}
              </pre>
            </>
          )}
          {change.status === "pending" && canReview && (
            <div className="modal-footer">
              <button
                className="button danger"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await post(
                      `/api/rooms/${room.id}/project/changes/${change.id}/review`,
                      { decision: "reject" },
                    );
                    setChange(null);
                    toast("已拒绝，项目文件未修改");
                  })
                }
              >
                <X size={15} />
                拒绝变更
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await post(
                      `/api/rooms/${room.id}/project/changes/${change.id}/review`,
                      { decision: "approve" },
                    );
                    setChange(null);
                    toast.success("变更已批准并保存");
                  })
                }
              >
                <Check size={16} />
                批准并保存
              </button>
            </div>
          )}
          {change.status === "pending" && !canReview && (
            <div className="info-box">
              这份变更需要群聊创建者或空间管理员批准。
            </div>
          )}
        </>
      ) : (
        <div className="change-list">
          {data?.changes.length ? (
            data.changes.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setChange(c);
                  setChangePath(c.files[0]?.path || "");
                }}
              >
                <ShieldCheck size={20} />
                <span>
                  <strong>{c.title}</strong>
                  <small>
                    {room.agents.find((a) => a.id === c.agentId)?.name ||
                      "团队成员"}{" "}
                    · {c.files.length} 个文件 · {branchName(c.branch)}
                  </small>
                </span>
                <span className={`tag ${c.status}`}>
                  {
                    {
                      pending: "待审查",
                      approved: "已批准",
                      rejected: "已拒绝",
                    }[c.status]
                  }
                </span>
                <ArrowRight size={15} />
              </button>
            ))
          ) : (
            <div className="project-empty">
              <ShieldCheck size={32} />
              <h3>还没有待审查的变更</h3>
              <p>AI 的文件提案会显示在这里，未经批准不会写入项目。</p>
            </div>
          )}
        </div>
      )}
      <div className="project-safety">
        <ShieldCheck size={14} />
        <span>
          文件保存在此群的独立项目空间。代码尚未执行或验证；下载后请在隔离环境中检查。
        </span>
      </div>
    </Modal>
  );
}
