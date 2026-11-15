import { appendDiscussionInput } from "./discussion-inputs";
import { registerMatrixRoutes } from "./matrix-account";
import { registerChatEntry } from "./chat-entry";
import { registerFamilyRoutes } from "./family-routes";
import {
  familyRoomAccess,
  familyRoomPolicy,
  assertFamilyRunAllowed,
} from "./family-store";
import {
  discussionSchema,
  discussionSettings,
  updateDiscussion,
} from "./discussion";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { auth, migrateAuth, requestHeaders } from "./auth";
import { config, allowedOrigins, id, now, root } from "./config";
import {
  db,
  getRoom,
  roomFrom,
  createRoom,
  getMessages,
  getMessagePage,
  getRuns,
  getNotes,
  saveNote,
  audit,
} from "./db";
import {
  listProviders,
  listModels,
  saveProvider,
  refreshModels,
  defaultAgentsWithModels,
} from "./providers";
import {
  startRun,
  cancelRun,
  changes,
  notify,
  usage,
  recoverInterrupted,
} from "./orchestrator";
import {
  registerLineWebhook,
  publicChannel,
  saveChannel,
  verifyChannel,
  createChallenge,
  confirmChallenge,
  updateBinding,
  resumeQueuedLineEvents,
} from "./line";
import { DEFAULT_AGENTS, type Role, type Room } from "../shared/types";
import {
  listProjectFiles,
  listChanges,
  proposeChanges,
  proposalSchema,
  reviewChange,
  projectZip,
} from "./projects";
class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: number, message: string): never => {
  throw new HttpError(code, message);
};
const agentSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
  name: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .refine((v) => !/[\s@]/.test(v), "名字不能包含空格或 @"),
  model: z.string().max(180),
  provider: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  persona: z.string().max(4000),
  color: z.enum(["sage", "clay", "blue", "violet", "gold"]),
  enabled: z.boolean(),
  tools: z.boolean(),
});
const modeSchema = z.enum(["parallel", "discuss", "single", "free"]);
const sha = (text: string) =>
  crypto.createHash("sha256").update(text).digest("hex");
