/**
 * End-to-end Family integration through createApp()/app.inject with REAL Better Auth
 * session cookies (setup → invite → accept → sign-in). Models are mocked via ai/test.
 * No network, no provider credentials, temp DATA_DIR.
 */
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
const state = vi.hoisted(() => {
  process.env.DATA_DIR = `${process.env.TEMP || "/tmp"}/agent-family-family-int-${process.pid}-${Date.now()}`;
  process.env.CANAL_KEY_FILE = `${process.env.DATA_DIR}/no-key.txt`;
  process.env.CANAL_API_KEY = "";
  process.env.APP_URL = "http://localhost:4317";
  process.env.TEST_MODE = "true";
  return {
    calls: [] as { agent: string; model: string; at: number; tools: unknown }[],
  };
});
vi.mock("../server/providers", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/providers")>();
  const { MockLanguageModelV4 } = await import("ai/test");
  return {
    ...original,
    modelFor: (workspaceId: string, agent: any, ...rest: any[]) => {
      (original.modelFor as any)(workspaceId, agent, ...rest);
      return new MockLanguageModelV4({
        modelId: agent.model,
        doStream: async (options: any) => {
          state.calls.push({
            agent: agent.id,
            model: agent.model,
            at: Date.now(),
            tools: options.tools,
          });
          const slow = agent.model === "mock-slow";
          const deltas = slow
            ? Array.from({ length: 10 }, (_, i) => `${agent.name}片段${i}。`)
            : [`${agent.name}的独立回答。`];
          const parts: any[] = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            ...deltas.map((delta) => ({ type: "text-delta", id: "t1", delta })),
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ];
          return {
            stream: new ReadableStream({
              async start(controller) {
                for (const part of parts) {
                  if (options.abortSignal?.aborted) {
                    controller.error(new DOMException("Aborted", "AbortError"));
                    return;
                  }
                  if (slow) await new Promise((r) => setTimeout(r, 60));
                  try {
                    controller.enqueue(part);
                  } catch {
                    return;
                  }
                }
                controller.close();
              },
            }),
          };
        },
      });
    },
  };
});
import crypto from "node:crypto";
import { createApp } from "../server/app";
import { db, getRoom, getMessages, getRuns, createRoom } from "../server/db";
import { auth } from "../server/auth";
import { id, now } from "../server/config";
import { saveProvider } from "../server/providers";
import { waitForRun } from "../server/orchestrator";

const ORIGIN = "http://localhost:4317";
const PASSWORD = "Test-password-123!";
type Res = { status: number; json: any; body: string };
let app: Awaited<ReturnType<typeof createApp>>;
let workspaceId = "";
const U: Record<string, { cookie: string; id: string; ip: string }> = {};
let ipSeq = 10;

