import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
const state = vi.hoisted(() => {
  process.env.DATA_DIR = `${process.env.TEMP || "/tmp"}/agent-family-family-tests-${process.pid}-${Date.now()}`;
  process.env.CANAL_KEY_FILE = `${process.env.DATA_DIR}/no-key.txt`;
  process.env.CANAL_API_KEY = "";
  process.env.APP_URL = "http://localhost:4317";
  process.env.TEST_MODE = "true";
  return { cancelled: [] as string[] };
});
import Fastify, { type FastifyInstance } from "fastify";
import { db, addMessage, getMessages, getRoom } from "../server/db";
import { saveProvider } from "../server/providers";
import {
  registerFamilyRoutes,
  familyRoomAccess,
  assertFamilyRunAllowed,
  familyRoomPolicy,
} from "../server/family-routes";
import { pauseGroup, archiveGroup } from "../server/family-store";
import { FAMILY_LIMITS } from "../shared/family";

const WS = "ws-family";
const USERS: Record<string, { id: string; name: string; role?: string }> = {
  alice: { id: "u-alice", name: "Alice", role: "member" },
  bob: { id: "u-bob", name: "Bob", role: "member" },
  carol: { id: "u-carol", name: "Carol", role: "admin" },
  dave: { id: "u-dave", name: "Dave", role: "member" },
  frank: { id: "u-frank", name: "Frank", role: "member" }, // cap tests
  gina: { id: "u-gina", name: "Gina", role: "member" }, // demotion tests
  hana: { id: "u-hana", name: "Hana", role: "member" }, // provider/viewer/cap tests
  ivan: { id: "u-ivan", name: "Ivan", role: "member" }, // provider tests
  eve: { id: "u-eve", name: "Eve" }, // never a member
};
const emailOf = (key: string) => `${key}@family.test`;
const CANAL_URL = "https://api.canalapi.com/v1";
const OTHER_URL = "https://api.openai.com/v1";
const MODELS = ["fam-1", "fam-2", "fam-3"];
const TAG = /^[2-9A-HJ-NP-Z]{4}$/;
/** Provider fixtures go through the production saveProvider (endpoint allowlist, encryption). */
function provider(
  id: string,
  over: Partial<{ kind: "compatible" | "openai"; baseUrl: string }> = {},
) {
  saveProvider(WS, {
    id,
    kind: "compatible",
    baseUrl: CANAL_URL,
    apiKey: "not-a-real-secret",
    models: MODELS,
    ...over,
  });
}
const setRole = (user: string, role: string) =>
  db
    .prepare("UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?")
    .run(role, WS, USERS[user].id);
const setName = (user: string, name: string) => {
  USERS[user].name = name; // what the session would now report
  db.prepare("UPDATE user SET name=? WHERE id=?").run(name, USERS[user].id);
};

let app: FastifyInstance;
async function call(user: string, method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as any,
    url,
    headers: { "x-user": user },
    ...(body !== undefined
      ? { payload: body as any }
      : method === "GET" || method === "DELETE"
        ? {}
        : { payload: {} }),
  });
  return { status: res.statusCode, json: res.json() as any, raw: res.body };
}
const ok = async (p: Promise<{ status: number; json: any; raw: string }>) => {
  const r = await p;
  if (r.status !== 200)
    throw new Error(`expected 200, got ${r.status}: ${r.raw}`);
  return r.json;
};
async function agent(
  user: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const r = await ok(
    call(user, "POST", "/api/family/agents", {
      name,
      model: "fam-1",
      provider: "canal",
      persona: `SECRET-PERSONA-${name}`,
      ...extra,
    }),
  );
  return r.agents[0].id as string;
}
async function befriend(
  fromUser: string,
  from: string,
  toUser: string,
  to: string,
) {
  const f = (
    await ok(
      call(fromUser, "POST", "/api/family/friendships", {
        fromAgentId: from,
        toAgentId: to,
      }),
    )
  ).friendships[0];
  await ok(call(toUser, "POST", `/api/family/friendships/${f.id}/accept`));
  return f.id as string;
}
const group = async (user: string, id: string) =>
  (await ok(call(user, "GET", `/api/family/groups/${id}`))).groups[0];
async function propose(user: string, agentIds: string[], name: string) {
  return (
    await ok(call(user, "POST", "/api/family/groups", { name, agentIds }))
  ).groups[0];
}
async function approveAll(id: string, users: string[], action = "approve") {
  let g: any;
  for (const u of users) {
    const cur = await group(u, id);
    g = (
      await ok(
        call(u, "POST", `/api/family/groups/${id}/${action}`, {
          revision: cur.revision,
          snapshotHash: cur.snapshotHash,
        }),
      )
    ).groups[0];
  }
  return g;
}
const myTag = async (user: string) =>
  (await ok(call(user, "GET", "/api/family/agents"))).agents.find(
    (a: any) => a.isMine,
  ).ownerTag as string;
/** Rewrites a stored snapshot to simulate rows written by older code. */
function rewriteSnapshot(groupId: string, fn: (s: any) => any) {
  const row = db
    .prepare("SELECT snapshot FROM family_groups WHERE id=?")
    .get(groupId) as { snapshot: string };
  db.prepare("UPDATE family_groups SET snapshot=? WHERE id=?").run(
    JSON.stringify(JSON.parse(row.snapshot).map(fn)),
    groupId,
  );
}
const stripEndpoint = ({ providerUrl, providerKind, ...rest }: any) => rest;