export async function sessionFor(req: FastifyRequest) {
  const session = await auth.api.getSession({
    headers: requestHeaders(req.headers, req.ip),
  });
  if (!session) fail(401, "请先登录。");
  return session!;
}
async function context(req: FastifyRequest) {
  const session = await sessionFor(req);
  const requested =
    typeof req.headers["x-workspace-id"] === "string"
      ? req.headers["x-workspace-id"]
      : undefined;
  const membership = (
    requested
      ? db
          .prepare(
            "SELECT m.*,w.name FROM memberships m JOIN workspaces w ON m.workspace_id=w.id WHERE m.user_id=? AND w.id=?",
          )
          .get(session.user.id, requested)
      : db
          .prepare(
            "SELECT m.*,w.name FROM memberships m JOIN workspaces w ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at LIMIT 1",
          )
          .get(session.user.id)
  ) as any;
  if (!membership) fail(403, "你还没有加入这个工作空间。");
  return {
    user: session.user,
    workspaceId: membership.workspace_id as string,
    role: membership.role as Role,
    workspaceName: membership.name as string,
  };
}
function canWrite(role: Role) {
  if (role === "viewer") fail(403, "你目前只有查看权限。");
}
function admin(role: Role) {
  if (!["owner", "admin"].includes(role)) fail(403, "这项设置需要管理员权限。");
}
export async function roomAccess(req: FastifyRequest, write = false) {
  const session = await sessionFor(req);
  const room = getRoom((req.params as any).id);
  if (!room) fail(404, "群聊不存在。");
  const member = db
    .prepare("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?")
    .get(room!.workspaceId, session.user.id) as any;
  const familyAccess = familyRoomAccess(room!.id, session.user.id);
  if (
    !member ||
    familyAccess === false ||
    (familyAccess === null &&
      room!.visibility === "private" &&
      room!.createdBy !== session.user.id)
  )
    fail(404, "群聊不存在或你没有访问权限。");
  if (write) {
    canWrite(member.role);
    if (room!.archived) fail(409, "群聊已经归档。");
  }
  return { room: room!, user: session.user, role: member.role as Role };
}
function editRoomAllowed(room: Room, userId: string, role: Role) {
  if (familyRoomPolicy(room.id))
    fail(
      409,
      "这是主人监督群。请到 Agent 好友与监督群中操作；成员和权限不能直接修改。",
    );
  if (room.createdBy !== userId && !["owner", "admin"].includes(role))
    fail(403, "只有群聊创建者或管理员可以修改伙伴和群聊设置。");
}
function publicRoom(room: Room, userId: string) {
  const supervision = familyRoomPolicy(room.id, userId);
  if (!supervision) return room;
  return {
    ...room,
    supervision,
    agents: room.agents.map((a) =>
      supervision.redactPersonaAgentIds.includes(a.id)
        ? { ...a, persona: "" }
        : a,
    ),
  };
}
function ordinaryRoomOnly(room: Room) {
  if (familyRoomPolicy(room.id))
    fail(409, "主人监督群首版不开放资料、项目或外部转发。");
}
function ensureAgentsUnique(agents: z.infer<typeof agentSchema>[]) {
  if (
    new Set(agents.map((a) => a.id)).size !== agents.length ||
    new Set(agents.map((a) => a.name)).size !== agents.length
  )
    fail(400, "每位伙伴需要不同的名字与标识。");
}
export async function createApp() {
  await migrateAuth();
  recoverInterrupted();
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1024,
    trustProxy: process.env.TRUST_PROXY?.split(",").filter(Boolean) || false,
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.origin.startsWith("https://")
          ? []
          : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !req.url.startsWith("/api/line/webhook/")
    ) {
      const origin = req.headers.origin;
      if (!origin || !allowedOrigins.has(origin))
        return reply
          .code(403)
          .send({ error: "请求来源不受信任，请从应用页面重试。" });
    }
  });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: error.issues[0]?.message || "输入内容不符合要求。" });
    const code = error.code?.startsWith("SQLITE")
      ? 500
      : error.statusCode && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 400;
    reply.code(code).send({
      error:
        code >= 500
          ? "服务暂时没有完成请求，请稍后重试。"
          : error.message || "操作未完成。",
    });
  });
  app.get("/api/health", async () => ({ ok: true, version: "0.2.0" }));
  registerMatrixRoutes(app, context);
  await registerFamilyRoutes(app, {
    context,
    cancelRun: (roomId) => {
      for (const run of getRuns(roomId))
        if (["queued", "running"].includes(run.status))
          cancelRun(run.id, roomId);
      notify(roomId);
    },
  });
  app.get("/api/setup/status", async () => ({
    required: !db.prepare("SELECT 1 FROM memberships LIMIT 1").get(),
  }));
  let setupInProgress = false;
  app.post(
    "/api/setup",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      if (
        setupInProgress ||
        db.prepare("SELECT 1 FROM memberships LIMIT 1").get()
      )
        fail(409, "已经完成初始化，请登录。");
      const data = z
        .object({
          name: z.string().trim().min(1).max(40),
          email: z.email().max(200),
          password: z.string().min(10).max(128),
          token: z.string().optional(),
        })
        .parse(req.body);
      const local =
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(
          new URL(config.origin).hostname,
        );
      if (!local && data.token !== config.setupToken)
        fail(403, "远程初始化需要部署管理员提供的初始化码。");
      setupInProgress = true;
      try {
        const account = await auth.api.signUpEmail({
          body: { name: data.name, email: data.email, password: data.password },
        });
        const workspaceId = id();
        db.transaction(() => {
          db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(
            workspaceId,
            "我的 Agent Family",
            now(),
          );
          db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
            workspaceId,
            account.user.id,
            "owner",
          );
        })();
        listProviders(workspaceId);
        createRoom(workspaceId, account.user.id, "灵感客厅", DEFAULT_AGENTS);
        audit(workspaceId, account.user.id, "workspace.create", workspaceId);
        return reply.code(201).send({ ok: true });
      } finally {
        setupInProgress = false;
      }
    },
  );
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      const route = req.url.split("?")[0];
      const allowed = [
        "/api/auth/sign-in/email",
        "/api/auth/sign-out",
        "/api/auth/get-session",
        "/api/auth/change-password",
        "/api/auth/update-user",
        "/api/auth/list-sessions",
        "/api/auth/revoke-session",
        "/api/auth/revoke-other-sessions",
      ];
      if (!allowed.includes(route))
        return reply.code(404).send({ error: "此登录操作未开放。" });
      const response = await auth.handler(
        new Request(new URL(req.url, config.origin), {
          method: req.method,
          headers: requestHeaders(req.headers, req.ip),
          ...(req.method === "POST"
            ? { body: JSON.stringify(req.body || {}) }
            : {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(await response.text());
    },
  });
  app.get("/api/me", async (req) => {
    const c = await context(req);
    const workspaces = db
      .prepare(
        "SELECT w.id,w.name,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=?",
      )
      .all(c.user.id);
    return {
      user: { id: c.user.id, name: c.user.name, email: c.user.email },
      workspace: { id: c.workspaceId, name: c.workspaceName, role: c.role },
      workspaces,
    };
  });
  app.get("/api/rooms", async (req) => {
    const c = await context(req);
    return (
      db
        .prepare(
          "SELECT * FROM rooms WHERE workspace_id=? AND archived=0 ORDER BY updated_at DESC",
        )
        .all(c.workspaceId) as any[]
    )
      .map(roomFrom)
      .filter((room) => {
        const access = familyRoomAccess(room.id, c.user.id);
        return access === null
          ? room.visibility === "team" || room.createdBy === c.user.id
          : access;
      })
      .map((room) => publicRoom(room, c.user.id));
  });
  app.post("/api/rooms", async (req, reply) => {
    const c = await context(req);
    canWrite(c.role);
    const data = z
      .object({
        name: z.string().trim().min(1).max(60),
        visibility: z.enum(["private", "team"]).default("private"),
        template: z
          .enum(["general", "writing", "coding", "business"])
          .default("general"),
        projectMode: z.enum(["shared", "independent"]).default("shared"),
      })
      .parse(req.body);
    const count = (
      db
        .prepare(
          "SELECT count(*) AS n FROM rooms WHERE workspace_id=? AND archived=0 AND id NOT IN (SELECT room_id FROM family_groups WHERE room_id IS NOT NULL)",
        )
        .get(c.workspaceId) as any
    ).n;
    if (count >= 100)
      fail(400, "当前工作空间最多创建 100 个群聊，请先归档不再使用的群。");
    let agents = defaultAgentsWithModels(
      c.workspaceId,
      structuredClone(DEFAULT_AGENTS),
    );
    if (data.template === "coding")
      agents = agents.map((a, i) => ({
        ...a,
        name: ["架构师", "开发者", "审查员"][i],
        persona: [
          "负责分析需求、设计结构与接口。给出可实现、清晰的技术方案。",
          "负责按需求生成完整、可审阅的代码草稿；明确依赖和使用方法。",
          "负责审查代码的正确性、安全性、测试覆盖与边界。具体指出问题并建议修复。",
        ][i],
        tools: true,
      }));
    if (data.template === "writing")
      agents = agents.map((a, i) => ({
        ...a,
        name: ["策划", "写作者", "编辑"][i],
        persona: [
          "负责理解读者、目标和内容结构。",
          "负责写出自然、具体、有风格的文稿。",
          "负责精简、校对与改进可读性。",
        ][i],
        tools: true,
      }));
    if (data.template === "business")
      agents = agents.map((a, i) => ({
        ...a,
        name: ["项目助理", "方案顾问", "风险顾问"][i],
        persona: [
          "负责梳理目标、任务、负责人和下一步。",
          "负责比较业务方案，指出假设和权衡。",
          "负责检查风险、信息缺口和需要人工确认的事项。",
        ][i],
        tools: true,
      }));
    const room = createRoom(
      c.workspaceId,
      c.user.id,
      data.name,
      agents,
      data.visibility,
    );
    if (data.template === "coding")
      db.prepare("UPDATE rooms SET project_mode=? WHERE id=?").run(
        data.projectMode,
        room.id,
      );
    audit(c.workspaceId, c.user.id, "room.create", room.id);
    return reply.code(201).send(getRoom(room.id));
  });
  app.get("/api/rooms/:id", async (req) => {
    const { room, user } = await roomAccess(req);
    const history = getMessagePage(room.id);
    return {
      room: publicRoom(room, user.id),
      messages: history.messages,
      historyHasMore: history.hasMore,
      runs: getRuns(room.id),
      notes: getNotes(room.id),
      pendingChanges: listChanges(room.id).filter((c) => c.status === "pending")
        .length,
    };
  });
  app.get("/api/rooms/:id/history", async (req) => {
    const { room } = await roomAccess(req);
    const query = z
      .object({
        before: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(300).default(300),
      })
      .parse(req.query);
    return getMessagePage(room.id, query.before, query.limit);
  });
  app.patch("/api/rooms/:id", async (req) => {
    const { room, user, role } = await roomAccess(req, true);
    editRoomAllowed(room, user.id, role);
    const data = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        description: z.string().max(300).optional(),
        mode: modeSchema.optional(),
        visibility: z.enum(["private", "team"]).optional(),
        projectMode: z.enum(["off", "shared", "independent"]).optional(),
        agents: z.array(agentSchema).min(1).max(5).optional(),
      })
      .parse(req.body);
    if (data.agents) ensureAgentsUnique(data.agents);
    if (data.projectMode && data.projectMode !== room.projectMode) {
      if (
        getRuns(room.id).some((r) =>
          ["running", "queued"].includes(r.status),
        ) ||
        listChanges(room.id).some((c) => c.status === "pending")
      )
        fail(409, "请先结束当前任务并处理待审查变更，再切换项目模式。");
      db.prepare("UPDATE rooms SET project_mode=? WHERE id=?").run(
        data.projectMode,
        room.id,
      );
    }
    db.prepare(
      "UPDATE rooms SET name=?,description=?,mode=?,visibility=?,agents=?,updated_at=? WHERE id=?",
    ).run(
      data.name ?? room.name,
      data.description ?? room.description,
      data.mode ?? room.mode,
      data.visibility ?? room.visibility,
      JSON.stringify(data.agents ?? room.agents),
      now(),
      room.id,
    );
    audit(room.workspaceId, user.id, "room.update", room.id);
    notify(room.id);
    return getRoom(room.id);
  });
  app.delete("/api/rooms/:id", async (req) => {
    const { room, user, role } = await roomAccess(req, true);
    editRoomAllowed(room, user.id, role);
    if (getRuns(room.id).some((r) => ["running", "queued"].includes(r.status)))
      fail(409, "请先停止正在进行的回答。");
    db.transaction(() => {
      db.prepare("UPDATE rooms SET archived=1,updated_at=? WHERE id=?").run(
        now(),
        room.id,
      );
      db.prepare("DELETE FROM line_bindings WHERE room_id=?").run(room.id);
    })();
    audit(room.workspaceId, user.id, "room.archive", room.id);
    notify(room.id);
    return { ok: true };
  });
  app.post(
    "/api/rooms/:id/messages",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { room, user } = await roomAccess(req, true);
      assertFamilyRunAllowed(room.id, user.id);
      const data = z
        .object({
          content: z.string().trim().min(1).max(12000),
          mode: modeSchema.optional(),
          targets: z.array(z.string()).max(5).optional(),
          discussion: discussionSchema.optional(),
          runId: z.string().uuid().optional(),
          clientMessageId: z.string().uuid().optional(),
          shareToLine: z.boolean().optional(),
        })
        .parse(req.body);
      if (data.runId) {
        if (!data.clientMessageId)
          fail(400, "补充消息需要有效标识，请刷新后重试。");
        const result = appendDiscussionInput({
          room,
          runId: data.runId,
          actor: user.id,
          author: user.name,
          content: data.content,
          clientId: data.clientMessageId!,
          shareToLine: data.shareToLine,
        });
        notify(room.id);
        return reply.code(202).send(result);
      }
      const runId = startRun({
        room,
        actor: user.id,
        author: user.name,
        ...data,
      });
      return reply.code(202).send({ runId });
    },
  );
  app.patch("/api/rooms/:id/discussion", async (req) => {
    const { room, user } = await roomAccess(req, true);
    assertFamilyRunAllowed(room.id, user.id);
    const data = z
      .object({ runId: z.string().uuid(), settings: discussionSchema })
      .parse(req.body);
    const settings = updateDiscussion(data.runId, room.id, data.settings);
    audit(room.workspaceId, user.id, "discussion.update", data.runId);
    notify(room.id);
    return { settings };
  });
  app.post("/api/rooms/:id/cancel", async (req) => {
    const { room, user, role } = await roomAccess(req);
    // A necessary owner retains the emergency stop even after a role downgrade.
    if (familyRoomAccess(room.id, user.id) !== true) {
      canWrite(role);
      if (room.archived) fail(409, "群聊已经归档。");
    }
    const data = z.object({ runId: z.string().uuid() }).parse(req.body);
    cancelRun(data.runId, room.id);
    audit(room.workspaceId, user.id, "run.cancel", data.runId);
    return { ok: true };
  });
  app.get("/api/rooms/:id/events", async (req, reply) => {
    const { room, user } = await roomAccess(req);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("event: ready\ndata: {}\n\n");
    let closed = false;
    const onChange = (roomId: string) => {
      if (roomId === room.id && familyRoomAccess(room.id, user.id) === false) {
        reply.raw.end();
        return;
      }
      if (roomId === room.id && !closed)
        reply.raw.write("event: change\ndata: {}\n\n");
    };
    changes.on("room", onChange);
    const interval = setInterval(async () => {
      if (closed) return;
      try {
        await roomAccess(req);
        reply.raw.write(": heartbeat\n\n");
      } catch {
        reply.raw.end();
      }
    }, 15000);
    const cleanup = () => {
      closed = true;
      clearInterval(interval);
      changes.off("room", onChange);
    };
    req.raw.on("aborted", cleanup);
    reply.raw.on("close", cleanup);
  });
  app.get("/api/rooms/:id/export", async (req, reply) => {
    const { room, user } = await roomAccess(req);
    const messages = getMessages(room.id, 10000);
    const format = (req.query as any).format;
    if (format === "json") {
      reply.header(
        "Content-Disposition",
        `attachment; filename="agent-family-${room.id}.json"`,
      );
      return {
        room: publicRoom(room, user.id),
        messages,
        notes: getNotes(room.id),
      };
    }
    reply
      .type("text/markdown; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="agent-family-${room.id}.md"`,
      );
    return (
      `# ${room.name}\n\n导出于 ${now()}\n\n` +
      messages
        .map(
          (m) =>
            `## ${m.author}${m.model ? ` · ${m.model}` : ""}\n\n${m.content}\n\n_${m.createdAt} · ${m.status}_\n`,
        )
        .join("\n---\n\n")
    );
  });
  app.post("/api/rooms/:id/notes", async (req, reply) => {
    const { room, user } = await roomAccess(req, true);
    ordinaryRoomOnly(room);
    const data = z
      .object({
        title: z.string().trim().min(1).max(100),
        content: z.string().min(1).max(50000),
      })
      .parse(req.body);
    if (getNotes(room.id).length >= 200)
      fail(400, "本群笔记已达 200 份，请整理后再保存。");
    const noteId = saveNote(room.id, data.title, data.content, user.id);
    audit(room.workspaceId, user.id, "note.create", noteId);
    notify(room.id);
    return reply.code(201).send({ id: noteId });
  });
  app.delete("/api/rooms/:id/notes/:noteId", async (req) => {
    const { room, user } = await roomAccess(req, true);
    ordinaryRoomOnly(room);
    db.prepare("DELETE FROM notes WHERE id=? AND room_id=?").run(
      (req.params as any).noteId,
      room.id,
    );
    audit(room.workspaceId, user.id, "note.delete", (req.params as any).noteId);
    notify(room.id);
    return { ok: true };
  });
  app.get("/api/models", async (req) => {
    const c = await context(req);
    return listModels(c.workspaceId);
  });
  app.get("/api/rooms/:id/project", async (req) => {
    const { room } = await roomAccess(req);
    ordinaryRoomOnly(room);
    return {
      mode: room.projectMode,
      files: listProjectFiles(room.id),
      changes: listChanges(room.id),
    };
  });
  app.post("/api/rooms/:id/project/changes", async (req, reply) => {
    const { room, user } = await roomAccess(req, true);
    ordinaryRoomOnly(room);
    const data = proposalSchema
      .extend({
        branch: z
          .string()
          .regex(/^(main|agent-[a-zA-Z0-9_-]{1,50})$/)
          .default("main"),
      })
      .parse(req.body);
    const changeId = proposeChanges(
      room,
      `user:${user.id}`,
      null,
      data.title,
      data.files,
      data.branch,
    );
    audit(room.workspaceId, user.id, "project.propose", changeId);
    notify(room.id);
    return reply.code(201).send({ id: changeId });
  });
  app.post("/api/rooms/:id/project/changes/:changeId/review", async (req) => {
    const { room, user, role } = await roomAccess(req, true);
    editRoomAllowed(room, user.id, role);
    const data = z
      .object({ decision: z.enum(["approve", "reject"]) })
      .parse(req.body);
    const result = reviewChange(
      room,
      (req.params as any).changeId,
      user.id,
      data.decision,
    );
    notify(room.id);
    return result;
  });
  app.get("/api/rooms/:id/project/export", async (req, reply) => {
    const { room } = await roomAccess(req);
    ordinaryRoomOnly(room);
    const data = z
      .object({
        branch: z
          .string()
          .regex(/^(main|agent-[a-zA-Z0-9_-]{1,50})$/)
          .default("main"),
      })
      .parse(req.query);
    reply
      .type("application/zip")
      .header(
        "Content-Disposition",
        `attachment; filename="agent-family-project-${room.id}.zip"`,
      );
    return projectZip(room.id, data.branch);
  });
  app.get("/api/settings", async (req) => {
    const c = await context(req);
    return {
      providers: ["owner", "admin"].includes(c.role)
        ? listProviders(c.workspaceId)
        : [],
      usage: usage(c.workspaceId),
      line: ["owner", "admin"].includes(c.role)
        ? publicChannel(c.workspaceId)
        : null,
      capabilities: {
        safeTools: ["当前时间", "本群笔记", "保存草稿"],
        codeExecution: false,
        externalWrites: false,
      },
      role: c.role,
    };
  });
  app.put("/api/settings/providers", async (req) => {
    const c = await context(req);
    admin(c.role);
    const data = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
        kind: z.enum(["compatible", "openai", "anthropic", "google"]),
        baseUrl: z.url().max(300),
        apiKey: z.string().max(1000).optional(),
        models: z.array(z.string().min(1).max(180)).max(500),
      })
      .parse(req.body);
    const previousProvider = db
      .prepare(
        "SELECT kind,base_url FROM providers WHERE workspace_id=? AND id=?",
      )
      .get(c.workspaceId, data.id) as
      { kind: string; base_url: string } | undefined;
    if (
      !previousProvider ||
      previousProvider.kind !== data.kind ||
      previousProvider.base_url.replace(/\/$/, "") !==
        data.baseUrl.replace(/\/$/, "")
    ) {
      const groups = db
        .prepare(
          "SELECT snapshot FROM family_groups WHERE workspace_id=? AND status IN ('proposed','active','paused')",
        )
        .all(c.workspaceId) as { snapshot: string }[];
      if (
        groups.some((g) =>
          JSON.parse(g.snapshot).some((a: any) => a.provider === data.id),
        )
      )
        fail(
          409,
          "此服务正在被主人审批群使用，不能直接更换接收消息的地址或协议。请用新标识添加服务，再提议新群。",
        );
    }
    saveProvider(c.workspaceId, data);
    audit(c.workspaceId, c.user.id, "provider.save", data.id);
    return { ok: true };
  });
  app.post("/api/settings/providers/:providerId/refresh", async (req) => {
    const c = await context(req);
    admin(c.role);
    const models = await refreshModels(
      c.workspaceId,
      (req.params as any).providerId,
    );
    const rooms = db
      .prepare("SELECT * FROM rooms WHERE workspace_id=? AND created_by=?")
      .all(c.workspaceId, c.user.id) as any[];
    for (const row of rooms) {
      const room = roomFrom(row);
      if (familyRoomPolicy(room.id)) continue;
      if (room.agents.some((a) => !a.model)) {
        const agents = defaultAgentsWithModels(c.workspaceId, room.agents).map(
          (a, i) => (room.agents[i].model ? room.agents[i] : a),
        );
        db.prepare("UPDATE rooms SET agents=? WHERE id=?").run(
          JSON.stringify(agents),
          room.id,
        );
        notify(room.id);
      }
    }
    return { count: models.length };
  });
  app.get("/api/members", async (req) => {
    const c = await context(req);
    return db
      .prepare(
        "SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN user u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.role",
      )
      .all(c.workspaceId);
  });
  app.patch("/api/members/:userId", async (req) => {
    const c = await context(req);
    if (c.role !== "owner") fail(403, "只有空间所有者可以调整成员权限。");
    const target = (req.params as any).userId;
    if (target === c.user.id) fail(400, "不能修改自己的所有者权限。");
    const data = z
      .object({ role: z.enum(["admin", "member", "viewer"]) })
      .parse(req.body);
    db.prepare(
      "UPDATE memberships SET role=? WHERE user_id=? AND workspace_id=? AND role!='owner'",
    ).run(data.role, target, c.workspaceId);
    audit(c.workspaceId, c.user.id, "member.role", target);
    return { ok: true };
  });
  app.delete("/api/members/:userId", async (req) => {
    const c = await context(req);
    if (c.role !== "owner") fail(403, "只有空间所有者可以移除成员。");
    const target = (req.params as any).userId;
    if (target === c.user.id) fail(400, "不能移除空间所有者。");
    db.prepare(
      "DELETE FROM memberships WHERE user_id=? AND workspace_id=? AND role!='owner'",
    ).run(target, c.workspaceId);
    audit(c.workspaceId, c.user.id, "member.remove", target);
    return { ok: true };
  });
  app.post("/api/invites", async (req) => {
    const c = await context(req);
    admin(c.role);
    const data = z
      .object({ role: z.enum(["admin", "member", "viewer"]).default("member") })
      .parse(req.body);
    if (data.role === "admin" && c.role !== "owner")
      fail(403, "只有所有者可以邀请管理员。");
    const token = crypto.randomBytes(24).toString("base64url");
    const inviteId = id(),
      expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
    db.prepare("INSERT INTO invites VALUES(?,?,?,?,?,NULL,?)").run(
      inviteId,
      c.workspaceId,
      sha(token),
      data.role,
      expiresAt,
      c.user.id,
    );
    audit(c.workspaceId, c.user.id, "invite.create", inviteId);
    return { url: `${config.origin}/?invite=${token}`, expiresAt };
  });
  app.get("/api/invites/:token", async (req) => {
    const invite = db
      .prepare(
        "SELECT i.role,w.name FROM invites i JOIN workspaces w ON w.id=i.workspace_id WHERE token_hash=? AND expires_at>? AND used_at IS NULL",
      )
      .get(sha((req.params as any).token), now());
    if (!invite) fail(404, "邀请已使用或过期，请联系邀请人。");
    return invite;
  });
  app.post(
    "/api/invites/accept",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req) => {
      const data = z
        .object({
          token: z.string().max(100),
          name: z.string().trim().min(1).max(40).optional(),
          email: z.email().max(200).optional(),
          password: z.string().min(10).max(128).optional(),
        })
        .parse(req.body);
      const invite = db
        .prepare(
          "SELECT * FROM invites WHERE token_hash=? AND expires_at>? AND used_at IS NULL",
        )
        .get(sha(data.token), now()) as any;
      if (!invite) fail(400, "邀请已使用或过期。");
      const existing = await auth.api.getSession({
        headers: requestHeaders(req.headers, req.ip),
      });
      let userId = existing?.user.id;
      if (!userId) {
        if (!data.name || !data.email || !data.password)
          fail(400, "请填写姓名、邮箱和密码。");
        const created = await auth.api.signUpEmail({
          body: {
            name: data.name!,
            email: data.email!,
            password: data.password!,
          },
        });
        userId = created.user.id;
      }
      db.transaction(() => {
        const used = db
          .prepare(
            "UPDATE invites SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?",
          )
          .run(now(), invite.id, now());
        if (!used.changes) fail(409, "邀请已被使用。");
        db.prepare("INSERT OR IGNORE INTO memberships VALUES(?,?,?)").run(
          invite.workspace_id,
          userId,
          invite.role,
        );
      })();
      audit(invite.workspace_id, userId!, "invite.accept", invite.id);
      return { ok: true, workspaceId: invite.workspace_id };
    },
  );
  app.patch("/api/workspace", async (req) => {
    const c = await context(req);
    admin(c.role);
    const data = z
      .object({ name: z.string().trim().min(1).max(60) })
      .parse(req.body);
    db.prepare("UPDATE workspaces SET name=? WHERE id=?").run(
      data.name,
      c.workspaceId,
    );
    return { ok: true };
  });
  app.get("/api/audit", async (req) => {
    const c = await context(req);
    admin(c.role);
    return db
      .prepare(
        "SELECT a.id,a.action,a.target,a.created_at AS createdAt,COALESCE(u.name,a.actor) AS actor FROM audit a LEFT JOIN user u ON u.id=a.actor WHERE a.workspace_id=? AND a.action NOT LIKE 'family.%' ORDER BY a.created_at DESC LIMIT 100",
      )
      .all(c.workspaceId);
  });
  app.put("/api/settings/line", async (req) => {
    const c = await context(req);
    admin(c.role);
    const data = z
      .object({
        secret: z.string().min(10).max(200).optional(),
        token: z.string().min(10).max(1000).optional(),
      })
      .parse(req.body);
    const result = saveChannel(c.workspaceId, data.secret, data.token);
    audit(c.workspaceId, c.user.id, "line.configure", result!.id);
    return result;
  });
  app.post("/api/settings/line/verify", async (req) => {
    const c = await context(req);
    admin(c.role);
    return verifyChannel(c.workspaceId);
  });
  app.patch("/api/settings/line", async (req) => {
    const c = await context(req);
    admin(c.role);
    const data = z.object({ enabled: z.boolean() }).parse(req.body);
    const channel = db
      .prepare("SELECT * FROM line_channels WHERE workspace_id=?")
      .get(c.workspaceId) as any;
    if (!channel) fail(400, "请先配置 LINE。");
    if (data.enabled && !channel.verified)
      fail(400, "请先验证 LINE access token。");
    db.prepare("UPDATE line_channels SET enabled=? WHERE workspace_id=?").run(
      Number(data.enabled),
      c.workspaceId,
    );
    audit(
      c.workspaceId,
      c.user.id,
      data.enabled ? "line.enable" : "line.disable",
      channel.id,
    );
    return { ok: true };
  });
  app.get("/api/rooms/:id/line", async (req) => {
    const { room, user, role } = await roomAccess(req);
    editRoomAllowed(room, user.id, role);
    const binding = db
      .prepare(
        "SELECT mode,share_tools,created_at,discussion FROM line_bindings WHERE room_id=?",
      )
      .get(room.id) as any;
    return {
      linked: !!binding,
      mode: binding?.mode || "parallel",
      shareTools: !!binding?.share_tools,
      discussion: discussionSettings(
        binding ? JSON.parse(binding.discussion) : undefined,
      ),
      usage: usage(room.workspaceId),
      resources: {
        messages: (
          db
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id=?")
            .get(room.id) as any
        ).n,
        notes: (
          db
            .prepare("SELECT COUNT(*) AS n FROM notes WHERE room_id=?")
            .get(room.id) as any
        ).n,
        files: (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM project_files WHERE room_id=? AND content IS NOT NULL",
            )
            .get(room.id) as any
        ).n,
      },
      challenge:
        db
          .prepare(
            "SELECT code,expires_at AS expiresAt,group_id IS NOT NULL AS received,group_name AS groupName,confirmed FROM line_challenges WHERE room_id=? AND created_by=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
          )
          .get(room.id, user.id, now()) || null,
    };
  });
  app.post("/api/rooms/:id/line/challenge", async (req) => {
    const { room, user, role } = await roomAccess(req, true);
    editRoomAllowed(room, user.id, role);
    return createChallenge(room.workspaceId, room.id, user.id);
  });
  app.post("/api/rooms/:id/line/confirm", async (req) => {
    const { room, user, role } = await roomAccess(req, true);
    editRoomAllowed(room, user.id, role);
    const data = z
      .object({
        shareContext: z.literal(true),
        mode: modeSchema.default("parallel"),
        shareTools: z.boolean().default(false),
        discussion: discussionSchema.optional(),
      })
      .parse(req.body);
    const result = confirmChallenge(room.workspaceId, room.id, user.id, data);
    audit(room.workspaceId, user.id, "line.bind", room.id);
    return result;
  });
  app.delete("/api/rooms/:id/line", async (req) => {
    const { room, user, role } = await roomAccess(req, true);
    editRoomAllowed(room, user.id, role);
    db.prepare("DELETE FROM line_bindings WHERE room_id=?").run(room.id);
    db.prepare("DELETE FROM line_challenges WHERE room_id=?").run(room.id);
    audit(room.workspaceId, user.id, "line.unbind", room.id);
    notify(room.id);
    return { ok: true };
  });
  app.patch("/api/rooms/:id/line", async (req) => {
    const { room, user, role } = await roomAccess(req, true);
    editRoomAllowed(room, user.id, role);
    const data = z
      .object({
        mode: modeSchema,
        shareTools: z.boolean(),
        discussion: discussionSchema.optional(),
      })
      .parse(req.body);
    const result = updateBinding(
      room.id,
      data.mode,
      data.shareTools,
      data.discussion,
    );
    audit(room.workspaceId, user.id, "line.policy", room.id);
    return result;
  });
  await registerLineWebhook(app);
  registerChatEntry(app);
  if (fs.existsSync(path.join(root, "dist", "index.html"))) {
    await app.register(fastifyStatic, {
      root: path.join(root, "dist"),
      prefix: "/",
      maxAge: "1h",
      index: "index.html",
      setHeaders: (reply, filePath) => {
        if (filePath.endsWith(".html"))
          reply.header("Cache-Control", "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/"))
        return reply.code(404).send({ error: "接口不存在。" });
      return reply
        .type("text/html")
        .header("Cache-Control", "no-cache")
        .send(fs.readFileSync(path.join(root, "dist", "index.html")));
    });
  }
  app.addHook("onClose", async () => {
    changes.removeAllListeners();
  });
  return app;
}