async function call(
  user: string | null,
  method: string,
  url: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Res> {
  const u = user ? U[user] : undefined;
  const r = await app.inject({
    method: method as any,
    url,
    headers: {
      origin: ORIGIN,
      ...(u ? { cookie: u.cookie } : {}),
      ...extraHeaders,
    },
    remoteAddress: u?.ip || "127.0.0.1",
    ...(body !== undefined
      ? { payload: body as any }
      : ["POST", "PATCH", "PUT"].includes(method)
        ? { payload: {} }
        : {}),
  });
  let json: any = undefined;
  try {
    json = r.json();
  } catch {
    /* non-json */
  }
  return { status: r.statusCode, json, body: r.body };
}
async function ok(p: Promise<Res>, status = 200) {
  const r = await p;
  if (r.status !== status)
    throw new Error(`expected ${status}, got ${r.status}: ${r.body}`);
  return r.json;
}
async function login(email: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: ORIGIN },
    payload: { email, password: PASSWORD },
    remoteAddress: `127.0.1.${ipSeq++}`,
  });
  expect(r.statusCode).toBe(200);
  return r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function invite(key: string, name: string) {
  const inv = await ok(
    call("admin", "POST", "/api/invites", { role: "member" }),
  );
  const token = new URL(inv.url).searchParams.get("invite")!;
  const email = `${key}@family.test`;
  const accepted = await app.inject({
    method: "POST",
    url: "/api/invites/accept",
    headers: { origin: ORIGIN },
    payload: { token, name, email, password: PASSWORD },
    remoteAddress: `127.0.2.${ipSeq++}`,
  });
  expect(accepted.statusCode).toBe(200);
  const cookie = await login(email);
  U[key] = { cookie, id: "", ip: `10.9.0.${ipSeq++}` };
  U[key].id = (await ok(call(key, "GET", "/api/me"))).user.id;
}
async function settled(predicate: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("condition not reached");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nameSeq = 0;
async function familyAgent(user: string, model: string, persona: string) {
  const name = `${user.slice(0, 4)}${++nameSeq}`;
  const r = await ok(
    call(user, "POST", "/api/family/agents", {
      name,
      model,
      provider: "test",
      persona,
      color: "blue",
    }),
  );
  return r.agents[0].id as string;
}
const groupView = async (user: string, gid: string) =>
  (await ok(call(user, "GET", `/api/family/groups/${gid}`))).groups[0];
async function approve(user: string, gid: string, action = "approve") {
  const g = await groupView(user, gid);
  return (
    await ok(
      call(user, "POST", `/api/family/groups/${gid}/${action}`, {
        revision: g.revision,
        snapshotHash: g.snapshotHash,
      }),
    )
  ).groups[0];
}
/** Two owners, one agent each, accepted friendship, unanimously approved DM room. */
async function supervisedPair(
  ownerA: string,
  ownerB: string,
  model = "mock-text",
) {
  const tag = crypto.randomBytes(3).toString("hex");
  const personaA = `PERSONA-${ownerA}-${tag}`;
  const personaB = `PERSONA-${ownerB}-${tag}`;
  const a = await familyAgent(ownerA, model, personaA);
  const b = await familyAgent(ownerB, model, personaB);
  const f = (
    await ok(
      call(ownerA, "POST", "/api/family/friendships", {
        fromAgentId: a,
        toAgentId: b,
      }),
    )
  ).friendships[0];
  await ok(call(ownerB, "POST", `/api/family/friendships/${f.id}/accept`));
  const g = (
    await ok(
      call(ownerA, "POST", "/api/family/groups", {
        kind: "dm",
        name: `G${tag}`,
        agentIds: [a, b],
      }),
    )
  ).groups[0];
  expect(g.status).toBe("proposed");
  expect(g.roomId).toBeNull();
  expect((await approve(ownerA, g.id)).status).toBe("proposed");
  const active = await approve(ownerB, g.id);
  expect(active.status).toBe("active");
  expect(active.roomId).toBeTruthy();
  return {
    gid: g.id as string,
    roomId: active.roomId as string,
    a,
    b,
    personaA,
    personaB,
    friendshipId: f.id as string,
  };
}
const callsFor = (...agentIds: string[]) =>
  state.calls.filter((c) => agentIds.includes(c.agent)).length;
/** Fresh invited members keep the new regression tests isolated (and under per-IP post limits). */
async function ensureUser(key: string, name: string) {
  if (!U[key]) await invite(key, name);
}
const count = (sql: string) =>
  (db.prepare(sql).get(workspaceId) as { n: number }).n;
const stripEndpoint = ({ providerUrl, providerKind, ...rest }: any) => rest;
/** Simulates rows written by older code (before endpoints were mandatory). */
function rewriteSnapshot(gid: string, fn: (s: any) => any) {
  const row = db
    .prepare("SELECT snapshot FROM family_groups WHERE id=?")
    .get(gid) as { snapshot: string };
  db.prepare("UPDATE family_groups SET snapshot=? WHERE id=?").run(
    JSON.stringify(JSON.parse(row.snapshot).map(fn)),
    gid,
  );
}

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("UNEXPECTED NETWORK REQUEST IN TEST");
    }),
  );
  app = await createApp();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    headers: { origin: ORIGIN },
    payload: { name: "Admin", email: "admin@family.test", password: PASSWORD },
  });
  expect(setup.statusCode).toBe(201);
  U.admin = {
    cookie: await login("admin@family.test"),
    id: "",
    ip: "10.9.0.1",
  };
  const me = await ok(call("admin", "GET", "/api/me"));
  U.admin.id = me.user.id;
  workspaceId = me.workspace.id;
  expect(me.workspace.role).toBe("owner");
  saveProvider(workspaceId, {
    id: "test",
    kind: "compatible",
    baseUrl: "https://api.canalapi.com/v1",
    apiKey: "not-a-real-secret",
    models: ["mock-text", "mock-slow"],
  });
  await invite("alice", "Alice");
  await invite("bob", "Bob");
  await invite("carol", "Carol"); // same-workspace member, owns nothing in the groups
  await invite("dana", "Dana"); // used for membership revocation
  // Outsider in a different workspace (real login cookie, never a member here).
  const out = await auth.api.signUpEmail({
    body: { email: "mallory@other.test", name: "Mallory", password: PASSWORD },
  });
  const other = id();
  db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(other, "Other", now());
  db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
    other,
    out.user.id,
    "owner",
  );
  U.mallory = {
    cookie: await login("mallory@other.test"),
    id: out.user.id,
    ip: "10.9.0.250",
  };
}, 60000);
afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
});