beforeAll(async () => {
  db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(
    WS,
    "Family",
    new Date().toISOString(),
  );
  // Stand-in for Better Auth's `user` table: the store reads current names from it.
  db.exec(
    "CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL)",
  );
  for (const [key, u] of Object.entries(USERS)) {
    db.prepare("INSERT INTO user VALUES(?,?,?)").run(u.id, u.name, emailOf(key));
    if (u.role)
      db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(WS, u.id, u.role);
  }
  provider("canal");
  provider("drift"); // mutated by the endpoint-drift test only
  app = Fastify();
  await registerFamilyRoutes(app, {
    context: async (req) => {
      const u = USERS[String(req.headers["x-user"])];
      if (!u) throw Object.assign(new Error("请先登录。"), { statusCode: 401 });
      const m = db
        .prepare(
          "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
        )
        .get(WS, u.id) as any;
      if (!m)
        throw Object.assign(new Error("你还没有加入这个工作空间。"), {
          statusCode: 403,
        });
      return {
        user: { id: u.id, name: u.name },
        workspaceId: WS,
        role: m.role,
      };
    },
    cancelRun: (roomId) => state.cancelled.push(roomId),
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
});

describe("family layer", () => {
  it("publishes honest capabilities without auth", async () => {
    const r = await call("nobody", "GET", "/api/family/capabilities");
    expect(r.status).toBe(200);
    expect(r.json.capabilities).toMatchObject({
      e2ee: false,
      matrixFederation: false,
      supervision: "central-single-instance",
    });
    expect(r.json.capabilities.crossOwner.tools).toBe(false);
  });

  it("hides private config from non-owners and rejects outsiders", async () => {
    const a = await agent("alice", "Echo");
    const bobView = (
      await ok(call("bob", "GET", "/api/family/agents"))
    ).agents.find((x: any) => x.id === a);
    expect(bobView).toEqual({
      id: a,
      isMine: false,
      ownerName: "Alice",
      ownerTag: expect.stringMatching(TAG),
      ownerNameDuplicate: false,
      name: "Echo",
      color: "sage",
    });
    const raw = (await call("bob", "GET", "/api/family/agents")).raw;
    expect(raw).not.toContain("SECRET-PERSONA-Echo");
    expect(raw).not.toContain("u-alice");
    expect(raw).not.toContain(emailOf("alice"));
    expect((await call("eve", "GET", "/api/family/agents")).json.code).toBe(
      "forbidden",
    );
    expect((await call("nobody", "GET", "/api/family/groups")).status).toBe(
      401,
    );
    // Body cannot smuggle actor/owner ids.
    expect(
      (
        await call("bob", "POST", "/api/family/agents", {
          name: "X",
          ownerUserId: "u-alice",
        })
      ).status,
    ).toBe(400);
  });

  it("does not let a workspace admin impersonate an owner", async () => {
    const a = await agent("alice", "Alpha");
    const b = await agent("bob", "Bravo");
    const patch = await call("carol", "PATCH", `/api/family/agents/${a}`, {
      enabled: false,
    });
    expect(patch.status).toBe(403);
    const f = (
      await ok(
        call("alice", "POST", "/api/family/friendships", {
          fromAgentId: a,
          toAgentId: b,
        }),
      )
    ).friendships[0];
    expect(
      (await call("alice", "POST", `/api/family/friendships/${f.id}/accept`))
        .status,
    ).toBe(403);
    expect(
      (await call("carol", "POST", `/api/family/friendships/${f.id}/accept`))
        .status,
    ).toBe(404);
    expect(
      (
        await call("carol", "POST", "/api/family/friendships", {
          fromAgentId: a,
          toAgentId: b,
        })
      ).status,
    ).toBe(403);
    await ok(call("bob", "POST", `/api/family/friendships/${f.id}/accept`));
    const g = (
      await ok(
        call("alice", "POST", "/api/family/groups", {
          kind: "dm",
          name: "AB",
          agentIds: [a, b],
        }),
      )
    ).groups[0];
    expect(
      (await call("carol", "GET", `/api/family/groups/${g.id}`)).status,
    ).toBe(404);
    expect(
      (
        await call("carol", "POST", `/api/family/groups/${g.id}/approve`, {
          revision: g.revision,
        })
      ).status,
    ).toBe(404);
  });

  it("same owner approves once; room is bound with frozen safe config", async () => {
    const a1 = await agent("alice", "Solo1");
    const a2 = await agent("alice", "Solo2");
    await befriend("alice", a1, "alice", a2);
    const g = (
      await ok(
        call("alice", "POST", "/api/family/groups", {
          kind: "dm",
          name: "Self",
          agentIds: [a1, a2],
        }),
      )
    ).groups[0];
    expect(g.owners).toHaveLength(1);
    expect(g.roomId).toBeNull();
    const done = await approveAll(g.id, ["alice"]);
    expect(done.status).toBe("active");
    const room = getRoom(done.roomId)!;
    expect(room.visibility).toBe("private");
    expect(room.projectMode).toBe("off");
    expect(room.agents.map((x) => x.id)).toEqual([a1, a2]);
    expect(room.agents.every((x) => x.tools === false)).toBe(true);
    expect(familyRoomAccess(done.roomId, "u-alice")).toBe(true);
    expect(familyRoomAccess(done.roomId, "u-bob")).toBe(false);
    expect(() => assertFamilyRunAllowed(done.roomId)).not.toThrow();
  });

  it("cross-owner approval is unanimous, revision bound, and stale approvals fail", async () => {
    const a = await agent("alice", "Ann");
    const b = await agent("bob", "Ben");
    await befriend("alice", a, "bob", b);
    const g = (
      await ok(
        call("alice", "POST", "/api/family/groups", {
          name: "Pair",
          agentIds: [a, b],
        }),
      )
    ).groups[0];
    const bobTag = await myTag("bob");
    // Disclosure: exact model, provider id, endpoint and protocol, owner name + tag.
    expect(g.members.find((m: any) => m.agentId === b)).toMatchObject({
      model: "fam-1",
      provider: "canal",
      providerUrl: CANAL_URL,
      providerKind: "compatible",
      ownerName: "Bob",
      ownerTag: bobTag,
      isMine: false,
    });
    expect(g.owners.find((o: any) => !o.isMe)).toMatchObject({
      name: "Bob",
      tag: bobTag,
      nameDuplicate: false,
    });
    expect(JSON.stringify(g)).not.toContain("SECRET-PERSONA-Ben");
    expect(JSON.stringify(g)).not.toContain("u-bob");
    await ok(
      call("alice", "POST", `/api/family/groups/${g.id}/approve`, {
        revision: 1,
      }),
    );
    // Bob changes his agent's model: new disclosure, alice's approval invalid.
    await ok(
      call("bob", "PATCH", `/api/family/agents/${b}`, { model: "fam-2" }),
    );
    const stale = await call(
      "bob",
      "POST",
      `/api/family/groups/${g.id}/approve`,
      { revision: 1 },
    );
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("stale_revision");
    const cur = await group("bob", g.id);
    expect(cur.revision).toBe(2);
    expect(cur.owners.every((o: any) => !o.approvedCurrentRevision)).toBe(true);
    await ok(
      call("bob", "POST", `/api/family/groups/${g.id}/approve`, {
        revision: 2,
      }),
    );
    expect((await group("bob", g.id)).status).toBe("proposed");
    const active = await approveAll(g.id, ["alice"]);
    expect(active.status).toBe("active");
    expect(getRoom(active.roomId)!.agents.find((x) => x.id === b)!.model).toBe(
      "fam-2",
    );
    expect(familyRoomAccess(active.roomId, "u-bob")).toBe(true);
    expect(familyRoomAccess(active.roomId, "u-carol")).toBe(false);
    expect(() => assertFamilyRunAllowed(active.roomId, "u-carol")).toThrow();
    // Approval replay is idempotent.
    expect(
      (
        await call("alice", "POST", `/api/family/groups/${g.id}/approve`, {
          revision: active.revision - 1,
        })
      ).status,
    ).toBe(200);
    // Later agent edits never mutate the frozen room.
    await ok(
      call("bob", "PATCH", `/api/family/agents/${b}`, { model: "fam-3" }),
    );
    expect(getRoom(active.roomId)!.agents.find((x) => x.id === b)!.model).toBe(
      "fam-2",
    );
    const policy = familyRoomPolicy(active.roomId, "u-alice")!;
    expect(policy).toMatchObject({
      canRun: true,
      tools: false,
      projectMode: "off",
    });
    expect(policy.redactPersonaAgentIds).toEqual([b]);
  });

  async function activePair(
    nameA: string,
    nameB: string,
    userA = "alice",
    userB = "bob",
  ) {
    const a = await agent(userA, nameA);
    const b = await agent(userB, nameB);
    await befriend(userA, a, userB, b);
    const g = (
      await ok(
        call(userA, "POST", "/api/family/groups", {
          name: `${nameA}${nameB}`,
          agentIds: [a, b],
        }),
      )
    ).groups[0];
    const active = await approveAll(g.id, [userA, userB]);
    expect(active.status).toBe("active");
    return { a, b, g: active };
  }

  it("pause cancels runs and resume needs fresh unanimous approval", async () => {
    const { g } = await activePair("Pa", "Pb");
    state.cancelled.length = 0;
    const paused = (
      await ok(
        call("alice", "POST", `/api/family/groups/${g.id}/pause`, {
          reason: "dinner",
        }),
      )
    ).groups[0];
    expect(paused.status).toBe("paused");
    expect(state.cancelled).toEqual([g.roomId]);
    expect(() => assertFamilyRunAllowed(g.roomId)).toThrow(/不可用/);
    const bobView = await group("bob", g.id);
    expect(bobView.availability).toEqual({
      unavailable: true,
      myReasons: [],
      sharedReasons: [],
    });
    expect(JSON.stringify(bobView)).not.toContain("dinner");
    expect(
      (
        await call("bob", "POST", `/api/family/groups/${g.id}/resume`, {
          revision: paused.revision - 1,
        })
      ).json.code,
    ).toBe("stale_revision");
    await ok(
      call("bob", "POST", `/api/family/groups/${g.id}/resume`, {
        revision: paused.revision,
      }),
    );
    expect((await group("bob", g.id)).status).toBe("paused");
    // A new pause invalidates earlier resume approvals.
    await ok(call("bob", "POST", `/api/family/groups/${g.id}/pause`));
    const again = await group("alice", g.id);
    expect(again.owners.every((o: any) => !o.approvedCurrentRevision)).toBe(
      true,
    );
    const resumed = await approveAll(g.id, ["alice", "bob"], "resume");
    expect(resumed.status).toBe("active");
    expect(() => assertFamilyRunAllowed(g.roomId)).not.toThrow();
  });

  it("block pauses shared rooms, cancels proposals privately, and unblock revives nothing", async () => {
    const { a, b, g } = await activePair("Ka", "Kb");
    const a2 = await agent("alice", "Ka2");
    await befriend("alice", a2, "bob", b);
    const pending = (
      await ok(
        call("alice", "POST", "/api/family/groups", {
          name: "Pending",
          agentIds: [a2, b],
        }),
      )
    ).groups[0];
    const pendingFriend = (
      await ok(
        call("alice", "POST", "/api/family/friendships", {
          fromAgentId: await agent("alice", "Ka3"),
          toAgentId: b,
        }),
      )
    ).friendships[0];
    state.cancelled.length = 0;
    const block = (
      await ok(
        call("bob", "POST", "/api/family/blocks", {
          scope: "owner",
          agentId: a,
          note: "PRIVATE-NOTE",
        }),
      )
    ).blocks[0];
    expect(block).toMatchObject({
      targetName: "Alice",
      targetOwnerTag: await myTag("alice"),
    });
    // Owner-scoped block stops every active room shared by bob and alice.
    expect(state.cancelled).toContain(g.roomId);
    expect((await group("alice", g.id)).status).toBe("paused");
    expect((await group("alice", pending.id)).status).toBe("cancelled");
    const aliceSide = JSON.stringify([
      await group("alice", g.id),
      (await ok(call("alice", "GET", "/api/family/friendships"))).friendships,
      (await ok(call("alice", "GET", "/api/family/blocks"))).blocks,
    ]);
    expect(aliceSide).not.toContain("PRIVATE-NOTE");
    expect(aliceSide).not.toContain("屏蔽");
    expect((await group("alice", g.id)).availability.myReasons).toEqual([]);
    expect((await group("bob", g.id)).availability.myReasons).toEqual([
      "你屏蔽了其中的成员",
    ]);
    const friends = (await ok(call("alice", "GET", "/api/family/friendships")))
      .friendships;
    expect(friends.find((f: any) => f.id === pendingFriend.id).status).toBe(
      "cancelled",
    );
    expect(
      (
        await call("alice", "POST", "/api/family/friendships", {
          fromAgentId: a,
          toAgentId: b,
        })
      ).json.code,
    ).toBe("unavailable");
    const cur = await group("bob", g.id);
    expect(
      (
        await call("bob", "POST", `/api/family/groups/${g.id}/resume`, {
          revision: cur.revision,
        })
      ).json.code,
    ).toBe("unavailable");
    // Unblock: nothing reactivates.
    await ok(call("bob", "DELETE", `/api/family/blocks/${block.id}`));
    expect((await group("alice", g.id)).status).toBe("paused");
    expect((await group("alice", pending.id)).status).toBe("cancelled");
    const after = await group("bob", g.id);
    expect(
      (
        await call("bob", "POST", `/api/family/groups/${g.id}/resume`, {
          revision: after.revision,
        })
      ).json.code,
    ).toBe("unavailable");
    // Cause fixed (fresh friendship), then fresh unanimous approvals.
    await befriend("alice", a, "bob", b);
    expect((await approveAll(g.id, ["bob"], "resume")).status).toBe("paused");
    expect((await approveAll(g.id, ["alice"], "resume")).status).toBe("active");
    expect(
      (
        await call(
          "alice",
          "POST",
          `/api/family/groups/${pending.id}/approve`,
          { revision: (await group("alice", pending.id)).revision },
        )
      ).json.code,
    ).toBe("unavailable");
  });

  it("expansion is a separate proposal with a new empty room", async () => {
    const { a, b, g } = await activePair("Xa", "Xb");
    const d = await agent("dave", "Xd");
    await befriend("dave", d, "alice", a);
    await befriend("dave", d, "bob", b);
    addMessage({
      roomId: g.roomId,
      runId: null,
      role: "user",
      agentId: null,
      author: "Alice",
      model: null,
      content: "old secret history",
      status: "complete",
      source: "web",
    });
    const before = await group("alice", g.id);
    const exp = (
      await ok(
        call("alice", "POST", `/api/family/groups/${g.id}/expand`, {
          addAgentIds: [d],
          name: "Bigger",
          clientRequestId: "expand-0001",
        }),
      )
    ).groups[0];
    expect(exp.id).not.toBe(g.id);
    expect(exp.parentGroupId).toBe(g.id);
    expect(exp.owners).toHaveLength(3);
    // Idempotent replay is scoped to the caller.
    expect(
      (
        await ok(
          call("alice", "POST", `/api/family/groups/${g.id}/expand`, {
            addAgentIds: [d],
            name: "Bigger",
            clientRequestId: "expand-0001",
          }),
        )
      ).groups[0].id,
    ).toBe(exp.id);
    const parentNow = await group("alice", g.id);
    expect(parentNow).toMatchObject({
      status: "active",
      revision: before.revision,
      roomId: g.roomId,
    });
    expect(parentNow.members).toHaveLength(2);
    const active = await approveAll(exp.id, ["alice", "bob"]);
    expect(active.status).toBe("proposed");
    const done = await approveAll(exp.id, ["dave"]);
    expect(done.status).toBe("active");
    expect(done.roomId).not.toBe(g.roomId);
    expect(getMessages(done.roomId)).toEqual([]);
    expect(getMessages(g.roomId)).toHaveLength(1);
    expect(familyRoomAccess(g.roomId, "u-dave")).toBe(false);
    expect(familyRoomAccess(done.roomId, "u-dave")).toBe(true);
  });

  it("disabled agent pauses room; re-enable still needs fresh approvals", async () => {
    const { b, g } = await activePair("Da", "Db");
    await ok(
      call("bob", "PATCH", `/api/family/agents/${b}`, { enabled: false }),
    );
    expect((await group("alice", g.id)).availability).toEqual({
      unavailable: true,
      myReasons: [],
      sharedReasons: [],
    });
    expect((await group("bob", g.id)).availability.myReasons).toEqual([
      "你停用了其中的伙伴",
    ]);
    expect(
      (await ok(call("alice", "GET", "/api/family/agents"))).agents.some(
        (x: any) => x.id === b,
      ),
    ).toBe(false);
    expect(() => assertFamilyRunAllowed(g.roomId)).toThrow();
    await ok(
      call("bob", "PATCH", `/api/family/agents/${b}`, { enabled: true }),
    );
    expect((await group("alice", g.id)).status).toBe("paused");
    expect((await approveAll(g.id, ["alice", "bob"], "resume")).status).toBe(
      "active",
    );
  });

  it("owner membership removal revokes access and pauses until fresh approval", async () => {
    const { g } = await activePair("Ma", "Mb");
    db.prepare(
      "DELETE FROM memberships WHERE workspace_id=? AND user_id=?",
    ).run(WS, "u-bob");
    expect(familyRoomAccess(g.roomId, "u-bob")).toBe(false);
    expect(() => assertFamilyRunAllowed(g.roomId)).toThrow();
    expect(
      (await call("bob", "GET", `/api/family/groups/${g.id}`)).status,
    ).toBe(403);
    expect((await group("alice", g.id)).status).toBe("paused");
    db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
      WS,
      "u-bob",
      "member",
    );
    expect((await group("alice", g.id)).status).toBe("paused");
    expect((await approveAll(g.id, ["alice", "bob"], "resume")).status).toBe(
      "active",
    );
  });

  it("expires proposals after 24h and archive is terminal", async () => {
    const a = await agent("alice", "Ea");
    const b = await agent("bob", "Eb");
    await befriend("alice", a, "bob", b);
    const p = (
      await ok(
        call("alice", "POST", "/api/family/groups", {
          name: "Exp",
          agentIds: [a, b],
        }),
      )
    ).groups[0];
    db.prepare("UPDATE family_groups SET expires_at=? WHERE id=?").run(
      new Date(Date.now() - 1000).toISOString(),
      p.id,
    );
    const r = await call("bob", "POST", `/api/family/groups/${p.id}/approve`, {
      revision: p.revision,
    });
    expect(r.json.code).toBe("expired");
    expect((await group("bob", p.id)).status).toBe("expired");
    const { g } = await activePair("Ra", "Rb");
    const arch = (
      await ok(call("bob", "POST", `/api/family/groups/${g.id}/archive`))
    ).groups[0];
    expect(arch.status).toBe("archived");
    expect(getRoom(g.roomId)!.archived).toBe(true);
    expect(
      (
        await call("alice", "POST", `/api/family/groups/${g.id}/resume`, {
          revision: arch.revision,
        })
      ).json.code,
    ).toBe("unavailable");
    expect(() => assertFamilyRunAllowed(g.roomId)).toThrow();
    expect(familyRoomAccess(g.roomId, "u-alice")).toBe(true); // history stays readable
  });

  it("ordinary rooms are untouched by the helpers", () => {
    expect(familyRoomAccess("not-a-family-room", "u-alice")).toBeNull();
    expect(familyRoomPolicy("not-a-family-room")).toBeNull();
    expect(() => assertFamilyRunAllowed("not-a-family-room")).not.toThrow();
  });

  // ---------- release-review regressions ----------

  it("P1-1: agents need a configured provider + offered model; proposals freeze a real endpoint", async () => {
    // Unknown provider or model is refused at create and update.
    for (const body of [
      { name: "Relay1", model: "fam-1", provider: "relay" },
      { name: "Relay2", model: "not-offered", provider: "canal" },
    ]) {
      const r = await call("hana", "POST", "/api/family/agents", body);
      expect(r.status, r.raw).toBe(400);
      expect(r.json.code).toBe("invalid_input");
    }
    const ready = await agent("hana", "Ready");
    const moved = await call("hana", "PATCH", `/api/family/agents/${ready}`, {
      provider: "relay",
    });
    expect(moved.status).toBe(400);
    // A model-less draft may exist but can never be proposed.
    const draft = await agent("hana", "Draft", { model: "" });
    const ivanReady = await agent("ivan", "IReady");
    const ivanDraft = await agent("ivan", "IDraft", { model: "" });
    await befriend("hana", draft, "ivan", ivanReady);
    await befriend("hana", ready, "ivan", ivanDraft);
    const own = await call("hana", "POST", "/api/family/groups", {
      name: "D1",
      agentIds: [draft, ivanReady],
    });
    expect(own.status).toBe(400);
    expect(own.json.code).toBe("invalid_input");
    // Another owner's unusable Agent: generic, reveals nothing about its config.
    const theirs = await call("hana", "POST", "/api/family/groups", {
      name: "D2",
      agentIds: [ready, ivanDraft],
    });
    expect(theirs.status).toBe(409);
    expect(theirs.json.code).toBe("unavailable");
    expect(theirs.raw).not.toContain("IDraft");
    // A model the provider stops offering is refused at activation.
    await befriend("hana", ready, "ivan", ivanReady);
    const p = await propose("hana", [ready, ivanReady], "D3");
    expect(
      p.members.every(
        (m: any) =>
          m.providerUrl === CANAL_URL && m.providerKind === "compatible",
      ),
    ).toBe(true);
    await approveAll(p.id, ["hana"]);
    // Same endpoint, but the admin's model list no longer offers fam-1.
    saveProvider(WS, {
      id: "canal",
      kind: "compatible",
      baseUrl: CANAL_URL,
      models: ["fam-2", "fam-3"], // fam-1 withdrawn
    });
    try {
      const last = await call(
        "ivan",
        "POST",
        `/api/family/groups/${p.id}/approve`,
        { revision: (await group("ivan", p.id)).revision },
      );
      expect(last.json.code).toBe("unavailable");
      expect((await group("ivan", p.id)).status).toBe("proposed");
    } finally {
      provider("canal");
    }
    expect((await approveAll(p.id, ["ivan"])).status).toBe("active");
  });

  it("P1-1: an endpoint or protocol change after approval stops the room until exactly that endpoint is restored and re-approved", async () => {
    const a = await agent("hana", "Dr1", { provider: "drift" });
    const b = await agent("ivan", "Dr2", { provider: "drift" });
    await befriend("hana", a, "ivan", b);
    const g = await approveAll(
      (await propose("hana", [a, b], "Drift")).id,
      ["hana", "ivan"],
    );
    expect(() => assertFamilyRunAllowed(g.roomId)).not.toThrow();
    const resume = async (who: string) =>
      (
        await call(who, "POST", `/api/family/groups/${g.id}/resume`, {
          revision: (await group(who, g.id)).revision,
        })
      ).json.code;
    try {
      // URL drift (simulates an admin path that bypassed the app guard).
      state.cancelled.length = 0;
      provider("drift", { baseUrl: OTHER_URL });
      expect(() => assertFamilyRunAllowed(g.roomId)).toThrow(/不可用/);
      expect(state.cancelled).toContain(g.roomId);
      const paused = await group("ivan", g.id);
      expect(paused.status).toBe("paused");
      expect(paused.availability.sharedReasons).toHaveLength(1);
      expect(paused.availability.myReasons).toEqual([]);
      // The approved disclosure is never rewritten to the new endpoint.
      expect(paused.members.every((m: any) => m.providerUrl === CANAL_URL)).toBe(
        true,
      );
      expect(await resume("hana")).toBe("unavailable");
      // Same URL, different protocol: still refused.
      provider("drift", { kind: "openai" });
      expect(await resume("hana")).toBe("unavailable");
      // Deleted provider: no short-circuit on a missing row.
      db.prepare("DELETE FROM providers WHERE workspace_id=? AND id=?").run(
        WS,
        "drift",
      );
      expect(() => assertFamilyRunAllowed(g.roomId)).toThrow();
      expect(await resume("ivan")).toBe("unavailable");
    } finally {
      provider("drift");
    }
    // Exactly the approved endpoint again: fresh unanimous approval.
    expect((await approveAll(g.id, ["hana"], "resume")).status).toBe("paused");
    expect((await approveAll(g.id, ["ivan"], "resume")).status).toBe("active");
    expect(() => assertFamilyRunAllowed(g.roomId)).not.toThrow();
    // A room whose agents no longer match the snapshot never runs.
    const room = getRoom(g.roomId)!;
    db.prepare("UPDATE rooms SET agents=? WHERE id=?").run(
      JSON.stringify(room.agents.map((x) => ({ ...x, provider: "canal" }))),
      g.roomId,
    );
    expect(() => assertFamilyRunAllowed(g.roomId)).toThrow(/不可用/);
    db.prepare("UPDATE rooms SET agents=? WHERE id=?").run(
      JSON.stringify(room.agents),
      g.roomId,
    );
    // An endpoint change before the last approval cancels the proposal.
    const q = await propose("hana", [a, b], "Drift2");
    await approveAll(q.id, ["hana"]);
    try {
      provider("drift", { baseUrl: OTHER_URL });
      const last = await call(
        "ivan",
        "POST",
        `/api/family/groups/${q.id}/approve`,
        { revision: q.revision },
      );
      expect(last.json.code).toBe("unavailable");
      expect((await group("hana", q.id)).status).toBe("cancelled");
      expect((await group("hana", q.id)).roomId).toBeNull();
    } finally {
      provider("drift");
    }
  });

  it("P1-1 migration: legacy snapshots without a frozen endpoint never run; they move to re-approval or stay unavailable", async () => {
    // (a) Active legacy group whose provider exists: paused, endpoint disclosed, fresh approvals.
    const { b, g } = await activePair("Lg1", "Lg2", "hana", "ivan");
    rewriteSnapshot(g.id, stripEndpoint);
    state.cancelled.length = 0;
    expect(() => assertFamilyRunAllowed(g.roomId)).toThrow(/不可用/);
    expect(state.cancelled).toContain(g.roomId);
    const re = await group("hana", g.id);
    expect(re.status).toBe("paused");
    expect(re.revision).toBeGreaterThan(g.revision);
    expect(re.availability.sharedReasons).toHaveLength(1);
    expect(
      re.members.every(
        (m: any) =>
          m.providerUrl === CANAL_URL && m.providerKind === "compatible",
      ),
    ).toBe(true);
    expect((await approveAll(g.id, ["hana"], "resume")).status).toBe("paused");
    expect((await approveAll(g.id, ["ivan"], "resume")).status).toBe("active");
    expect(() => assertFamilyRunAllowed(g.roomId)).not.toThrow();
    // (b) Legacy proposal: re-disclosed at a new revision, earlier approvals void.
    const a3 = await agent("hana", "Lg3");
    await befriend("hana", a3, "ivan", b);
    const p = await propose("hana", [a3, b], "LegacyP");
    await approveAll(p.id, ["hana"]);
    rewriteSnapshot(p.id, stripEndpoint);
    const p2 = await group("ivan", p.id);
    expect(p2.status).toBe("proposed");
    expect(p2.revision).toBe(p.revision + 1);
    expect(p2.owners.every((o: any) => !o.approvedCurrentRevision)).toBe(true);
    expect(p2.members.every((m: any) => m.providerUrl === CANAL_URL)).toBe(
      true,
    );
    // (c) Legacy entry on a provider that never existed: unavailable, never filled.
    const { g: g3 } = await activePair("Lg4", "Lg5", "hana", "ivan");
    const ghost = (s: any) => ({ ...stripEndpoint(s), provider: "ghost" });
    rewriteSnapshot(g3.id, ghost);
    const room = getRoom(g3.roomId)!;
    db.prepare("UPDATE rooms SET agents=? WHERE id=?").run(
      JSON.stringify(room.agents.map((x) => ({ ...x, provider: "ghost" }))),
      g3.roomId,
    );
    expect(() => assertFamilyRunAllowed(g3.roomId)).toThrow(/不可用/);
    const v3 = await group("hana", g3.id);
    expect(v3.status).toBe("paused");
    expect(v3.members.every((m: any) => m.providerUrl === undefined)).toBe(
      true,
    );
    expect(
      (
        await call("hana", "POST", `/api/family/groups/${g3.id}/resume`, {
          revision: v3.revision,
        })
      ).json.code,
    ).toBe("unavailable");
  });

  it("P1-2: an owner demoted to viewer keeps every stop right, never gains approve/resume/create/run, and demotion pauses shared rooms", async () => {
    const a = await agent("hana", "Vw1");
    const a2 = await agent("hana", "Vw2");
    const g1 = await agent("gina", "Vw3");
    const g2 = await agent("gina", "Vw4");
    await befriend("hana", a, "gina", g1);
    const f2 = await befriend("hana", a2, "gina", g2);
    const room1 = await approveAll(
      (await propose("hana", [a, g1], "Vroom1")).id,
      ["hana", "gina"],
    );
    const room2 = await approveAll(
      (await propose("hana", [a2, g2], "Vroom2")).id,
      ["hana", "gina"],
    );
    const pending = await propose("hana", [a, g1], "Vpending");
    await approveAll(pending.id, ["hana"]);
    const pendingFriend = (
      await ok(
        call("hana", "POST", "/api/family/friendships", {
          fromAgentId: a2,
          toAgentId: g1,
        }),
      )
    ).friendships[0];
    state.cancelled.length = 0;
    setRole("gina", "viewer");
    let block: any;
    try {
      // Demotion stops shared rooms like removal: hana cannot keep running.
      expect(() => assertFamilyRunAllowed(room1.roomId, "u-hana")).toThrow(
        /不可用/,
      );
      expect(state.cancelled).toContain(room1.roomId);
      const hanaView = await group("hana", room1.id);
      expect(hanaView.status).toBe("paused");
      expect(hanaView.availability.myReasons).toEqual([]);
      // Gina still reads; only she sees her own read-only cause.
      const ginaView = await group("gina", room1.id);
      expect(ginaView.availability.myReasons).toHaveLength(1);
      expect(ginaView.can).toMatchObject({
        approve: false,
        resume: false,
        expand: false,
        pause: true,
        archive: true,
      });
      expect(familyRoomAccess(room1.roomId, "u-gina")).toBe(true);
      expect(() => assertFamilyRunAllowed(room1.roomId, "u-gina")).toThrow();
      // Never gains: approve, resume, expand, propose, create, reconfigure,
      // befriend or accept.
      const denied: [string, string, unknown][] = [
        [
          "POST",
          `/api/family/groups/${pending.id}/approve`,
          { revision: pending.revision },
        ],
        [
          "POST",
          `/api/family/groups/${room1.id}/resume`,
          { revision: ginaView.revision },
        ],
        ["POST", `/api/family/groups/${room1.id}/expand`, { addAgentIds: [g2] }],
        ["POST", "/api/family/groups", { name: "X", agentIds: [g1, a] }],
        [
          "POST",
          "/api/family/agents",
          { name: "Vw5", model: "fam-1", provider: "canal" },
        ],
        ["PATCH", `/api/family/agents/${g1}`, { model: "fam-2" }],
        [
          "PATCH",
          `/api/family/agents/${g1}`,
          { enabled: false, persona: "changed" },
        ],
        [
          "POST",
          "/api/family/friendships",
          { fromAgentId: g2, toAgentId: a },
        ],
        ["POST", `/api/family/friendships/${pendingFriend.id}/accept`, {}],
      ];
      for (const [method, url, body] of denied) {
        const r = await call("gina", method, url, body);
        expect(r.status, `${method} ${url} -> ${r.raw}`).toBe(403);
      }
      // Stop rights retained.
      const rej = await call(
        "gina",
        "POST",
        `/api/family/groups/${pending.id}/reject`,
        { revision: (await group("gina", pending.id)).revision },
      );
      expect(rej.status).not.toBe(403);
      expect((await group("hana", pending.id)).status).toMatch(
        /cancelled|rejected/,
      );
      const paused = (
        await ok(call("gina", "POST", `/api/family/groups/${room1.id}/pause`))
      ).groups[0];
      expect(paused.availability.myReasons).toHaveLength(2);
      expect(
        (await ok(call("gina", "POST", `/api/family/groups/${room2.id}/archive`)))
          .groups[0].status,
      ).toBe("archived");
      expect(getRoom(room2.roomId)!.archived).toBe(true);
      expect(
        (
          await ok(
            call("gina", "PATCH", `/api/family/agents/${g2}`, {
              enabled: false,
            }),
          )
        ).agents[0].enabled,
      ).toBe(false);
      expect(
        (
          await call("gina", "PATCH", `/api/family/agents/${g2}`, {
            enabled: true,
          })
        ).status,
      ).toBe(403); // re-enabling is not a stop right
      expect(
        (
          await ok(
            call(
              "gina",
              "POST",
              `/api/family/friendships/${pendingFriend.id}/reject`,
            ),
          )
        ).friendships[0].status,
      ).toBe("rejected");
      expect(
        (await ok(call("gina", "POST", `/api/family/friendships/${f2}/remove`)))
          .friendships[0].status,
      ).toBe("removed");
      block = (
        await ok(
          call("gina", "POST", "/api/family/blocks", {
            scope: "agent",
            agentId: a2,
          }),
        )
      ).blocks[0];
      expect(
        (await call("gina", "DELETE", `/api/family/blocks/${block.id}`)).status,
      ).toBe(403); // unblocking widens exposure
    } finally {
      setRole("gina", "member");
    }
    // Re-promotion revives nothing: fresh unanimous resume.
    expect((await group("hana", room1.id)).status).toBe("paused");
    expect((await approveAll(room1.id, ["hana"], "resume")).status).toBe(
      "paused",
    );
    expect((await approveAll(room1.id, ["gina"], "resume")).status).toBe(
      "active",
    );
    // Removed users keep nothing, not even stop rights or reads.
    db.prepare(
      "DELETE FROM memberships WHERE workspace_id=? AND user_id=?",
    ).run(WS, "u-gina");
    try {
      const gone = {
        userId: "u-gina",
        userName: "Gina",
        workspaceId: WS,
        role: "member",
      };
      expect(() => pauseGroup(gone, room1.id)).toThrow(/加入/);
      expect(() => archiveGroup(gone, room1.id)).toThrow(/加入/);
      expect(familyRoomAccess(room1.roomId, "u-gina")).toBe(false);
      expect(() => assertFamilyRunAllowed(room1.roomId)).toThrow();
    } finally {
      db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
        WS,
        "u-gina",
        "member",
      );
    }
  });

  it("P2-4: active+paused groups per owner are capped and checked inside the activation transaction for every owner", async () => {
    const cap = FAMILY_LIMITS.activeGroupsPerOwner;
    const f1 = await agent("frank", "Cap1");
    const f2 = await agent("frank", "Cap2");
    await befriend("frank", f1, "frank", f2);
    const live: any[] = [];
    for (let i = 0; i < cap - 1; i++)
      live.push(
        await approveAll((await propose("frank", [f1, f2], `C${i}`)).id, [
          "frank",
        ]),
      );
    // Two proposals are allowed while under the cap...
    const p1 = await propose("frank", [f1, f2], "CapA");
    const p2 = await propose("frank", [f1, f2], "CapB");
    expect((await approveAll(p1.id, ["frank"])).status).toBe("active");
    // ...but only one can activate.
    const over = await call(
      "frank",
      "POST",
      `/api/family/groups/${p2.id}/approve`,
      { revision: p2.revision },
    );
    expect(over.status).toBe(409);
    expect(over.json.code).toBe("limit");
    const still = await group("frank", p2.id);
    expect(still.status).toBe("proposed");
    expect(still.owners[0].approvedCurrentRevision).toBe(false); // rolled back
    expect(still.roomId).toBeNull();
    // New proposals are refused up front while at the cap.
    expect(
      (
        await call("frank", "POST", "/api/family/groups", {
          name: "CapC",
          agentIds: [f1, f2],
        })
      ).json.code,
    ).toBe("limit");
    // Paused still counts; archived frees a slot.
    await ok(call("frank", "POST", `/api/family/groups/${live[0].id}/pause`));
    expect(
      (
        await call("frank", "POST", `/api/family/groups/${p2.id}/approve`, {
          revision: still.revision,
        })
      ).json.code,
    ).toBe("limit");
    await ok(call("frank", "POST", `/api/family/groups/${live[0].id}/archive`));
    expect((await approveAll(p2.id, ["frank"])).status).toBe("active");
    // Every owner is checked; another owner's count stays private.
    const x = await agent("hana", "CapX");
    await befriend("hana", x, "frank", f1);
    const cross = await propose("hana", [x, f1], "CapCross");
    await approveAll(cross.id, ["frank"]);
    const last = await call(
      "hana",
      "POST",
      `/api/family/groups/${cross.id}/approve`,
      { revision: (await group("hana", cross.id)).revision },
    );
    expect(last.status).toBe(409);
    expect(last.json.code).toBe("unavailable");
    expect((await group("hana", cross.id)).status).toBe("proposed");
  });

  it("P2-6: names are the account's current name plus a stable member tag; borrowed or stale names cannot impersonate", async () => {
    const real = await agent("alice", "Helper");
    const bobSees = async (id: string) =>
      (await ok(call("bob", "GET", "/api/family/agents"))).agents.find(
        (x: any) => x.id === id,
      );
    // Dave borrows Alice's name, creates an Agent, then renames back.
    setName("dave", "Alice");
    let fake = "";
    let borrowed: any;
    try {
      fake = await agent("dave", "Helper2");
      const realView = await bobSees(real);
      borrowed = await bobSees(fake);
      expect(borrowed.ownerName).toBe("Alice");
      expect(borrowed.ownerTag).toMatch(TAG);
      expect(borrowed.ownerTag).not.toBe(realView.ownerTag);
      expect(realView.ownerNameDuplicate).toBe(true);
      expect(borrowed.ownerNameDuplicate).toBe(true);
      // Width/compatibility variants are the same name.
      setName("dave", "Ａｌｉｃｅ");
      expect((await bobSees(fake)).ownerNameDuplicate).toBe(true);
    } finally {
      setName("dave", "Dave");
    }
    // The stale copy stored at creation is never shown; the tag is stable.
    expect(
      db.prepare("SELECT owner_name FROM family_agents WHERE id=?").get(fake),
    ).toEqual({ owner_name: "Alice" });
    expect(await bobSees(fake)).toMatchObject({
      ownerName: "Dave",
      ownerTag: borrowed.ownerTag,
      ownerNameDuplicate: false,
    });
    expect((await bobSees(real)).ownerNameDuplicate).toBe(false);
    expect(await myTag("dave")).toBe(borrowed.ownerTag);
    // Tags are unique per member and leak no identity.
    const tags = await Promise.all(
      ["alice", "bob", "dave", "frank", "gina"].map(myTag),
    );
    expect(new Set(tags).size).toBe(tags.length);
    const raw = (await call("bob", "GET", "/api/family/agents")).raw;
    for (const secret of [
      "u-alice",
      "u-dave",
      emailOf("alice"),
      emailOf("dave"),
    ])
      expect(raw).not.toContain(secret);
  });

  it("snapshot hash is server-salted: a co-owner cannot confirm a guessed persona offline", async () => {
    const a = await agent("alice", "Hs1", { persona: "" }); // guessable
    const b = await agent("bob", "Hs2", { persona: "" });
    await befriend("alice", a, "bob", b);
    const g = await propose("alice", [a, b], "Hash");
    const row = db
      .prepare("SELECT snapshot,hash_salt FROM family_groups WHERE id=?")
      .get(g.id) as { snapshot: string; hash_salt: string };
    // Everything below is known to a co-owner, including the guessed personas.
    const guess = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          groupId: g.id,
          revision: g.revision,
          snapshot: JSON.parse(row.snapshot),
        }),
      )
      .digest("hex");
    expect(g.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(g.snapshotHash).not.toBe(guess);
    expect(row.hash_salt).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(await group("bob", g.id))).not.toContain(
      row.hash_salt,
    );
    // The hash still binds approvals.
    expect(
      (
        await call("bob", "POST", `/api/family/groups/${g.id}/approve`, {
          revision: g.revision,
          snapshotHash: guess,
        })
      ).json.code,
    ).toBe("stale_revision");
    await ok(
      call("bob", "POST", `/api/family/groups/${g.id}/approve`, {
        revision: g.revision,
        snapshotHash: g.snapshotHash,
      }),
    );
  });

  it("state persists across a module restart and legacy unsalted hashes are migrated", async () => {
    const { g } = await activePair("Sa", "Sb");
    await ok(call("alice", "POST", `/api/family/groups/${g.id}/pause`));
    // Simulate a row written before the per-group salt existed.
    const before = db
      .prepare("SELECT revision,snapshot FROM family_groups WHERE id=?")
      .get(g.id) as { revision: number; snapshot: string };
    const legacyHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          groupId: g.id,
          revision: before.revision,
          snapshot: JSON.parse(before.snapshot),
        }),
      )
      .digest("hex");
    db.prepare(
      "UPDATE family_groups SET hash_salt=NULL,snapshot_hash=? WHERE id=?",
    ).run(legacyHash, g.id);
    vi.resetModules();
    const fresh = await import("../server/family-store");
    const migrated = db
      .prepare(
        "SELECT hash_salt,snapshot_hash,revision FROM family_groups WHERE id=?",
      )
      .get(g.id) as any;
    expect(migrated.hash_salt).toMatch(/^[a-f0-9]{64}$/);
    expect(migrated.snapshot_hash).not.toBe(legacyHash);
    expect(migrated.revision).toBe(before.revision);
    expect(fresh.familyRoomPolicy(g.roomId, "u-bob")).toMatchObject({
      status: "paused",
      canRun: false,
    });
    expect(() => fresh.assertFamilyRunAllowed(g.roomId)).toThrow();
    const actor = {
      userId: "u-bob",
      userName: "Bob",
      workspaceId: WS,
      role: "member",
    };
    const view = fresh.getGroup(actor, g.id);
    expect(view.status).toBe("paused");
    expect(view.snapshotHash).toBe(migrated.snapshot_hash);
    expect(() =>
      fresh.updateAgent(actor, g.members[0].agentId, { enabled: false }),
    ).toThrow(/主人/);
    expect(fs.existsSync(process.env.DATA_DIR!)).toBe(true);
  });
});
