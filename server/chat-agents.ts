import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { db } from "./db";
import { config, dataDir, decrypt, encrypt, id, now } from "./config";
import { listModels, modelFor } from "./providers";
import {
  matrixOptions,
  matrixLocalpart,
  provisionMatrixAccount,
} from "./matrix-account";
import { localMatrixId, socialError } from "./social-store";
import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

type AgentRow = {
  id: string;
  owner_id: string;
  workspace_id: string;
  name: string;
  persona: string;
  provider: string;
  model: string;
  status: string;
  matrix_id: string;
  password: string;
  token: string;
  device_id: string;
  room_id: string;
  generation: number;
  created_at: string;
  updated_at: string;
};
type AgentInput = {
  name: string;
  persona: string;
  provider: string;
  model: string;
};
type Context = { user: { id: string }; workspaceId: string };
type Running = {
  client: MatrixClient;
  abort?: AbortController;
  deliveries: Set<Promise<unknown>>;
  busy: boolean;
  after: number;
  history: { role: "user" | "assistant"; content: string }[];
};
const running = new Map<string, Running>();
const starting = new Map<string, Promise<Running>>();
export function publicChatAgent(a: AgentRow) {
  return {
    id: a.id,
    name: a.name,
    persona: a.persona,
    provider: a.provider,
    model: a.model,
    status: a.status,
    matrixId: a.matrix_id,
    roomId: a.room_id,
    connected: running.has(a.id),
    models: ownerCanRun(a) ? listModels(a.workspace_id) : [],
    computer: "none",
    dailyLimit: 20,
  };
}
function own(owner: string, agentId: string) {
  const a = db
    .prepare("SELECT * FROM chat_agents WHERE id=? AND owner_id=?")
    .get(agentId, owner) as AgentRow | undefined;
  if (!a) throw socialError(404, "Agent 不存在或不属于你。");
  return a;
}
function configured(c: Context, p: Pick<AgentInput, "model" | "provider">) {
  if (
    !listModels(c.workspaceId).some(
      (m) => m.id === p.model && m.provider === p.provider,
    )
  )
    throw socialError(400, "请选择已配置的模型。");
}
export function ownerCanRun(a: Pick<AgentRow, "owner_id" | "workspace_id">) {
  const membership = db
    .prepare("SELECT role FROM memberships WHERE user_id=? AND workspace_id=?")
    .get(a.owner_id, a.workspace_id) as { role: string } | undefined;
  return !!membership && membership.role !== "viewer";
}
const provisioning = new Map<string, Promise<void>>();
async function provisionIdentity(a: AgentRow) {
  if (a.token) return;
  if (provisioning.has(a.id)) return provisioning.get(a.id)!;
  const task = (async () => {
    const options = matrixOptions()!;
    const password = decrypt(a.password);
    await provisionMatrixAccount(
      options,
      `chat-agent:${a.id}`,
      `${a.name} · Agent`,
      password,
    );
    const response = await fetch(
      `${options.homeserver}/_matrix/client/v3/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "m.login.password",
          identifier: { type: "m.id.user", user: a.matrix_id },
          password,
          initial_device_display_name: "Agent Family persistent runner",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    const body = (await response.json()) as any;
    if (
      !response.ok ||
      body.user_id !== a.matrix_id ||
      !body.device_id ||
      !body.access_token
    )
      throw new Error("login_failed");
    db.prepare(
      "UPDATE chat_agents SET token=?,device_id=?,password='',updated_at=? WHERE id=?",
    ).run(encrypt(body.access_token), body.device_id, now(), a.id);
  })();
  provisioning.set(a.id, task);
  try {
    await task;
  } finally {
    provisioning.delete(a.id);
  }
}
export async function createChatAgent(c: Context, p: AgentInput) {
  configured(c, p);
  const options = matrixOptions();
  if (!options) throw socialError(503, "聊天服务尚未配置。");
  if (
    (
      db
        .prepare("SELECT count(*) n FROM chat_agents WHERE owner_id=?")
        .get(c.user.id) as any
    ).n >= 10
  )
    throw socialError(409, "初始版每位主人最多 10 个 Agent。");
  const agentId = id(),
    identity = `chat-agent:${agentId}`,
    stamp = now();
  const password = crypto.randomBytes(36).toString("base64url");
  const mxid = `@${matrixLocalpart(identity)}:${options.serverName}`;
  db.prepare(
    "INSERT INTO chat_agents(id,owner_id,workspace_id,name,persona,provider,model,status,matrix_id,password,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    agentId,
    c.user.id,
    c.workspaceId,
    p.name,
    p.persona,
    p.provider,
    p.model,
    "provisioning",
    mxid,
    encrypt(password),
    stamp,
    stamp,
  );
  try {
    await provisionIdentity(own(c.user.id, agentId));
    await startAgent(agentId);
    db.prepare(
      "UPDATE chat_agents SET status='active',updated_at=? WHERE id=?",
    ).run(now(), agentId);
    return publicChatAgent(own(c.user.id, agentId));
  } catch {
    db.prepare(
      "UPDATE chat_agents SET status='error',updated_at=? WHERE id=?",
    ).run(now(), agentId);
    throw socialError(
      502,
      "Agent 接入未完成，已保留记录且不会执行。请稍后查看状态或联系管理员。",
    );
  }
}
export async function updateChatAgent(
  c: Context,
  agentId: string,
  p: Partial<AgentInput> & { paused?: boolean },
) {
  const old = own(c.user.id, agentId);
  const merged = { ...old, ...p };
  if (p.paused !== true && !ownerCanRun(old))
    throw socialError(403, "你已没有此 Agent 所用模型空间的运行权限。");
  if (p.paused !== true)
    configured({ ...c, workspaceId: old.workspace_id }, merged);
  if (old.status === "provisioning")
    throw socialError(409, "Agent 正在接入，请稍后重试。");
  const live = running.get(agentId);
  live?.abort?.abort();
  if (live) {
    live.history = [];
    live.after = Date.now();
  }
  const status =
    p.paused === true ? "paused" : p.paused === false ? "paused" : old.status;
  db.prepare(
    "UPDATE chat_agents SET name=?,persona=?,provider=?,model=?,status=?,generation=generation+1,updated_at=? WHERE id=?",
  ).run(
    merged.name,
    merged.persona,
    merged.provider,
    merged.model,
    status,
    now(),
    agentId,
  );
  // Confirm pause only after any Matrix submission already in flight has settled.
  if (live) await Promise.allSettled([...live.deliveries]);
  if (p.paused === false || status === "active") {
    try {
      if (!old.token) await provisionIdentity(own(c.user.id, agentId));
      await startAgent(agentId);
      db.prepare(
        "UPDATE chat_agents SET status='active',updated_at=? WHERE id=? AND generation=?",
      ).run(now(), agentId, old.generation + 1);
    } catch {
      db.prepare(
        "UPDATE chat_agents SET status='error' WHERE id=? AND generation=?",
      ).run(agentId, old.generation + 1);
      throw socialError(502, "接入暂未成功，可以再次点击重试接入。");
    }
  }
  if (live && p.name && p.name !== old.name)
    await live.client
      .setDisplayName(`${p.name} · Agent`)
      .catch(() => undefined);
  return publicChatAgent(own(c.user.id, agentId));
}
export async function openAgentRoom(owner: string, agentId: string) {
  let a = own(owner, agentId);
  if (!a.token) throw socialError(409, "Agent 身份尚未就绪。");
  const live = await startAgent(agentId);
  // Creation serialized per Agent so double clicks cannot create two privileged rooms.
  if (roomCreating.has(agentId)) return roomCreating.get(agentId)!;
  const creation = (async () => {
    a = own(owner, agentId);
    const ownerMx = localMatrixId(owner);
    if (a.room_id) {
      const joined = await live.client.getJoinedRooms();
      if (joined.includes(a.room_id)) {
        const membership = await live.client
          .getRoomStateEvent(a.room_id, "m.room.member", ownerMx)
          .catch(() => ({ membership: "leave" }));
        if (membership.membership === "leave")
          await live.client.inviteUser(ownerMx, a.room_id);
        else if (membership.membership === "ban")
          throw socialError(409, "主人在此房间被封禁，暂不能重新加入。");
        return a.room_id;
      }
    }
    const roomId = await live.client.createRoom({
      name: `${a.name} · 我的 Agent`,
      topic: "主人可见的 Agent 私聊。仅主人与此 Agent；无电脑或工具权限。",
      preset: "private_chat",
      is_direct: true,
      visibility: "private",
      // v12 gives the creator implicit infinite power; listing it in users is invalid.
      room_version: "12",
      invite: [ownerMx],
      power_level_content_override: {
        users: { [ownerMx]: 50 },
        users_default: 0,
        events_default: 0,
        state_default: 100,
        invite: 100,
        kick: 100,
        ban: 100,
        redact: 50,
      },
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
        {
          type: "m.room.history_visibility",
          state_key: "",
          content: { history_visibility: "joined" },
        },
        {
          type: "m.room.guest_access",
          state_key: "",
          content: { guest_access: "forbidden" },
        },
      ],
    });
    db.prepare("UPDATE chat_agents SET room_id=?,updated_at=? WHERE id=?").run(
      roomId,
      now(),
      agentId,
    );
    return roomId;
  })();
  roomCreating.set(agentId, creation);
  try {
    return await creation;
  } finally {
    roomCreating.delete(agentId);
  }
}
const roomCreating = new Map<string, Promise<string>>();
export function reserveChatCall(agentId: string, day = now().slice(0, 10)) {
  return db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO chat_agent_usage VALUES(?,?,0)").run(
      agentId,
      day,
    );
    return (
      db
        .prepare(
          "UPDATE chat_agent_usage SET calls=calls+1 WHERE agent_id=? AND day=? AND calls<20",
        )
        .run(agentId, day).changes === 1
    );
  })();
}
export function eligibleAgentMessage(
  a: Pick<AgentRow, "status" | "room_id">,
  roomId: string,
  event: any,
  ownerMx: string,
  after: number,
) {
  return (
    a.status === "active" &&
    a.room_id === roomId &&
    event.type === "m.room.message" &&
    event.sender === ownerMx &&
    event.content?.msgtype === "m.text" &&
    typeof event.content.body === "string" &&
    event.content.body.trim().length > 0 &&
    event.content.body.length <= 12000 &&
    typeof event.event_id === "string" &&
    Number.isFinite(event.origin_server_ts) &&
    event.origin_server_ts >= after &&
    !event.content["m.relates_to"]?.rel_type
  );
}
async function exactMembership(client: MatrixClient, a: AgentRow) {
  // Include invited members: key sharing to an unapproved invite must also stop execution.
  const members = (await client.getRoomMembers(a.room_id)).filter((m) =>
    ["join", "invite", "knock"].includes(m.membership),
  );
  return (
    members.length === 2 &&
    members.every((m) =>
      [a.matrix_id, localMatrixId(a.owner_id)].includes(m.membershipFor),
    ) &&
    members.every((m) => m.membership === "join")
  );
}
export async function publishAgentReply(
  a: AgentRow,
  live: Running,
  content: Record<string, unknown>,
  controller?: AbortController,
) {
  if (!(await exactMembership(live.client, a).catch(() => false))) return false;
  // Read AFTER the asynchronous membership check; pause/revocation can happen during it.
  const latest = db
    .prepare("SELECT * FROM chat_agents WHERE id=?")
    .get(a.id) as AgentRow;
  if (
    controller?.signal.aborted ||
    latest.status !== "active" ||
    latest.generation !== a.generation ||
    !ownerCanRun(latest)
  )
    return false;
  const submission = live.client.sendMessage(a.room_id, content);
  live.deliveries.add(submission);
  try {
    await submission;
    return true;
  } finally {
    live.deliveries.delete(submission);
  }
}
async function onMessage(
  agentId: string,
  live: Running,
  roomId: string,
  event: any,
) {
  const a = db
    .prepare("SELECT * FROM chat_agents WHERE id=?")
    .get(agentId) as AgentRow;
  if (
    !eligibleAgentMessage(
      a,
      roomId,
      event,
      localMatrixId(a.owner_id),
      live.after,
    ) ||
    !ownerCanRun(a)
  )
    return;
  if (
    !db
      .prepare(
        "INSERT OR IGNORE INTO chat_agent_events VALUES(?,?,'claimed',?)",
      )
      .run(agentId, event.event_id, now()).changes
  )
    return;
  if (live.busy) {
    await publishAgentReply(a, live, {
      msgtype: "m.notice",
      body: "上一条消息仍在处理，本条没有执行；请在回复后重新发送。",
    });
    db.prepare(
      "UPDATE chat_agent_events SET status='busy' WHERE agent_id=? AND event_id=?",
    ).run(agentId, event.event_id);
    return;
  }
  live.busy = true;
  const controller = new AbortController();
  live.abort = controller;
  let status = "stopped";
  try {
    if (!(await exactMembership(live.client, a))) {
      live.history = [];
      return;
    }
    const beforeCall = db
      .prepare("SELECT * FROM chat_agents WHERE id=?")
      .get(agentId) as AgentRow;
    if (
      controller.signal.aborted ||
      beforeCall.status !== "active" ||
      beforeCall.generation !== a.generation ||
      !ownerCanRun(beforeCall)
    )
      return;
    if (!reserveChatCall(agentId)) {
      await publishAgentReply(
        a,
        live,
        { msgtype: "m.notice", body: "今日已达到此 Agent 的 20 次回复限额。" },
        controller,
      );
      return;
    }
    const result = await generateText({
      model: modelFor(a.workspace_id, {
        id: a.id,
        name: a.name,
        model: a.model,
        provider: a.provider,
        persona: a.persona,
        color: "sage",
        enabled: true,
        tools: false,
      }),
      system: `你是 ${a.name}，属于当前对话的主人。你没有电脑、文件、命令或其他工具权限，不得声称已执行这些操作。只回应本次主人消息。\n${a.persona}`,
      messages: [
        ...live.history,
        { role: "user", content: event.content.body },
      ],
      maxOutputTokens: 1600,
      maxRetries: 0,
      abortSignal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(90000),
      ]),
    });
    const text = result.text.trim();
    if (!text) throw new Error("empty_reply");
    if (
      !(await publishAgentReply(
        a,
        live,
        {
          msgtype: "m.text",
          body: text.slice(0, 20000),
          "org.agentfamily.reply_to": event.event_id,
        },
        controller,
      ))
    ) {
      live.history = [];
      return;
    }
    live.history = [
      ...live.history,
      { role: "user" as const, content: event.content.body },
      { role: "assistant" as const, content: text },
    ].slice(-12);
    status = "sent";
  } catch {
    status = "failed";
    await publishAgentReply(
      a,
      live,
      {
        msgtype: "m.notice",
        body: "本次回复没有完成，请稍后重试。不会自动重复调用或执行工具。",
      },
      controller,
    ).catch(() => undefined);
  } finally {
    db.prepare(
      "UPDATE chat_agent_events SET status=? WHERE agent_id=? AND event_id=?",
    ).run(status, agentId, event.event_id);
    live.busy = false;
    live.abort = undefined;
  }
}
async function startAgent(agentId: string): Promise<Running> {
  if (running.has(agentId)) return running.get(agentId)!;
  if (starting.has(agentId)) return starting.get(agentId)!;
  const task = (async () => {
    const a = db
      .prepare("SELECT * FROM chat_agents WHERE id=?")
      .get(agentId) as AgentRow;
    if (!a?.token) throw socialError(409, "Agent 尚未接入聊天服务。");
    const sdk = await import("@vector-im/matrix-bot-sdk");
    // Do not let SDK diagnostics print decrypted messages, tokens or URLs with credentials.
    sdk.LogService.setLogger({
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
    });
    const dir = path.join(dataDir, "matrix-agents", agentId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const storage = new sdk.SimpleFsStorageProvider(
      path.join(dir, "sync.json"),
    );
    // Upstream StoreType.Sqlite is a TypeScript const enum (0), not a JS export.
    // Runtime ESM loading must not read sdk.RustSdkCryptoStoreType, which is absent.
    const cryptoStore = new sdk.RustSdkCryptoStorageProvider(
      path.join(dir, "crypto"),
      0,
    );
    const client = new sdk.MatrixClient(
      matrixOptions()!.homeserver,
      decrypt(a.token),
      storage,
      cryptoStore,
    );
    const live: Running = {
      client,
      deliveries: new Set(),
      busy: false,
      after: Date.now(),
      history: [],
    };
    client.on("room.decrypted_event", (roomId, event) => {
      void onMessage(agentId, live, roomId, event).catch(() => undefined);
    });
    await client.start();
    running.set(agentId, live);
    return live;
  })();
  starting.set(agentId, task);
  try {
    return await task;
  } finally {
    starting.delete(agentId);
  }
}
export async function startChatAgents() {
  if (process.env.AF_UNIFIED_LOGIN !== "true" || config.testMode) return;
  for (const a of db
    .prepare(
      "SELECT id FROM chat_agents WHERE token!='' AND status IN ('active','paused')",
    )
    .all() as { id: string }[])
    await startAgent(a.id).catch(() => undefined);
}
export function stopChatAgents() {
  for (const live of running.values()) {
    live.abort?.abort();
    live.client.stop();
  }
  running.clear();
}