describe("family integration through real sessions", () => {
  it("two invited owners build a unanimously approved room; both read history and run real (mocked) model turns", async () => {
    const p = await supervisedPair("alice", "bob");
    // Both owners can read the room, and each sees only their own persona.
    for (const [me, mine, theirs, myAgent, otherAgent] of [
      ["alice", p.personaA, p.personaB, p.a, p.b],
      ["bob", p.personaB, p.personaA, p.b, p.a],
    ] as const) {
      const r = await call(me, "GET", `/api/rooms/${p.roomId}`);
      expect(r.status).toBe(200);
      expect(r.body).not.toContain(theirs);
      expect(
        r.json.room.agents.find((x: any) => x.id === myAgent).persona,
      ).toBe(mine);
      expect(
        r.json.room.agents.find((x: any) => x.id === otherAgent).persona,
      ).toBe("");
      expect(r.json.room.agents.every((x: any) => x.tools === false)).toBe(
        true,
      );
      expect(r.json.room.projectMode).toBe("off");
      const list = await call(me, "GET", "/api/rooms");
      expect(list.json.map((x: any) => x.id)).toContain(p.roomId);
      expect(list.body).not.toContain(theirs);
    }
    // Creator (alice) runs a turn; non-creator owner (bob) runs a turn.
    const before = callsFor(p.a, p.b);
    const r1 = await ok(
      call("alice", "POST", `/api/rooms/${p.roomId}/messages`, {
        content: "大家好",
        mode: "parallel",
      }),
      202,
    );
    await waitForRun(r1.runId);
    const r2 = await ok(
      call("bob", "POST", `/api/rooms/${p.roomId}/messages`, {
        content: "Bob 的问题",
        mode: "parallel",
      }),
      202,
    );
    await waitForRun(r2.runId);
    expect(callsFor(p.a, p.b) - before).toBe(4);
    // Frozen safe config reaches the model: no tools offered across owners.
    for (const c of state.calls.filter((c) => [p.a, p.b].includes(c.agent)))
      expect(
        c.tools === undefined ||
          (Array.isArray(c.tools) && c.tools.length === 0),
      ).toBe(true);
    const runs = getRuns(p.roomId);
    expect(runs.map((r) => r.status).sort()).toEqual([
      "completed",
      "completed",
    ]);
    for (const me of ["alice", "bob"]) {
      const h = await ok(call(me, "GET", `/api/rooms/${p.roomId}`));
      const contents = h.messages.map((m: any) => m.content).join("\n");
      expect(contents).toContain("大家好");
      expect(contents).toContain("Bob 的问题");
      expect(
        h.messages.filter(
          (m: any) => m.role === "assistant" && m.status === "complete",
        ),
      ).toHaveLength(4);
    }
  });

  it("workspace admin, same-workspace non-owner and cross-workspace outsider cannot see or touch the room", async () => {
    const p = await supervisedPair("alice", "bob");
    await ok(
      call("alice", "POST", `/api/rooms/${p.roomId}/messages`, {
        content: "PRIVATE-HISTORY",
        mode: "parallel",
      }),
      202,
    ).then((r) => waitForRun(r.runId));
    for (const who of ["admin", "carol", "mallory"]) {
      const urls: [string, string, unknown?][] = [
        ["GET", `/api/rooms/${p.roomId}`],
        ["GET", `/api/rooms/${p.roomId}/export?format=json`],
        ["GET", `/api/rooms/${p.roomId}/export`],
        ["GET", `/api/rooms/${p.roomId}/events`],
        [
          "PATCH",
          `/api/rooms/${p.roomId}`,
          { name: "hijack", visibility: "team" },
        ],
        ["DELETE", `/api/rooms/${p.roomId}`],
        [
          "POST",
          `/api/rooms/${p.roomId}/messages`,
          { content: "intrude", mode: "parallel" },
        ],
        [
          "POST",
          `/api/rooms/${p.roomId}/cancel`,
          { runId: crypto.randomUUID() },
        ],
        ["GET", `/api/family/groups/${p.gid}`],
        ["POST", `/api/family/groups/${p.gid}/pause`, {}],
        ["POST", `/api/family/groups/${p.gid}/archive`, {}],
      ];
      for (const [method, url, body] of urls) {
        const r = await call(who, method, url, body);
        expect(
          [403, 404],
          `${who} ${method} ${url} -> ${r.status} ${r.body}`,
        ).toContain(r.status);
        expect(r.body).not.toContain("PRIVATE-HISTORY");
        expect(r.body).not.toContain(p.personaA);
      }
      const list = await call(who, "GET", "/api/rooms");
      if (list.status === 200)
        expect(list.json.map((x: any) => x.id)).not.toContain(p.roomId);
      // Admin cannot edit another owner's agent either.
      expect(
        (
          await call(who, "PATCH", `/api/family/agents/${p.a}`, {
            persona: "taken",
          })
        ).status,
      ).not.toBe(200);
    }
    const room = getRoom(p.roomId)!;
    expect(room.name).not.toBe("hijack");
    expect(room.visibility).toBe("private");
    expect(room.archived).toBeFalsy();
    expect(getMessages(p.roomId).some((m) => m.content === "intrude")).toBe(
      false,
    );
  });

  it("the room creator cannot use legacy room endpoints to change tools/members/visibility; notes/project/LINE are denied", async () => {
    const p = await supervisedPair("alice", "bob");
    const frozen = getRoom(p.roomId)!;
    expect(frozen.createdBy).toBe(U.alice.id);
    const tooled = frozen.agents.map((a) => ({ ...a, tools: true }));
    const intruder = {
      ...frozen.agents[0],
      id: "intruder",
      name: "Intruder",
      persona: "x",
    };
    const denied: [string, string, unknown?][] = [
      ["PATCH", `/api/rooms/${p.roomId}`, { agents: tooled }],
      [
        "PATCH",
        `/api/rooms/${p.roomId}`,
        { agents: [...frozen.agents, intruder] },
      ],
      ["PATCH", `/api/rooms/${p.roomId}`, { visibility: "team" }],
      ["PATCH", `/api/rooms/${p.roomId}`, { projectMode: "shared" }],
      ["DELETE", `/api/rooms/${p.roomId}`],
      ["POST", `/api/rooms/${p.roomId}/notes`, { title: "n", content: "c" }],
      ["GET", `/api/rooms/${p.roomId}/project`],
      [
        "POST",
        `/api/rooms/${p.roomId}/project/changes`,
        {
          title: "t",
          files: [{ path: "a.txt", content: "x", baseVersion: 0 }],
        },
      ],
      ["GET", `/api/rooms/${p.roomId}/project/export`],
      ["GET", `/api/rooms/${p.roomId}/line`],
      ["POST", `/api/rooms/${p.roomId}/line/challenge`, {}],
      ["POST", `/api/rooms/${p.roomId}/line/confirm`, { shareContext: true }],
      [
        "PATCH",
        `/api/rooms/${p.roomId}/line`,
        { mode: "parallel", shareTools: true },
      ],
      ["DELETE", `/api/rooms/${p.roomId}/line`],
    ];
    for (const who of ["alice", "bob"])
      for (const [method, url, body] of denied) {
        const r = await call(who, method, url, body);
        expect(
          r.status,
          `${who} ${method} ${url} -> ${r.status} ${r.body}`,
        ).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
      }
    const after = getRoom(p.roomId)!;
    expect(after.agents).toEqual(frozen.agents);
    expect(after.agents.every((a) => !a.tools)).toBe(true);
    expect(after.visibility).toBe("private");
    expect(after.projectMode).toBe("off");
    expect(after.archived).toBeFalsy();
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM notes WHERE room_id=?")
        .get(p.roomId),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM line_challenges WHERE room_id=?")
        .get(p.roomId),
    ).toEqual({ n: 0 });
  });

  it("exports and room lists never disclose another owner's private persona", async () => {
    const p = await supervisedPair("alice", "bob");
    await ok(
      call("alice", "POST", `/api/rooms/${p.roomId}/messages`, {
        content: "导出测试",
        mode: "parallel",
      }),
      202,
    ).then((r) => waitForRun(r.runId));
    const checks: [string, string, string][] = [
      ["bob", `/api/rooms/${p.roomId}/export?format=json`, p.personaA],
      ["bob", `/api/rooms/${p.roomId}/export`, p.personaA],
      ["bob", "/api/rooms", p.personaA],
      ["bob", `/api/rooms/${p.roomId}`, p.personaA],
      ["bob", "/api/family/agents", p.personaA],
      ["bob", `/api/family/groups/${p.gid}`, p.personaA],
      ["alice", `/api/rooms/${p.roomId}/export?format=json`, p.personaB],
      ["alice", "/api/rooms", p.personaB],
    ];
    const leaks: string[] = [];
    for (const [who, url, secret] of checks) {
      const r = await call(who, "GET", url);
      expect(r.status, `${who} GET ${url}`).toBe(200);
      if (r.body.includes(secret)) leaks.push(`${who} GET ${url}`);
    }
    expect(leaks).toEqual([]);
  });

  it("owner who is NOT the room creator can start a free discussion and both owners can interject", async () => {
    const p = await supervisedPair("alice", "bob", "mock-slow");
    expect(getRoom(p.roomId)!.createdBy).toBe(U.alice.id);
    const start = await call("bob", "POST", `/api/rooms/${p.roomId}/messages`, {
      content: "自由讨论：周末做什么？",
      mode: "free",
      discussion: { maxRounds: 3, maxCalls: 6, stopWhenQuiet: true },
    });
    expect(start.status, start.body).toBe(202);
    const runId = start.json.runId;
    await settled(
      () =>
        callsFor(p.a, p.b) > 0 &&
        getRuns(p.roomId).find((r) => r.id === runId)?.status === "running",
    );
    const bobAdd = await call(
      "bob",
      "POST",
      `/api/rooms/${p.roomId}/messages`,
      { content: "Bob 补充", runId, clientMessageId: crypto.randomUUID() },
    );
    expect(bobAdd.status, bobAdd.body).toBe(202);
    const aliceAdd = await call(
      "alice",
      "POST",
      `/api/rooms/${p.roomId}/messages`,
      { content: "Alice 补充", runId, clientMessageId: crypto.randomUUID() },
    );
    expect(aliceAdd.status, aliceAdd.body).toBe(202);
    // A non-owner cannot interject.
    expect([403, 404]).toContain(
      (
        await call("carol", "POST", `/api/rooms/${p.roomId}/messages`, {
          content: "Carol",
          runId,
          clientMessageId: crypto.randomUUID(),
        })
      ).status,
    );
    await waitForRun(runId);
    const run = getRuns(p.roomId).find((r) => r.id === runId)!;
    expect(
      ["completed", "partial"],
      `${run.status} ${run.error} ${run.notice}`,
    ).toContain(run.status);
    const msgs = getMessages(p.roomId).filter((m) => m.runId === runId);
    expect(
      msgs.find((m) => m.role === "user" && m.content.includes("周末"))?.author,
    ).toBe("Bob");
    expect(msgs.some((m) => m.content === "Bob 补充")).toBe(true);
    expect(msgs.some((m) => m.content === "Alice 补充")).toBe(true);
    expect(
      msgs.filter((m) => m.role === "assistant" && m.status === "complete")
        .length,
      JSON.stringify({
        run,
        msgs: msgs.map((m) => [
          m.role,
          m.author,
          m.status,
          m.content.slice(0, 40),
        ]),
        calls: callsFor(p.a, p.b),
      }),
    ).toBeGreaterThan(0);
    expect(JSON.stringify(msgs)).not.toContain("访问权限已变更");
  }, 30000);

  it("pause cancels the active run, rejects posting/interjection, and resume needs every owner", async () => {
    const p = await supervisedPair("alice", "bob", "mock-slow");
    const start = await ok(
      call("bob", "POST", `/api/rooms/${p.roomId}/messages`, {
        content: "长讨论",
        mode: "free",
        discussion: { maxRounds: null, maxCalls: 20, stopWhenQuiet: false },
      }),
      202,
    );
    await settled(() => callsFor(p.a, p.b) > 0);
    await sleep(100);
    const paused = (
      await ok(
        call("alice", "POST", `/api/family/groups/${p.gid}/pause`, {
          reason: "PAUSE-REASON-PRIVATE",
        }),
      )
    ).groups[0];
    expect(paused.status).toBe("paused");
    await waitForRun(start.runId);
    expect(getRuns(p.roomId).find((r) => r.id === start.runId)!.status).toBe(
      "cancelled",
    );
    expect(getMessages(p.roomId).some((m) => m.status === "streaming")).toBe(
      false,
    );
    const calls = callsFor(p.a, p.b);
    const msgCount = getMessages(p.roomId).length;
    for (const who of ["alice", "bob"]) {
      expect(
        (
          await call(who, "POST", `/api/rooms/${p.roomId}/messages`, {
            content: "paused?",
            mode: "parallel",
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await call(who, "POST", `/api/rooms/${p.roomId}/messages`, {
            content: "interject",
            runId: start.runId,
            clientMessageId: crypto.randomUUID(),
          })
        ).status,
      ).toBe(409);
    }
    await sleep(300);
    expect(callsFor(p.a, p.b)).toBe(calls);
    expect(getMessages(p.roomId).length).toBe(msgCount);
    // Reason is private to the pauser.
    expect(
      (await call("bob", "GET", `/api/family/groups/${p.gid}`)).body,
    ).not.toContain("PAUSE-REASON-PRIVATE");
    expect(
      JSON.stringify(db.prepare("SELECT * FROM audit").all()),
    ).not.toContain("PAUSE-REASON-PRIVATE");
    // Both owners still read history while paused.
    expect((await call("bob", "GET", `/api/rooms/${p.roomId}`)).status).toBe(
      200,
    );
    // Resume: one approval is not enough.
    expect((await approve("alice", p.gid, "resume")).status).toBe("paused");
    expect(
      (
        await call("alice", "POST", `/api/rooms/${p.roomId}/messages`, {
          content: "still paused",
          mode: "parallel",
        })
      ).status,
    ).toBe(409);
    expect((await approve("bob", p.gid, "resume")).status).toBe("active");
    const after = await ok(
      call("alice", "POST", `/api/rooms/${p.roomId}/messages`, {
        content: "恢复后",
        mode: "parallel",
      }),
      202,
    );
    // The old cancelled run is never revived.
    expect(getRuns(p.roomId).find((r) => r.id === start.runId)!.status).toBe(
      "cancelled",
    );
    await waitForRun(after.runId);
    expect(getRuns(p.roomId).find((r) => r.id === after.runId)!.status).toBe(
      "completed",
    );
  }, 30000);

  it("a block during streaming cancels output immediately; unblocking never resumes the old run or room", async () => {
    const p = await supervisedPair("alice", "bob", "mock-slow");
    const start = await ok(
      call("alice", "POST", `/api/rooms/${p.roomId}/messages`, {
        content: "请慢慢回答",
        mode: "parallel",
      }),
      202,
    );
    await settled(() => callsFor(p.a, p.b) >= 2);
    await sleep(120);
    expect(getRuns(p.roomId).find((r) => r.id === start.runId)!.status).toBe(
      "running",
    );
    const block = (
      await ok(
        call("bob", "POST", "/api/family/blocks", {
          scope: "agent",
          agentId: p.a,
          note: "BLOCK-NOTE-PRIVATE",
        }),
      )
    ).blocks[0];
    await settled(
      () =>
        getRuns(p.roomId).find((r) => r.id === start.runId)!.status ===
        "cancelled",
      2000,
    );
    await waitForRun(start.runId);
    const calls = callsFor(p.a, p.b);
    const assistant = getMessages(p.roomId).filter(
      (m) => m.runId === start.runId && m.role === "assistant",
    );
    expect(assistant.some((m) => m.status === "complete")).toBe(false);
    expect(assistant.some((m) => m.status === "streaming")).toBe(false);
    expect(assistant.some((m) => m.content.includes("片段9"))).toBe(false);
    expect((await groupView("alice", p.gid)).status).toBe("paused");
    // Block privacy: blocked owner sees only "unavailable", never the note or reasons.
    const aliceView = await call("alice", "GET", `/api/family/groups/${p.gid}`);
    expect(aliceView.json.groups[0].availability).toEqual({
      unavailable: true,
      myReasons: [],
      sharedReasons: [],
    });
    expect(aliceView.body).not.toContain("BLOCK-NOTE-PRIVATE");
    expect(
      (await ok(call("alice", "GET", "/api/family/blocks"))).blocks,
    ).toEqual([]);
    expect(
      (await groupView("bob", p.gid)).availability.myReasons.length,
    ).toBeGreaterThan(0);
    expect(
      JSON.stringify(db.prepare("SELECT * FROM audit").all()),
    ).not.toContain("BLOCK-NOTE-PRIVATE");
    expect(
      (
        await call("alice", "POST", `/api/rooms/${p.roomId}/messages`, {
          content: "blocked?",
          mode: "parallel",
        })
      ).status,
    ).toBe(409);
    // Unblock: nothing is revived.
    await ok(call("bob", "DELETE", `/api/family/blocks/${block.id}`));
    await sleep(400);
    expect(callsFor(p.a, p.b)).toBe(calls);
    expect(getRuns(p.roomId).find((r) => r.id === start.runId)!.status).toBe(
      "cancelled",
    );
    expect((await groupView("bob", p.gid)).status).toBe("paused");
    const friendships = (
      await ok(call("alice", "GET", "/api/family/friendships"))
    ).friendships;
    expect(friendships.find((f: any) => f.id === p.friendshipId)?.status).toBe(
      "removed",
    );
    expect(
      (
        await call("alice", "POST", `/api/rooms/${p.roomId}/messages`, {
          content: "after unblock",
          mode: "parallel",
        })
      ).status,
    ).toBe(409);
    const g = await groupView("alice", p.gid);
    expect(
      (
        await call("alice", "POST", `/api/family/groups/${p.gid}/resume`, {
          revision: g.revision,
        })
      ).status,
    ).toBe(409);
    expect(callsFor(p.a, p.b)).toBe(calls);
  }, 30000);

  it("revoking a co-owner's workspace membership during a run stops it and removes their access", async () => {
    const p = await supervisedPair("alice", "dana", "mock-slow");
    const start = await ok(
      call("alice", "POST", `/api/rooms/${p.roomId}/messages`, {
        content: "成员撤销测试",
        mode: "parallel",
      }),
      202,
    );
    await settled(() => callsFor(p.a, p.b) >= 2);
    await sleep(120);
    await ok(call("admin", "DELETE", `/api/members/${U.dana.id}`));
    await settled(
      () =>
        !["queued", "running"].includes(
          getRuns(p.roomId).find((r) => r.id === start.runId)!.status,
        ),
      3000,
    );
    await waitForRun(start.runId);
    const run = getRuns(p.roomId).find((r) => r.id === start.runId)!;
    expect(["cancelled", "failed", "partial"]).toContain(run.status);
    const assistant = getMessages(p.roomId).filter(
      (m) => m.runId === start.runId && m.role === "assistant",
    );
    expect(assistant.some((m) => m.content.includes("片段9"))).toBe(false);
    const calls = callsFor(p.a, p.b);
    await sleep(300);
    expect(callsFor(p.a, p.b)).toBe(calls);
    expect([401, 403, 404]).toContain(
      (await call("dana", "GET", `/api/rooms/${p.roomId}`)).status,
    );
    expect((await groupView("alice", p.gid)).status).toBe("paused");
    expect(
      (
        await call("alice", "POST", `/api/rooms/${p.roomId}/messages`, {
          content: "after revoke",
          mode: "parallel",
        })
      ).status,
    ).toBe(409);
  }, 30000);

  // ---------- release-review regressions (store + app.ts integration) ----------

  it("P1-1: unknown providers are refused; an admin cannot create a provider id an open group references; legacy endpoint-less rooms never run until every owner re-approves the disclosed endpoint", async () => {
    await ensureUser("erin", "Erin");
    await ensureUser("finn", "Finn");
    for (const body of [
      { name: "relay1", model: "mock-text", provider: "relay" },
      { name: "relay2", model: "not-offered", provider: "test" },
    ]) {
      const r = await call("erin", "POST", "/api/family/agents", body);
      expect(r.status, r.body).toBe(400);
      expect(r.json.code).toBe("invalid_input");
    }
    // Legacy row: one member froze no endpoint, on a provider id that never existed.
    const p = await supervisedPair("erin", "finn");
    rewriteSnapshot(p.gid, (s) =>
      s.agentId === p.b ? { ...stripEndpoint(s), provider: "relay" } : s,
    );
    const frozen = getRoom(p.roomId)!.agents;
    db.prepare("UPDATE rooms SET agents=? WHERE id=?").run(
      JSON.stringify(
        frozen.map((a) => (a.id === p.b ? { ...a, provider: "relay" } : a)),
      ),
      p.roomId,
    );
    // The admin can no longer create "relay" and silently bind cross-owner traffic to it.
    const put = await call("admin", "PUT", "/api/settings/providers", {
      id: "relay",
      kind: "compatible",
      baseUrl: "https://api.canalapi.com/v1",
      apiKey: "not-a-real-secret",
      models: ["mock-text"],
    });
    expect(put.status, put.body).toBe(409);
    expect(
      db
        .prepare("SELECT 1 FROM providers WHERE workspace_id=? AND id=?")
        .get(workspaceId, "relay"),
    ).toBeUndefined();
    const before = callsFor(p.a, p.b);
    expect(
      (
        await call("erin", "POST", `/api/rooms/${p.roomId}/messages`, {
          content: "legacy?",
          mode: "parallel",
        })
      ).status,
    ).toBe(409);
    expect(callsFor(p.a, p.b)).toBe(before);
    const paused = await groupView("finn", p.gid);
    expect(paused.status).toBe("paused");
    expect(paused.availability.sharedReasons).toHaveLength(1);
    expect(
      (
        await call("finn", "POST", `/api/family/groups/${p.gid}/resume`, {
          revision: paused.revision,
        })
      ).status,
    ).toBe(409);
    // An approved provider's endpoint cannot be swapped while groups use it.
    const swap = await call("admin", "PUT", "/api/settings/providers", {
      id: "test",
      kind: "compatible",
      baseUrl: "https://api.openai.com/v1",
      models: ["mock-text", "mock-slow"],
    });
    expect(swap.status, swap.body).toBe(409);
    // Legacy row whose provider exists: endpoint disclosed at a new revision,
    // fresh unanimous approval, then real (mocked) turns.
    const q = await supervisedPair("erin", "finn");
    rewriteSnapshot(q.gid, stripEndpoint);
    expect(
      (
        await call("erin", "POST", `/api/rooms/${q.roomId}/messages`, {
          content: "legacy?",
          mode: "parallel",
        })
      ).status,
    ).toBe(409);
    const re = await groupView("erin", q.gid);
    expect(re.status).toBe("paused");
    expect(
      re.members.every(
        (m: any) =>
          m.providerUrl === "https://api.canalapi.com/v1" &&
          m.providerKind === "compatible",
      ),
    ).toBe(true);
    expect((await approve("erin", q.gid, "resume")).status).toBe("paused");
    expect((await approve("finn", q.gid, "resume")).status).toBe("active");
    const run = await ok(
      call("erin", "POST", `/api/rooms/${q.roomId}/messages`, {
        content: "确认后继续",
        mode: "parallel",
      }),
      202,
    );
    await waitForRun(run.runId);
    expect(getRuns(q.roomId).find((r) => r.id === run.runId)!.status).toBe(
      "completed",
    );
  }, 30000);

  it("P1-2: an owner demoted to viewer keeps the emergency stop; demotion stops the run; they can never post, approve or resume", async () => {
    await ensureUser("erin", "Erin");
    await ensureUser("finn", "Finn");
    const p = await supervisedPair("erin", "finn", "mock-slow");
    const start = await ok(
      call("erin", "POST", `/api/rooms/${p.roomId}/messages`, {
        content: "降级测试，请慢慢回答",
        mode: "parallel",
      }),
      202,
    );
    await settled(() => callsFor(p.a, p.b) >= 2);
    await sleep(120);
    await ok(
      call("admin", "PATCH", `/api/members/${U.finn.id}`, { role: "viewer" }),
    );
    try {
      // Finn can still stop the run in his own supervised room.
      const stop = await call("finn", "POST", `/api/rooms/${p.roomId}/cancel`, {
        runId: start.runId,
      });
      expect(stop.status, stop.body).toBe(200);
      await waitForRun(start.runId);
      expect(["cancelled", "failed", "partial"]).toContain(
        getRuns(p.roomId).find((r) => r.id === start.runId)!.status,
      );
      expect(
        getMessages(p.roomId).some(
          (m) => m.runId === start.runId && m.content.includes("片段9"),
        ),
      ).toBe(false);
      // Paused for everyone: no co-owner keeps running against Finn's Agent.
      expect((await groupView("erin", p.gid)).status).toBe("paused");
      expect(
        (
          await call("erin", "POST", `/api/rooms/${p.roomId}/messages`, {
            content: "继续?",
            mode: "parallel",
          })
        ).status,
      ).toBe(409);
      // Finn still reads and keeps every stop right...
      expect((await call("finn", "GET", `/api/rooms/${p.roomId}`)).status).toBe(
        200,
      );
      const finnView = (
        await ok(call("finn", "POST", `/api/family/groups/${p.gid}/pause`))
      ).groups[0];
      expect(finnView.can).toMatchObject({
        approve: false,
        resume: false,
        expand: false,
        archive: true,
      });
      expect(
        (
          await call("finn", "PATCH", `/api/family/agents/${p.b}`, {
            enabled: false,
          })
        ).status,
      ).toBe(200);
      // ...but never gains posting, approval, resume or creation.
      expect(
        (
          await call("finn", "POST", `/api/rooms/${p.roomId}/messages`, {
            content: "viewer",
            mode: "parallel",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call("finn", "POST", `/api/family/groups/${p.gid}/resume`, {
            revision: finnView.revision,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call("finn", "POST", "/api/family/agents", {
            name: "viewerX",
            model: "mock-text",
            provider: "test",
          })
        ).status,
      ).toBe(403);
    } finally {
      await ok(
        call("admin", "PATCH", `/api/members/${U.finn.id}`, { role: "member" }),
      );
    }
    // Re-promotion revives nothing.
    expect((await groupView("erin", p.gid)).status).toBe("paused");
    expect(
      (
        await call("erin", "POST", `/api/rooms/${p.roomId}/messages`, {
          content: "复职后?",
          mode: "parallel",
        })
      ).status,
    ).toBe(409);
  }, 30000);

  it("P2-4: supervised family rooms never consume the ordinary 100-room quota", async () => {
    const familyOpen = count(
      "SELECT COUNT(*) AS n FROM rooms WHERE workspace_id=? AND archived=0 AND id IN (SELECT room_id FROM family_groups WHERE room_id IS NOT NULL)",
    );
    expect(familyOpen).toBeGreaterThan(0);
    const ordinary = () =>
      count(
        "SELECT COUNT(*) AS n FROM rooms WHERE workspace_id=? AND archived=0 AND id NOT IN (SELECT room_id FROM family_groups WHERE room_id IS NOT NULL)",
      );
    const filler: string[] = [];
    try {
      while (ordinary() < 99)
        filler.push(
          createRoom(workspaceId, U.admin.id, `filler${filler.length}`, []).id,
        );
      // 99 ordinary + several family rooms: the 100th ordinary room is allowed...
      const made = await call("admin", "POST", "/api/rooms", {
        name: "第一百个",
      });
      expect(made.status, made.body).toBe(201);
      filler.push(made.json.id);
      // ...and the ordinary limit itself is unchanged.
      expect(
        (await call("admin", "POST", "/api/rooms", { name: "第一百零一个" }))
          .status,
      ).toBe(400);
    } finally {
      const archive = db.prepare("UPDATE rooms SET archived=1 WHERE id=?");
      for (const rid of filler) archive.run(rid);
    }
  });

  it("P2-5: the admin audit view never lists family.* rows (who blocked or paused stays private)", async () => {
    expect(
      count(
        "SELECT COUNT(*) AS n FROM audit WHERE workspace_id=? AND action LIKE 'family.%'",
      ),
    ).toBeGreaterThan(0);
    const rows = await ok(call("admin", "GET", "/api/audit"));
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.filter((r: any) => String(r.action).startsWith("family.")),
    ).toEqual([]);
  });

  it("P2-6: renaming an account cannot impersonate another owner: current name plus a stable tag, never ids or email", async () => {
    const real = await familyAgent("alice", "mock-text", "p-real");
    const rename = async (name: string) => {
      const r = await call("carol", "POST", "/api/auth/update-user", { name });
      expect(r.status, r.body).toBe(200);
    };
    const directory = async () =>
      (await ok(call("bob", "GET", "/api/family/agents"))).agents as any[];
    await rename("Alice");
    let fake = "";
    let borrowed: any;
    try {
      fake = await familyAgent("carol", "mock-text", "p-fake");
      const agents = await directory();
      const realView = agents.find((x) => x.id === real);
      borrowed = agents.find((x) => x.id === fake);
      expect(borrowed.ownerName).toBe("Alice");
      expect(borrowed.ownerTag).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
      expect(borrowed.ownerTag).not.toBe(realView.ownerTag);
      expect(realView.ownerNameDuplicate).toBe(true);
      expect(borrowed.ownerNameDuplicate).toBe(true);
    } finally {
      await rename("Carol");
    }
    // Renaming back: the current name is shown, never the copy from creation time.
    const after = await call("bob", "GET", "/api/family/agents");
    expect(after.json.agents.find((x: any) => x.id === fake)).toMatchObject({
      ownerName: "Carol",
      ownerTag: borrowed.ownerTag,
      ownerNameDuplicate: false,
    });
    for (const secret of [
      U.alice.id,
      U.carol.id,
      "alice@family.test",
      "carol@family.test",
    ])
      expect(after.body).not.toContain(secret);
  });

  it("ordinary rooms keep their existing rules alongside family rooms", async () => {
    const list = await ok(call("admin", "GET", "/api/rooms"));
    const lounge = list.find((r: any) => r.name === "灵感客厅");
    expect(lounge).toBeTruthy();
    expect(lounge.supervision).toBeUndefined();
    expect(
      (
        await call("admin", "PATCH", `/api/rooms/${lounge.id}`, {
          name: "客厅2",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("admin", "POST", `/api/rooms/${lounge.id}/notes`, {
          title: "n",
          content: "c",
        })
      ).status,
    ).toBe(201);
    // Private ordinary room is still hidden from other members.
    expect((await call("alice", "GET", `/api/rooms/${lounge.id}`)).status).toBe(
      404,
    );
  });
});
