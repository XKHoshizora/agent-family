// HTTP surface for the family layer. Mounted by app.ts (Codex) via
//   await registerFamilyRoutes(app, { context, cancelRun })
// Actor identity always comes from deps.context(req); bodies never carry actor ids.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  FAMILY_CAPABILITIES,
  familyAgentCreateSchema,
  familyAgentUpdateSchema,
  familyBlockSchema,
  familyExpandSchema,
  familyFriendRequestSchema,
  familyGroupCreateSchema,
  familyPauseSchema,
  familyRevisionSchema,
  type FamilyErrorCode,
} from "../shared/family";
import {
  FamilyError,
  approveGroup,
  archiveGroup,
  createAgent,
  createBlock,
  createGroup,
  expandGroup,
  friendshipAction,
  getGroup,
  listAgents,
  listBlocks,
  listFriendships,
  listGroups,
  pauseGroup,
  rejectGroup,
  removeBlock,
  requestFriendship,
  resumeGroup,
  setFamilyCancelHook,
  updateAgent,
  type FamilyActor,
} from "./family-store";

export type FamilyRouteDeps = {
  context: (req: FastifyRequest) => Promise<{
    user: { id: string; name: string };
    workspaceId: string;
    role: string;
  }>;
  /** Called (after commit) with the AF room id whose active run must stop. */
  cancelRun?: (roomId: string) => void;
};

const params = z.object({ id: z.string().uuid() }).strict();
const friendAction = z.enum(["accept", "reject", "cancel", "remove"]);
const codeFor = (status: number): FamilyErrorCode =>
  status === 401
    ? "unauthenticated"
    : status === 403
      ? "forbidden"
      : status === 404
        ? "not_found"
        : status === 409
          ? "conflict"
          : "invalid_input";

export function registerFamilyRoutes(
  app: FastifyInstance,
  deps: FamilyRouteDeps,
) {
  setFamilyCancelHook(deps.cancelRun);
  return app.register(async (family) => {
    // Encapsulated: stable `{ error, code }` without touching the global handler.
    family.setErrorHandler((error: any, _req, reply) => {
      if (error instanceof z.ZodError)
        return reply.code(400).send({
          error: error.issues[0]?.message || "输入内容不符合要求。",
          code: "invalid_input",
        });
      if (error instanceof FamilyError)
        return reply
          .code(error.statusCode)
          .send({ error: error.message, code: error.code });
      const status =
        typeof error.statusCode === "number" &&
        error.statusCode >= 400 &&
        error.statusCode < 500
          ? error.statusCode
          : 500;
      if (status >= 500)
        return reply
          .code(500)
          .send({
            error: "服务暂时没有完成请求，请稍后重试。",
            code: "conflict",
          });
      return reply
        .code(status)
        .send({
          error: error.message || "操作未完成。",
          code: codeFor(status),
        });
    });
    const actor = async (req: FastifyRequest): Promise<FamilyActor> => {
      const ctx = await deps.context(req);
      return {
        userId: ctx.user.id,
        userName: ctx.user.name || "",
        workspaceId: ctx.workspaceId,
        role: ctx.role,
      };
    };
    const idOf = (req: FastifyRequest) => params.parse(req.params).id;
    const bodyOf = (req: FastifyRequest) => req.body ?? {};
    const small = { bodyLimit: 16 * 1024 };

    family.get("/api/family/capabilities", async () => ({
      capabilities: FAMILY_CAPABILITIES,
    }));

    family.get("/api/family/agents", async (req) => ({
      agents: listAgents(await actor(req)),
    }));
    family.post("/api/family/agents", small, async (req) => {
      const a = await actor(req);
      return {
        agents: [createAgent(a, familyAgentCreateSchema.parse(bodyOf(req)))],
      };
    });
    family.patch("/api/family/agents/:id", small, async (req) => {
      const a = await actor(req);
      return {
        agents: [
          updateAgent(a, idOf(req), familyAgentUpdateSchema.parse(bodyOf(req))),
        ],
      };
    });

    family.get("/api/family/friendships", async (req) => ({
      friendships: listFriendships(await actor(req)),
    }));
    family.post("/api/family/friendships", small, async (req) => {
      const a = await actor(req);
      const body = familyFriendRequestSchema.parse(bodyOf(req));
      return {
        friendships: [requestFriendship(a, body.fromAgentId, body.toAgentId)],
      };
    });
    family.post("/api/family/friendships/:id/:action", small, async (req) => {
      const a = await actor(req);
      const p = z
        .object({ id: z.string().uuid(), action: friendAction })
        .strict()
        .parse(req.params);
      return { friendships: [friendshipAction(a, p.id, p.action)] };
    });

    family.get("/api/family/groups", async (req) => ({
      groups: listGroups(await actor(req)),
    }));
    family.post("/api/family/groups", small, async (req) => {
      const a = await actor(req);
      return {
        groups: [createGroup(a, familyGroupCreateSchema.parse(bodyOf(req)))],
      };
    });
    family.get("/api/family/groups/:id", async (req) => {
      const a = await actor(req);
      return { groups: [getGroup(a, idOf(req))] };
    });
    family.post("/api/family/groups/:id/approve", small, async (req) => {
      const a = await actor(req);
      return {
        groups: [
          approveGroup(a, idOf(req), familyRevisionSchema.parse(bodyOf(req))),
        ],
      };
    });
    family.post("/api/family/groups/:id/reject", small, async (req) => {
      const a = await actor(req);
      return {
        groups: [
          rejectGroup(a, idOf(req), familyRevisionSchema.parse(bodyOf(req))),
        ],
      };
    });
    family.post("/api/family/groups/:id/pause", small, async (req) => {
      const a = await actor(req);
      return {
        groups: [
          pauseGroup(a, idOf(req), familyPauseSchema.parse(bodyOf(req)).reason),
        ],
      };
    });
    family.post("/api/family/groups/:id/resume", small, async (req) => {
      const a = await actor(req);
      return {
        groups: [
          resumeGroup(a, idOf(req), familyRevisionSchema.parse(bodyOf(req))),
        ],
      };
    });
    family.post("/api/family/groups/:id/expand", small, async (req) => {
      const a = await actor(req);
      return {
        groups: [
          expandGroup(a, idOf(req), familyExpandSchema.parse(bodyOf(req))),
        ],
      };
    });
    family.post("/api/family/groups/:id/archive", small, async (req) => {
      const a = await actor(req);
      return { groups: [archiveGroup(a, idOf(req))] };
    });

    family.get("/api/family/blocks", async (req) => ({
      blocks: listBlocks(await actor(req)),
    }));
    family.post("/api/family/blocks", small, async (req) => {
      const a = await actor(req);
      return { blocks: [createBlock(a, familyBlockSchema.parse(bodyOf(req)))] };
    });
    family.delete("/api/family/blocks/:id", async (req) => {
      const a = await actor(req);
      removeBlock(a, idOf(req));
      return { blocks: [] };
    });
  });
}

export {
  familyRoomAccess,
  assertFamilyRunAllowed,
  familyRoomPolicy,
  setFamilyCancelHook,
  FamilyError,
} from "./family-store";
