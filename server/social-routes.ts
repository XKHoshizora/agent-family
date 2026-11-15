import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "./db";
import { listModels } from "./providers";
import {
  blockPerson,
  findPerson,
  friendAction,
  listFriends,
  localMatrixId,
  person,
  requestFriend,
  socialError,
} from "./social-store";
import {
  createChatAgent,
  updateChatAgent,
  openAgentRoom,
  publicChatAgent,
} from "./chat-agents";
type Context = {
  user: { id: string; name: string };
  workspaceId: string;
  role: string;
};
export function registerSocialRoutes(
  app: FastifyInstance,
  context: (req: FastifyRequest) => Promise<Context>,
) {
  const actor = async (req: FastifyRequest) => {
    const c = await context(req);
    const claimed = req.headers["x-af-matrix-id"];
    if (claimed !== localMatrixId(c.user.id))
      throw socialError(
        409,
        "当前聊天身份与账号不一致，请退出后使用 Agent Family 统一登录。",
      );
    return c;
  };
  app.get("/api/social/me", async (req) => {
    const c = await actor(req);
    return {
      person: person(c.user.id),
      models: listModels(c.workspaceId),
      canManage: c.role !== "viewer",
    };
  });
  app.get("/api/social/people", async (req) => {
    const c = await actor(req);
    const { matrixId } = z
      .object({ matrixId: z.string().min(4).max(255) })
      .parse(req.query);
    const found = findPerson(matrixId);
    return { person: found?.id === c.user.id ? null : found };
  });
  app.get("/api/social/friends", async (req) =>
    listFriends((await actor(req)).user.id),
  );
  app.post("/api/social/friends", async (req) => {
    const c = await actor(req);
    const data = z
      .object({
        targetId: z.string().min(1).max(100),
        note: z.string().trim().max(200).default(""),
      })
      .parse(req.body);
    return requestFriend(c.user.id, data.targetId, data.note);
  });
  app.post("/api/social/friends/:id/:action", async (req) => {
    const c = await actor(req);
    const p = z
      .object({
        id: z.string().uuid(),
        action: z.enum(["accept", "reject", "cancel", "remove"]),
      })
      .parse(req.params);
    return friendAction(c.user.id, p.id, p.action);
  });
  app.post("/api/social/blocks", async (req) => {
    const c = await actor(req);
    const p = z
      .object({ targetId: z.string().max(100), enabled: z.boolean() })
      .parse(req.body);
    return blockPerson(c.user.id, p.targetId, p.enabled);
  });
  app.get("/api/social/agents", async (req) => {
    const c = await actor(req);
    return {
      agents: (
        db
          .prepare(
            "SELECT * FROM chat_agents WHERE owner_id=? ORDER BY created_at",
          )
          .all(c.user.id) as any[]
      ).map(publicChatAgent),
    };
  });
  const agentSchema = z.object({
    name: z.string().trim().min(1).max(40),
    persona: z.string().trim().max(4000),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
  });
  app.post("/api/social/agents", async (req) => {
    const c = await actor(req);
    if (c.role === "viewer") throw socialError(403, "当前账号只有查看权限。");
    return { agent: await createChatAgent(c, agentSchema.parse(req.body)) };
  });
  app.patch("/api/social/agents/:id", async (req) => {
    const c = await actor(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return {
      agent: await updateChatAgent(
        c,
        id,
        agentSchema
          .partial()
          .extend({ paused: z.boolean().optional() })
          .parse(req.body),
      ),
    };
  });
  app.post("/api/social/agents/:id/chat", async (req) => {
    const c = await actor(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { roomId: await openAgentRoom(c.user.id, id) };
  });
}
