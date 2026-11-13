import { validateSignature, messagingApi } from "@line/bot-sdk";
import { db, getRoom, getMessages, getRuns, audit } from "./db";
import { decrypt, encrypt, id, now } from "./config";
import { startRun, waitForRun, notify } from "./orchestrator";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { lineScopeFor, assertLineScope } from "./line-access";
import { lineMessages } from "./line-output";
import { MODE_LABELS, type Mode } from "../shared/types";
export function publicChannel(workspaceId: string) {
  const channel = db
    .prepare("SELECT * FROM line_channels WHERE workspace_id=?")
    .get(workspaceId) as any;
  if (!channel) return null;
  return {
    id: channel.id,
    enabled: !!channel.enabled,
    verified: !!channel.verified,
    webhookPath: `/api/line/webhook/${channel.id}`,
    bindings: (
      db
        .prepare(
          "SELECT room_id,created_at FROM line_bindings WHERE channel_id=?",
        )
        .all(channel.id) as any[]
    ).map((b) => ({ roomId: b.room_id, createdAt: b.created_at })),
    recentEvents: db
      .prepare(
        "SELECT id,status,created_at AS createdAt,error FROM line_events WHERE channel_id=? ORDER BY created_at DESC LIMIT 8",
      )
      .all(channel.id),
    recentDeliveries: db
      .prepare(
        "SELECT id,status,created_at AS createdAt,error FROM line_outbox WHERE channel_id=? ORDER BY created_at DESC LIMIT 8",
      )
      .all(channel.id),
  };
}
export function saveChannel(
  workspaceId: string,
  secret?: string,
  token?: string,
) {
  const old = db
    .prepare("SELECT * FROM line_channels WHERE workspace_id=?")
    .get(workspaceId) as any;
  if (!old && (!secret || !token))
    throw new Error("请输入 Channel secret 和 Channel access token。");
  const channelId = old?.id || id();
  db.prepare(
    "INSERT INTO line_channels VALUES(?,?,?,?,0,0,?) ON CONFLICT(workspace_id) DO UPDATE SET secret=excluded.secret,token=excluded.token,verified=0,enabled=0",
  ).run(
    channelId,
    workspaceId,
    secret ? encrypt(secret) : old.secret,
    token ? encrypt(token) : old.token,
    now(),
  );
  return publicChannel(workspaceId);
}
export async function verifyChannel(workspaceId: string) {
  const c = db
    .prepare("SELECT * FROM line_channels WHERE workspace_id=?")
    .get(workspaceId) as any;
  if (!c) throw new Error("请先保存 LINE 配置。");
  const response = await fetch("https://api.line.me/v2/bot/info", {
    headers: { Authorization: `Bearer ${decrypt(c.token)}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `LINE 验证失败（${response.status}）。请检查 access token。`,
    );
  const info = (await response.json()) as any;
  db.prepare("UPDATE line_channels SET verified=1 WHERE id=?").run(c.id);
  return { displayName: info.displayName, basicId: info.basicId };
}
export function createChallenge(
  workspaceId: string,
  roomId: string,
  userId: string,
) {
  const c = db
    .prepare("SELECT * FROM line_channels WHERE workspace_id=?")
    .get(workspaceId) as any;
  if (!c?.enabled) throw new Error("请先验证并启用 LINE 连接。");
  db.prepare("DELETE FROM line_challenges WHERE room_id=? OR expires_at<?").run(
    roomId,
    now(),
  );
  const code = crypto.randomBytes(5).toString("hex").toUpperCase();
  db.prepare(
    "INSERT INTO line_challenges(code,channel_id,room_id,created_by,expires_at,group_id,confirmed) VALUES(?,?,?,?,?,NULL,0)",
  ).run(
    code,
    c.id,
    roomId,
    userId,
    new Date(Date.now() + 10 * 60000).toISOString(),
  );
  return { code, expiresAt: new Date(Date.now() + 10 * 60000).toISOString() };
}
export function confirmChallenge(
  workspaceId: string,
  roomId: string,
  userId: string,
  options: { mode?: Mode; shareTools?: boolean } = {},
) {
  return db.transaction(() => {
    const challenge = db
      .prepare(
        "SELECT c.* FROM line_challenges c JOIN line_channels l ON c.channel_id=l.id WHERE l.workspace_id=? AND c.room_id=? AND c.created_by=? AND c.expires_at>? AND c.confirmed=0",
      )
      .get(workspaceId, roomId, userId, now()) as any;
    if (!challenge?.group_id)
      throw new Error("尚未收到 LINE 群里的绑定指令，或绑定码已经过期。");
    const existing = db
      .prepare("SELECT * FROM line_bindings WHERE group_id=?")
      .get(challenge.group_id) as any;
    if (existing && existing.room_id !== roomId)
      throw new Error("这个 LINE 群已经连接了另一个群聊，请先解除原连接。");
    if (db.prepare("SELECT 1 FROM line_bindings WHERE room_id=?").get(roomId))
      throw new Error("当前群聊已经连接 LINE。");
    db.prepare(
      "INSERT INTO line_bindings(group_id,channel_id,room_id,created_at,mode,share_tools,context_after,scope_id) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(rowid),0) FROM messages),?)",
    ).run(
      challenge.group_id,
      challenge.channel_id,
      roomId,
      now(),
      options.mode || "parallel",
      options.shareTools ? 1 : 0,
      id(),
    );
    db.prepare("UPDATE line_challenges SET confirmed=1 WHERE code=?").run(
      challenge.code,
    );
    notify(roomId);
    return { linked: true };
  })();
}
export function updateBinding(roomId: string, mode: Mode, shareTools: boolean) {
  return db.transaction(() => {
    const b = db
      .prepare("SELECT * FROM line_bindings WHERE room_id=?")
      .get(roomId) as any;
    if (!b) throw new Error("请先连接 LINE 群。");
    const changed = !!b.share_tools !== shareTools;
    db.prepare(
      "UPDATE line_bindings SET mode=?,share_tools=?,scope_id=?,context_after=? WHERE room_id=?",
    ).run(
      mode,
      shareTools ? 1 : 0,
      changed ? id() : b.scope_id,
      changed
        ? (
            db
              .prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM messages")
              .get() as any
          ).n
        : b.context_after,
      roomId,
    );
    notify(roomId);
    return { ok: true, contextReset: changed };
  })();
}
export async function registerLineWebhook(app: FastifyInstance) {
  await app.register(async (scoped) => {
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 256 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scoped.post(
      "/api/line/webhook/:id",
      { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const channelId = (req.params as any).id;
        const c = db
          .prepare("SELECT * FROM line_channels WHERE id=?")
          .get(channelId) as any;
        if (!c) return reply.code(404).send({ error: "Unknown channel" });
        const signature = req.headers["x-line-signature"];
        if (
          typeof signature !== "string" ||
          !Buffer.isBuffer(req.body) ||
          !validateSignature(req.body, decrypt(c.secret), signature)
        )
          return reply.code(401).send({ error: "Invalid signature" });
        let payload: any;
        try {
          payload = JSON.parse(req.body.toString("utf8"));
        } catch {
          return reply.code(400).send({ error: "Invalid JSON" });
        }
        if (!Array.isArray(payload.events))
          return reply.code(400).send({ error: "Invalid events" });
        for (const event of payload.events.slice(0, 100)) {
          if (
            event.type === "leave" &&
            event.source?.type === "group" &&
            typeof event.source.groupId === "string" &&
            typeof event.webhookEventId === "string" &&
            event.webhookEventId.length <= 150
          ) {
            db.transaction(() => {
              const inserted = db
                .prepare(
                  "INSERT OR IGNORE INTO line_events VALUES(?,?,?,?,?,NULL)",
                )
                .run(event.webhookEventId, c.id, "{}", "done", now());
              if (!inserted.changes) return;
              const binding = db
                .prepare(
                  "SELECT room_id FROM line_bindings WHERE group_id=? AND channel_id=?",
                )
                .get(event.source.groupId, c.id) as
                { room_id: string } | undefined;
              db.prepare(
                "DELETE FROM line_bindings WHERE group_id=? AND channel_id=?",
              ).run(event.source.groupId, c.id);
              db.prepare(
                "DELETE FROM line_challenges WHERE group_id=? AND channel_id=?",
              ).run(event.source.groupId, c.id);
              if (binding) {
                audit(
                  c.workspace_id,
                  "line",
                  "line.group_left",
                  binding.room_id,
                );
                notify(binding.room_id);
              }
            })();
            continue;
          }
          if (!c.enabled) continue;
          if (
            event.type !== "message" ||
            event.message?.type !== "text" ||
            event.source?.type !== "group" ||
            typeof event.source?.groupId !== "string" ||
            typeof event.webhookEventId !== "string"
          )
            continue;
          const text = String(event.message.text).trim();
          if (!/^\/(?:af|家族|绑定)(?:\s|$)/i.test(text)) continue;
          const eventId = event.webhookEventId;
          if (eventId.length > 150 || text.length > 12000) continue;
          const inserted = db
            .prepare("INSERT OR IGNORE INTO line_events VALUES(?,?,?,?,?,NULL)")
            .run(
              eventId,
              c.id,
              encrypt(
                JSON.stringify({
                  ...event,
                  afScope:
                    (
                      db
                        .prepare(
                          "SELECT scope_id FROM line_bindings WHERE group_id=? AND channel_id=?",
                        )
                        .get(event.source.groupId, c.id) as any
                    )?.scope_id || null,
                }),
              ),
              "queued",
              now(),
            );
          if (inserted.changes)
            queueMicrotask(() => {
              void processEvent(eventId);
            });
        }
        return { ok: true };
      },
    );
  });
}
export async function resumeQueuedLineEvents() {
  for (const e of db
    .prepare(
      "SELECT id FROM line_events WHERE status='queued' ORDER BY created_at LIMIT 50",
    )
    .all() as any[])
    void processEvent(e.id);
}
async function processEvent(eventId: string) {
  const changed = db
    .prepare(
      "UPDATE line_events SET status='processing' WHERE id=? AND status='queued'",
    )
    .run(eventId);
  if (!changed.changes) return;
  const row = db
    .prepare("SELECT * FROM line_events WHERE id=?")
    .get(eventId) as any;
  const c = db
    .prepare("SELECT * FROM line_channels WHERE id=?")
    .get(row.channel_id) as any;
  try {
    if (!c?.enabled) throw new Error("连接已停用");
    const event = JSON.parse(decrypt(row.payload));
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: decrypt(c.token),
    });
    const text = event.message.text.trim();
    const groupId = event.source.groupId;
    const replyText = async (content: string) => {
      if (!event.replyToken) return;
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: content.slice(0, 4900) }],
      });
    };
    if (/^\/绑定\s/.test(text)) {
      const code = text
        .replace(/^\/绑定\s+/, "")
        .trim()
        .toUpperCase();
      const challenge = db
        .prepare(
          "SELECT * FROM line_challenges WHERE code=? AND channel_id=? AND expires_at>? AND confirmed=0",
        )
        .get(code, c.id, now()) as any;
      if (!challenge) {
        await replyText("绑定码无效或已过期。请在 Agent Family 网页重新生成。");
      } else if (challenge.group_id && challenge.group_id !== groupId) {
        await replyText("该绑定码已被使用，请重新生成。");
      } else {
        let groupName = `LINE 群（${groupId.slice(-6)}）`;
        try {
          const summary = await fetch(
            `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`,
            {
              headers: { Authorization: `Bearer ${decrypt(c.token)}` },
              signal: AbortSignal.timeout(8000),
            },
          );
          if (summary.ok) {
            const info = (await summary.json()) as any;
            if (typeof info.groupName === "string")
              groupName = info.groupName.slice(0, 100);
          }
        } catch {
          /* Optional display-name lookup. The signed challenge remains valid without it. */
        }
        db.prepare(
          "UPDATE line_challenges SET group_id=?,group_name=? WHERE code=?",
        ).run(groupId, groupName, code);
        notify(challenge.room_id);
        await replyText(
          "已收到绑定请求，请回到网页确认。连接后 /af 指令及回答会保存在网页；默认仅使用本次绑定后的 LINE 对话，不读取网页历史。若创建者明确开放笔记和项目，其中资料可能出现在本群回答中。",
        );
      }
    } else {
      const binding = db
        .prepare(
          "SELECT * FROM line_bindings WHERE group_id=? AND channel_id=?",
        )
        .get(groupId, c.id) as any;
      if (!binding) {
        await replyText(
          "这个群还没有连接 Agent Family。请在网页的「连接 LINE」中获取绑定码。",
        );
      } else {
        if (event.afScope !== binding.scope_id)
          throw new Error("连接范围已变更，旧指令不再执行");
        const room = getRoom(binding.room_id);
        if (!room || room.archived) {
          await replyText("对应的网页群聊已归档，请联系群聊创建者。");
        } else {
          const content = text.replace(/^\/(?:af|家族)\s*/i, "").trim();
          if (!content) {
            await replyText(
              `用法：/af 你的问题\n点名：/af @小文 帮我润色这段文字\n当前模式：${MODE_LABELS[binding.mode as Mode]}\n默认仅使用本次绑定后的 LINE 对话；资料工具${binding.share_tools ? "已开放，本群全部笔记和项目可能进入回答" : "未开放"}。请勿发送密码或密钥。`,
            );
          } else {
            const actor =
              "line:" +
              crypto
                .createHash("sha256")
                .update(groupId + ":" + (event.source.userId || groupId))
                .digest("hex")
                .slice(0, 12);
            let runId: string;
            const scope = lineScopeFor(groupId, c.id, room.id);
            try {
              runId = startRun({
                room,
                actor,
                author: `LINE 成员 ${actor.slice(-6)}`,
                content,
                source: "line",
                lineScope: scope,
              });
            } catch (e: any) {
              await replyText(e.message);
              finishEvent(eventId, "done");
              return;
            }
            const completed = waitForRun(runId).then(() => true);
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const fast = await Promise.race([
              completed,
              new Promise<boolean>((r) => {
                timeout = setTimeout(
                  () => r(false),
                  Math.max(
                    1000,
                    42000 -
                      Math.max(0, Date.now() - (event.timestamp || Date.now())),
                  ),
                );
              }),
            ]);
            if (timeout) clearTimeout(timeout);
            let usedReply = false;
            if (!fast) {
              await replyText(
                "伙伴们正在思考，完成后会把回答发到这里。你也可以到网页查看进度。",
              );
              usedReply = true;
              await completed;
            }
            assertLineScope(scope, room.id);
            {
              const messages = getMessages(room.id).filter(
                (m) => m.runId === runId,
              );
              const outputs = lineMessages(
                messages,
                getRuns(room.id).find((r) => r.id === runId),
              );
              if (outputs.length) {
                const outboxId = id();
                db.prepare(
                  "INSERT INTO line_outbox VALUES(?,?,?,?,?,?,NULL)",
                ).run(outboxId, c.id, groupId, runId, "sending", now());
                try {
                  if (
                    !usedReply &&
                    event.replyToken &&
                    Date.now() - (event.timestamp || Date.now()) < 50000
                  ) {
                    await client.replyMessage({
                      replyToken: event.replyToken,
                      messages: outputs,
                    });
                  } else {
                    await client.pushMessage(
                      { to: groupId, messages: outputs },
                      outboxId,
                    );
                  }
                  db.prepare(
                    "UPDATE line_outbox SET status='sent' WHERE id=?",
                  ).run(outboxId);
                } catch {
                  db.prepare(
                    "UPDATE line_outbox SET status='unknown',error='LINE 发送结果未确认；未自动重发，以免重复消息或计费' WHERE id=?",
                  ).run(outboxId);
                  throw new Error("回答已在网页保存，LINE 发送结果未确认");
                }
              }
            }
          }
        }
      }
    }
    finishEvent(eventId, "done");
  } catch {
    finishEvent(
      eventId,
      "error",
      "LINE 处理未完成。请检查配置、额度与网页任务状态。",
    );
  }
}
function finishEvent(
  eventId: string,
  status: string,
  error: string | null = null,
) {
  db.prepare(
    "UPDATE line_events SET status=?,payload=?,error=? WHERE id=?",
  ).run(status, "{}", error, eventId);
}
