import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const state = vi.hoisted(() => {
  process.env.DATA_DIR = `${process.env.TEMP || "/tmp"}/agent-family-tests-${process.pid}-${Date.now()}`;
  process.env.CANAL_KEY_FILE = `${process.env.DATA_DIR}/no-key.txt`;
  process.env.CANAL_API_KEY = "";
  process.env.APP_URL = "http://localhost:4317";
  process.env.TEST_MODE = "true";
  return {
    calls: [] as any[],
    lineReplies: [] as any[],
    linePushes: [] as any[],
    delay: 0,
  };
});
vi.mock("../server/providers", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/providers")>();
  const { MockLanguageModelV4 } = await import("ai/test");
  return {
    ...original,
    modelFor: (workspaceId: string, agent: any) => {
      original.modelFor(workspaceId, agent);
      return new MockLanguageModelV4({
        modelId: agent.model,
        doStream: async (options: any) => {
          state.calls.push({
            agent: agent.id,
            model: agent.model,
            prompt: options.prompt,
            tools: options.tools,
          });
          if (agent.model === "mock-fail")
            throw Object.assign(new Error("SECRET-MUST-NOT-LEAK"), {
              statusCode: 401,
            });
          const secondStep = options.prompt.some((m: any) => m.role === "tool");
          let toolName =
            agent.model === "mock-note"
              ? "save_draft"
              : agent.model === "mock-project"
                ? "propose_project_changes"
                : agent.model === "mock-tool"
                  ? "current_time"
                  : null;
          const toolsAllowed = options.tools?.some(
            (t: any) => t.name === toolName,
          );
          const toolInput =
            toolName === "save_draft"
              ? { title: "测试笔记", content: "这是仅保存在本群的草稿" }
              : toolName === "propose_project_changes"
                ? {
                    title: "添加入口文件",
                    files: [
                      {
                        path: "index.html",
                        content: "<h1>Agent Family</h1>",
                        baseVersion: 0,
                      },
                    ],
                  }
                : {};
          const useTool = toolName && !secondStep && toolsAllowed;
          const parts: any[] = [
            { type: "stream-start", warnings: [] },
            ...(useTool
              ? [
                  {
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName,
                    input: JSON.stringify(toolInput),
                  },
                ]
              : [
                  ...(agent.model === "mock-reasoning"
                    ? [
                        { type: "reasoning-start", id: "r1" },
                        {
                          type: "reasoning-delta",
                          id: "r1",
                          delta: "NATIVE_PRIVATE_REASONING",
                        },
                        { type: "reasoning-end", id: "r1" },
                      ]
                    : []),
                  { type: "text-start", id: "text-1" },
                  {
                    type: "text-delta",
                    id: "text-1",
                    delta: `${agent.model === "mock-tagged" ? "<think>TAGGED_PRIVATE_REASONING</think>" : ""}${agent.name}的独立回答。`,
                  },
                  { type: "text-end", id: "text-1" },
                ]),
            {
              type: "finish",
              finishReason: {
                unified: useTool ? "tool-calls" : "stop",
                raw: useTool ? "tool_calls" : "stop",
              },
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
                  if (agent.model === "mock-slow")
                    await new Promise((r) => setTimeout(r, 80));
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
vi.mock("@line/bot-sdk", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    messagingApi: {
      ...original.messagingApi,
      MessagingApiClient: class {
        constructor(_opts: any) {}
        async replyMessage(request: any) {
          state.lineReplies.push(request);
          return {};
        }
        async pushMessage(request: any, retryKey: any) {
          state.linePushes.push({ request, retryKey });
          return {};
        }
      },
    },
  };
});
import { createApp } from "../server/app";
import {
  db,
  createRoom,
  getRoom,
  getMessages,
  getRuns,
  saveNote,
  getNotes,
  addMessage,
} from "../server/db";
import { auth } from "../server/auth";
import { encrypt, decrypt, id, now, config } from "../server/config";
import {
  saveProvider,
  validateEndpoint,
  listProviders,
  listModels,
  refreshModels,
  defaultAgentsWithModels,
} from "../server/providers";
import {
  startRun,
  waitForRun,
  cancelRun,
  selectedAgents,
  usage,
  reserveCall,
  recoverInterrupted,
} from "../server/orchestrator";
import {
  safeProjectPath,
  proposeChanges,
  reviewChange,
  listProjectFiles,
  projectZip,
  listChanges,
} from "../server/projects";
import { saveChannel, createChallenge, confirmChallenge } from "../server/line";
import { DEFAULT_AGENTS, type Room, type Agent } from "../shared/types";
import { unzipSync, strFromU8 } from "fflate";
let app: Awaited<ReturnType<typeof createApp>>;
let ownerCookie = "",
  ownerId = "",
  workspaceId = "",
  memberCookie = "",
  memberId = "",
  viewerCookie = "",
  outsiderCookie = "",
  outsiderId = "",
  privateRoom: Room,
  teamRoom: Room;
const headers = (cookie = ownerCookie) => ({
  origin: "http://localhost:4317",
  cookie,
});
const request = (method: any, url: string, body?: any, cookie = ownerCookie) =>
  app.inject({ method, url, headers: headers(cookie), payload: body });
let loginAddress = 20;
async function login(email: string, password = "Test-password-123!") {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: headers(""),
    payload: { email, password },
    remoteAddress: `127.0.0.${loginAddress++}`,
  });
  expect(r.statusCode).toBe(200);
  return r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
function testAgent(model = "mock-text", agentId = "a", name = "小智"): Agent {
  return {
    id: agentId,
    name,
    model,
    provider: "test",
    persona: "测试角色",
    color: "sage",
    enabled: true,
    tools: false,
  };
}
function room(
  agents = [testAgent()],
  projectMode: Room["projectMode"] = "off",
) {
  const r = createRoom(workspaceId, ownerId, `测试 ${id()}`, agents);
  if (projectMode !== "off")
    db.prepare("UPDATE rooms SET project_mode=? WHERE id=?").run(
      projectMode,
      r.id,
    );
  return getRoom(r.id)!;
}
async function run(
  r: Room,
  mode: "parallel" | "single" | "discuss" = "parallel",
  content = "你好",
) {
  const runId = startRun({
    room: r,
    actor: ownerId,
    author: "Owner",
    content,
    mode,
  });
  await waitForRun(runId);
  return {
    run: getRuns(r.id).find((x) => x.id === runId)!,
    messages: getMessages(r.id),
  };
}
async function settled(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}
beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("UNEXPECTED NETWORK REQUEST IN TEST");
    }),
  );
  app = await createApp();
  const setup = await request(
    "POST",
    "/api/setup",
    {
      name: "Owner",
      email: "owner@example.test",
      password: "Test-password-123!",
    },
    "",
  );
  expect(setup.statusCode).toBe(201);
  ownerCookie = await login("owner@example.test");
  const me = (await request("GET", "/api/me")).json();
  ownerId = me.user.id;
  workspaceId = me.workspace.id;
  saveProvider(workspaceId, {
    id: "test",
    kind: "compatible",
    baseUrl: "https://api.canalapi.com/v1",
    apiKey: "not-a-real-secret",
    models: [
      "mock-text",
      "mock-reasoning",
      "mock-tagged",
      "mock-fail",
      "mock-slow",
      "mock-tool",
      "mock-note",
      "mock-project",
    ],
  });
  for (const [email, name, role] of [
    ["member@example.test", "Member", "member"],
    ["viewer@example.test", "Viewer", "viewer"],
    ["outsider@example.test", "Outsider", "member"],
  ]) {
    const a = await auth.api.signUpEmail({
      body: { email, name, password: "Test-password-123!" },
    });
    if (name === "Outsider") {
      outsiderId = a.user.id;
      const other = id();
      db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(
        other,
        "Other",
        now(),
      );
      db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
        other,
        a.user.id,
        role,
      );
    } else {
      db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
        workspaceId,
        a.user.id,
        role,
      );
      if (name === "Member") memberId = a.user.id;
    }
  }
  memberCookie = await login("member@example.test");
  viewerCookie = await login("viewer@example.test");
  outsiderCookie = await login("outsider@example.test");
  privateRoom = room();
  teamRoom = createRoom(workspaceId, ownerId, "团队", [testAgent()], "team");
});
afterAll(async () => {
  await app.close();
  db.close();
  vi.unstubAllGlobals();
  const target = path.resolve(process.env.DATA_DIR!);
  expect(target.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  fs.rmSync(target, { recursive: true, force: true });
});
beforeEach(() => {
  state.calls.length = 0;
});
describe("authentication and authorization", () => {
  it("serves a real app entry and basic security headers", async () => {
    const r = await request("GET", "/");
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<div id="root">');
    expect(r.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
  it("requires authentication for rooms, providers, settings, audit", async () => {
    for (const url of [
      "/api/rooms",
      "/api/settings",
      "/api/models",
      "/api/audit",
    ])
      expect((await request("GET", url, undefined, "")).statusCode).toBe(401);
  });
  it("blocks public signup and repeated first-account setup", async () => {
    expect(
      (
        await request(
          "POST",
          "/api/auth/sign-up/email",
          {
            email: "attack@example.test",
            password: "Test-password-123!",
            name: "Bad",
          },
          "",
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          "POST",
          "/api/setup",
          {
            name: "Other",
            email: "other@example.test",
            password: "Test-password-123!",
          },
          "",
        )
      ).statusCode,
    ).toBe(409);
  });
  it("rejects missing and foreign Origins on mutations", async () => {
    for (const origin of [undefined, "https://evil.example"]) {
      const r = await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { cookie: ownerCookie, ...(origin ? { origin } : {}) },
        payload: { name: "Bad" },
      });
      expect(r.statusCode).toBe(403);
    }
  });
  it("does not trust workspace identifiers supplied by another tenant", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: { cookie: outsiderCookie, "x-workspace-id": workspaceId },
    });
    expect(r.statusCode).toBe(403);
  });
  it("keeps private rooms, notes and exports private", async () => {
    saveNote(privateRoom.id, "Secret", "Private content", ownerId);
    for (const cookie of [memberCookie, outsiderCookie])
      for (const suffix of ["", "/export", "/project"])
        expect(
          (
            await request(
              "GET",
              `/api/rooms/${privateRoom.id}${suffix}`,
              undefined,
              cookie,
            )
          ).statusCode,
        ).toBe(404);
  });
  it("lets team members view team rooms but not change agents", async () => {
    expect(
      (
        await request(
          "GET",
          `/api/rooms/${teamRoom.id}`,
          undefined,
          memberCookie,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          "PATCH",
          `/api/rooms/${teamRoom.id}`,
          { name: "Hijacked" },
          memberCookie,
        )
      ).statusCode,
    ).toBe(403);
  });
  it("viewers cannot consume models, create rooms, save notes or cancel", async () => {
    for (const [url, body] of [
      [`/api/rooms/${teamRoom.id}/messages`, { content: "Hello" }],
      ["/api/rooms", { name: "Bad" }],
      [`/api/rooms/${teamRoom.id}/notes`, { title: "Bad", content: "Bad" }],
      [`/api/rooms/${teamRoom.id}/cancel`, { runId: id() }],
    ] as const)
      expect((await request("POST", url, body, viewerCookie)).statusCode).toBe(
        403,
      );
  });
  it("members cannot change provider keys, LINE credentials, or invite users", async () => {
    for (const [method, url, body] of [
      ["PUT", "/api/settings/providers", {}],
      ["PUT", "/api/settings/line", {}],
      ["POST", "/api/invites", {}],
    ] as const)
      expect((await request(method, url, body, memberCookie)).statusCode).toBe(
        403,
      );
  });
  it("never returns provider secret or encrypted secret in public settings", async () => {
    const result = await request("GET", "/api/settings");
    expect(result.body).not.toContain("not-a-real-secret");
    expect(result.body).not.toContain("secret");
    const member = (
      await request("GET", "/api/settings", undefined, memberCookie)
    ).json();
    expect(member.providers).toEqual([]);
  });
  it("requires strong input bounds and unique agents", async () => {
    expect(
      (
        await request("POST", `/api/rooms/${privateRoom.id}/messages`, {
          content: "x".repeat(12001),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request("PATCH", `/api/rooms/${privateRoom.id}`, {
          agents: [testAgent(), testAgent()],
        })
      ).statusCode,
    ).toBe(400);
  });
  it("creates single-use role-bound invitations", async () => {
    const made = (
      await request("POST", "/api/invites", { role: "viewer" })
    ).json();
    const token = new URL(made.url).searchParams.get("invite");
    expect(
      (await request("GET", `/api/invites/${token}`, undefined, "")).statusCode,
    ).toBe(200);
    expect(
      (await request("POST", "/api/invites/accept", { token }, outsiderCookie))
        .statusCode,
    ).toBe(200);
    expect(
      (await request("POST", "/api/invites/accept", { token }, outsiderCookie))
        .statusCode,
    ).toBe(400);
    expect(
      (
        db
          .prepare(
            "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
          )
          .get(workspaceId, outsiderId) as any
      ).role,
    ).toBe("viewer");
    db.prepare(
      "DELETE FROM memberships WHERE workspace_id=? AND user_id=?",
    ).run(workspaceId, outsiderId);
  });
});
describe("providers and protected storage", () => {
  it("encrypts secrets with random IVs and detects tampering", () => {
    const a = encrypt("secret"),
      b = encrypt("secret");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("secret");
    expect(() => decrypt(a.slice(0, -2) + "ff")).toThrow();
  });
  it.each([
    "http://api.canalapi.com/v1",
    "https://127.0.0.1/v1",
    "https://api.canalapi.com.evil.test/v1",
    "https://u:p@api.canalapi.com/v1",
    "https://api.canalapi.com:8080/v1",
    "https://api.canalapi.com/v1?key=oops",
  ])("blocks unsafe provider endpoint %s", (url) => {
    expect(() => validateEndpoint(url)).toThrow();
  });
  it("supports native provider choices without exposing credentials", () => {
    for (const [kind, baseUrl] of [
      ["anthropic", "https://api.anthropic.com/v1"],
      ["google", "https://generativelanguage.googleapis.com/v1beta"],
      ["openai", "https://api.openai.com/v1"],
    ] as const)
      saveProvider(workspaceId, {
        id: kind,
        kind,
        baseUrl,
        apiKey: "fake-native-key",
        models: ["test-native"],
      });
    expect(
      listProviders(workspaceId)
        .filter((p) => p.id !== "test")
        .map((p) => p.kind),
    ).toEqual(expect.arrayContaining(["anthropic", "google", "openai"]));
  });
  it("filters speech/image/video models from discovered chat models and never follows redirects", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-6-luna" },
            { id: "speech-2.8-hd" },
            { id: "MiniMax-Hailuo-02" },
            { id: "asr-1.0" },
            { id: "claude-haiku-5-5" },
          ],
        }),
        { status: 200 },
      ),
    );
    saveProvider(workspaceId, {
      id: "catalog",
      kind: "compatible",
      baseUrl: "https://api.canalapi.com/v1",
      apiKey: "fake-catalog-key",
      models: [],
    });
    const result = await refreshModels(workspaceId, "catalog");
    expect(result).toEqual(["gpt-6-luna", "claude-haiku-5-5"]);
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.redirect).toBe("error");
    const defaults = defaultAgentsWithModels(workspaceId, DEFAULT_AGENTS);
    expect(defaults[0].model).toBe("gpt-6-luna");
    expect(defaults[2].enabled).toBe(false);
  });
});
describe("bounded multi-agent execution", () => {
  it.each(["mock-reasoning", "mock-tagged"])(
    "stores %s separately and passes only answers into discussion context",
    async (model) => {
      const r = room([testAgent(model), testAgent("mock-text", "b", "小文")]);
      const result = await run(r, "discuss");
      expect(result.run.status).toBe("completed");
      const answer = result.messages.find((m) => m.agentId === "a")!;
      expect(answer.reasoning).toContain("PRIVATE_REASONING");
      expect(answer.content).toBe("小智的独立回答。");
      expect(JSON.stringify(state.calls[2].prompt)).not.toContain(
        "PRIVATE_REASONING",
      );
      expect(JSON.stringify(state.calls[2].prompt)).toContain("小智的独立回答");
      const stored = db
        .prepare("SELECT content,reasoning FROM messages WHERE id=?")
        .get(answer.id) as any;
      expect(stored.content).toBe(answer.content);
      expect(stored.reasoning).toBe(answer.reasoning);
    },
  );
  it("reads legacy tagged answers without rewriting them or parsing human messages", async () => {
    const r = room();
    const base = {
      roomId: r.id,
      runId: null,
      agentId: null,
      author: "Legacy",
      model: null,
      status: "complete" as const,
      source: "web" as const,
    };
    const text = "<think>LEGACY_THOUGHT</think>历史正式回答";
    addMessage({ ...base, role: "assistant", content: text });
    addMessage({ ...base, role: "user", content: text });
    const messages = getMessages(r.id);
    expect(messages[0].content).toBe("历史正式回答");
    expect(messages[0].reasoning).toBe("LEGACY_THOUGHT");
    expect(messages[1].content).toBe(text);
    const exported = await request(
      "GET",
      `/api/rooms/${r.id}/export?format=json`,
    );
    expect(exported.json().messages[0].reasoning).toBe("LEGACY_THOUGHT");
    expect(
      (
        db
          .prepare("SELECT content FROM messages WHERE id=?")
          .get(messages[0].id) as any
      ).content,
    ).toBe(text);
  });
  it("routes exact Chinese mentions and punctuation", () => {
    const r = room([
      testAgent("mock-text", "a", "小智"),
      testAgent("mock-text", "b", "小文"),
    ]);
    expect(selectedAgents(r, "@小文，帮我看看").map((a) => a.id)).toEqual([
      "b",
    ]);
    expect(selectedAgents(r, "@小文案").map((a) => a.id)).toEqual(["a", "b"]);
    expect(() => selectedAgents(r, "hello", ["unknown"])).toThrow();
  });
  it("persists independent answers in a shared run", async () => {
    const r = room([testAgent(), testAgent("mock-text", "b", "小文")]);
    const result = await run(r);
    expect(result.run.status).toBe("completed");
    expect(result.messages.filter((m) => m.role === "assistant")).toHaveLength(
      2,
    );
    expect(state.calls).toHaveLength(2);
    expect(
      state.calls.every(
        (c) => !JSON.stringify(c.prompt).includes("小智的独立回答"),
      ),
    ).toBe(true);
  });
  it("discusses for exactly two rounds, exposing prior answers only in round two", async () => {
    const r = room([testAgent(), testAgent("mock-text", "b", "小文")]);
    const result = await run(r, "discuss");
    expect(result.run.status).toBe("completed");
    expect(state.calls).toHaveLength(4);
    expect(JSON.stringify(state.calls[2].prompt)).toContain("小智的独立回答");
    expect(JSON.stringify(state.calls[2].prompt)).toContain("小文的独立回答");
  });
  it("isolates a failed member and sanitizes provider errors", async () => {
    const result = await run(
      room([testAgent(), testAgent("mock-fail", "b", "小文")]),
    );
    expect(result.run.status).toBe("partial");
    expect(
      result.messages.some(
        (m) => m.status === "complete" && m.role === "assistant",
      ),
    ).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain(
      "SECRET-MUST-NOT-LEAK",
    );
  });
  it("prevents concurrent runs in the same room and stops subsequent rounds", async () => {
    const r = room([testAgent("mock-slow")]);
    const runId = startRun({
      room: r,
      actor: ownerId,
      author: "Owner",
      content: "slow",
      mode: "discuss",
    });
    expect(() =>
      startRun({ room: r, actor: ownerId, author: "Owner", content: "second" }),
    ).toThrow("正在回答");
    await new Promise((r) => setTimeout(r, 100));
    cancelRun(runId, r.id);
    await waitForRun(runId);
    expect(getRuns(r.id)[0].status).toBe("cancelled");
    expect(state.calls.length).toBeLessThanOrEqual(1);
  });
  it("does not expose tools to members without tool permission", async () => {
    const r = room([testAgent("mock-tool")]);
    await run(r);
    expect(state.calls[0].tools || []).toHaveLength(0);
  });
  it("uses the SDK tool loop and charges each model step against quota", async () => {
    const r = room([{ ...testAgent("mock-tool"), tools: true }]);
    const before = usage(workspaceId).calls;
    const result = await run(r);
    expect(result.run.status).toBe("completed");
    expect(state.calls).toHaveLength(2);
    expect(usage(workspaceId).calls - before).toBe(2);
    expect(
      result.messages.find((m) => m.role === "assistant")?.toolEvents[0].name,
    ).toBe("current_time");
  });
  it("saves actual scoped draft notes through the tool", async () => {
    const r = room([{ ...testAgent("mock-note"), tools: true }]);
    await run(r);
    expect(getNotes(r.id)).toHaveLength(1);
    expect(getNotes(privateRoom.id).some((n) => n.title === "测试笔记")).toBe(
      false,
    );
  });
  it("stages model file changes without writing until explicit approval", async () => {
    const r = room([{ ...testAgent("mock-project"), tools: true }], "shared");
    await run(r);
    expect(listProjectFiles(r.id)).toHaveLength(0);
    expect(listChanges(r.id)[0].status).toBe("pending");
    reviewChange(r, listChanges(r.id)[0].id, ownerId, "approve");
    expect(listProjectFiles(r.id)[0].content).toBe("<h1>Agent Family</h1>");
  });
  it("records failed tool execution without claiming it was saved", async () => {
    const r = room([{ ...testAgent("mock-note"), tools: true }]);
    for (let i = 0; i < 200; i++)
      saveNote(r.id, `Existing ${i}`, "full", ownerId);
    const result = await run(r);
    expect(getNotes(r.id)).toHaveLength(200);
    expect(
      result.messages.find((m) => m.role === "assistant")?.toolEvents[0].result,
    ).toBe("未完成");
  });
  it("hard-stops at the daily budget before an additional network step", () => {
    const old = usage(workspaceId);
    db.prepare(
      "UPDATE usage_daily SET calls=? WHERE workspace_id=? AND day=?",
    ).run(config.dailyCalls, workspaceId, old.day);
    expect(() => reserveCall(workspaceId)).toThrow("上限");
    expect(() =>
      startRun({
        room: room(),
        actor: ownerId,
        author: "Owner",
        content: "no budget",
      }),
    ).toThrow("剩余次数");
    db.prepare(
      "UPDATE usage_daily SET calls=? WHERE workspace_id=? AND day=?",
    ).run(old.calls, workspaceId, old.day);
  });
  it("marks unfinished tasks interrupted on restart without replay", () => {
    const r = room();
    const runId = id();
    db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?)").run(
      runId,
      r.id,
      "running",
      "parallel",
      now(),
      null,
      null,
    );
    recoverInterrupted();
    expect(getRuns(r.id)[0].status).toBe("interrupted");
    expect(state.calls).toHaveLength(0);
  });
});
describe("reviewed project files", () => {
  it.each([
    "../secret",
    "/etc/passwd",
    "C:/secret",
    "a\\b",
    ".env",
    ".env.local",
    ".git/config",
    "src/../../x",
    "CON.txt",
    "foo/",
    "a//b",
    "a/./b",
    "id_rsa",
    "CanalAPI-Key.txt",
  ])("rejects unsafe project path %s", (p) =>
    expect(() => safeProjectPath(p)).toThrow(),
  );
  it("accepts ordinary project paths and example environment files", () => {
    for (const p of [
      "src/app.ts",
      "README.md",
      ".env.example",
      ".github/workflows/test.yml",
    ])
      expect(safeProjectPath(p)).toBe(p);
  });
  it("approves atomic batches and rejects stale conflicts without partial writes", () => {
    const r = room(undefined, "shared");
    const first = proposeChanges(r, "a", null, "Initial", [
      { path: "a.ts", content: "v1", baseVersion: 0 },
    ]);
    const stale = proposeChanges(r, "b", null, "Stale", [
      { path: "b.ts", content: "new", baseVersion: 0 },
      { path: "a.ts", content: "v2", baseVersion: 0 },
    ]);
    reviewChange(r, first, ownerId, "approve");
    expect(() => reviewChange(r, stale, ownerId, "approve")).toThrow("已变化");
    expect(listProjectFiles(r.id).map((f) => f.path)).toEqual(["a.ts"]);
    expect(listChanges(r.id).find((c) => c.id === stale)?.status).toBe(
      "pending",
    );
  });
  it("isolates independent branches and exports only approved files", () => {
    const r = room(undefined, "independent");
    const a = proposeChanges(r, "a", null, "A", [
      { path: "index.txt", content: "A", baseVersion: 0 },
    ]);
    const b = proposeChanges(r, "b", null, "B", [
      { path: "index.txt", content: "B", baseVersion: 0 },
    ]);
    reviewChange(r, a, ownerId, "approve");
    expect(listProjectFiles(r.id, "agent-b")).toHaveLength(0);
    reviewChange(r, b, ownerId, "approve");
    expect(listProjectFiles(r.id, "agent-a")[0].content).toBe("A");
    const zip = unzipSync(projectZip(r.id, "agent-b"));
    expect(strFromU8(zip["index.txt"])).toBe("B");
  });
  it("preserves tombstone versions to prevent delete/recreate stale approvals", () => {
    const r = room(undefined, "shared");
    const approve = (content: string | null, baseVersion: number) =>
      reviewChange(
        r,
        proposeChanges(r, "a", null, "change", [
          { path: "x.txt", content, baseVersion },
        ]),
        ownerId,
        "approve",
      );
    approve("A", 0);
    approve(null, 1);
    expect(() => approve("B", 0)).toThrow("已变化");
    approve("B", 2);
    expect(listProjectFiles(r.id)[0].version).toBe(3);
  });
  it("requires creator/admin permission to approve team project changes", async () => {
    const r = createRoom(
      workspaceId,
      ownerId,
      "Shared project",
      [testAgent()],
      "team",
    );
    db.prepare("UPDATE rooms SET project_mode='shared' WHERE id=?").run(r.id);
    const rr = getRoom(r.id)!;
    const changeId = proposeChanges(rr, "a", null, "Test", [
      { path: "x.txt", content: "X", baseVersion: 0 },
    ]);
    expect(
      (
        await request(
          "POST",
          `/api/rooms/${rr.id}/project/changes/${changeId}/review`,
          { decision: "approve" },
          memberCookie,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request(
          "POST",
          `/api/rooms/${rr.id}/project/changes/${changeId}/review`,
          { decision: "approve" },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          "POST",
          `/api/rooms/${rr.id}/project/changes/${changeId}/review`,
          { decision: "approve" },
        )
      ).statusCode,
    ).toBe(400);
  });
});
describe("LINE signature, privacy, binding and idempotency", () => {
  let channelId: string;
  const secret = "test-line-channel-secret";
  beforeAll(() => {
    channelId = saveChannel(
      workspaceId,
      secret,
      "fake-line-token-only-for-test",
    )!.id;
    db.prepare("UPDATE line_channels SET enabled=1,verified=1 WHERE id=?").run(
      channelId,
    );
  });
  const webhook = (events: any[], signature?: string) => {
    const body = JSON.stringify({ events });
    return app.inject({
      method: "POST",
      url: `/api/line/webhook/${channelId}`,
      headers: {
        "content-type": "application/json",
        "x-line-signature":
          signature ||
          crypto.createHmac("sha256", secret).update(body).digest("base64"),
      },
      payload: body,
    });
  };
  const event = (text: string, eventId = id(), groupId = "test-group") => ({
    type: "message",
    webhookEventId: eventId,
    timestamp: Date.now(),
    replyToken: "test-reply-token",
    source: { type: "group", groupId, userId: "test-line-user" },
    message: { type: "text", id: id(), text },
  });
  it("rejects unsigned or tampered payloads before reading content", async () => {
    expect((await webhook([], "bad-signature")).statusCode).toBe(401);
    expect((await webhook([])).statusCode).toBe(200);
  });
  it("does not persist or respond to normal group conversations", async () => {
    const e = event("unrelated private discussion");
    await webhook([e]);
    expect(
      db.prepare("SELECT 1 FROM line_events WHERE id=?").get(e.webhookEventId),
    ).toBeUndefined();
  });
  it("requires both the group challenge and a signed-in Web confirmation", async () => {
    const r = room();
    const c = createChallenge(workspaceId, r.id, ownerId);
    expect(() => confirmChallenge(workspaceId, r.id, ownerId)).toThrow(
      "尚未收到",
    );
    const e = event(`/绑定 ${c.code}`);
    await webhook([e]);
    await settled(
      () =>
        !!(
          db
            .prepare("SELECT group_id FROM line_challenges WHERE code=?")
            .get(c.code) as any
        )?.group_id,
    );
    expect(
      db.prepare("SELECT 1 FROM line_bindings WHERE room_id=?").get(r.id),
    ).toBeUndefined();
    expect(() => confirmChallenge(workspaceId, r.id, memberId)).toThrow();
    expect(
      (await request("POST", `/api/rooms/${r.id}/line/confirm`, {})).statusCode,
    ).toBe(400);
    expect(
      (
        await request("POST", `/api/rooms/${r.id}/line/confirm`, {
          shareContext: true,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        db
          .prepare("SELECT group_id FROM line_bindings WHERE room_id=?")
          .get(r.id) as any
      ).group_id,
    ).toBe("test-group");
  });
  it("processes a signed group command once even when LINE redelivers", async () => {
    state.lineReplies.length = 0;
    const e = event("/af 你好");
    expect((await webhook([e, e])).statusCode).toBe(200);
    await settled(
      () =>
        (
          db
            .prepare("SELECT status FROM line_events WHERE id=?")
            .get(e.webhookEventId) as any
        )?.status === "done",
    );
    expect((await webhook([e])).statusCode).toBe(200);
    expect(state.calls).toHaveLength(1);
    expect(state.lineReplies).toHaveLength(1);
    expect(state.lineReplies[0].messages[0].sender.name).toBe("小智");
    expect(
      (
        db
          .prepare("SELECT payload FROM line_events WHERE id=?")
          .get(e.webhookEventId) as any
      ).payload,
    ).toBe("{}");
  });
  it("does not accept new commands while channel disabled", async () => {
    db.prepare("UPDATE line_channels SET enabled=0 WHERE id=?").run(channelId);
    const e = event("/af Do not run");
    await webhook([e]);
    expect(
      db.prepare("SELECT 1 FROM line_events WHERE id=?").get(e.webhookEventId),
    ).toBeUndefined();
    db.prepare("UPDATE line_channels SET enabled=1 WHERE id=?").run(channelId);
  });
  it("removes a binding when the bot leaves even while disabled, without model calls", async () => {
    const binding = db
      .prepare("SELECT room_id FROM line_bindings WHERE group_id='test-group'")
      .get() as any;
    expect(binding).toBeTruthy();
    db.prepare("UPDATE line_channels SET enabled=0 WHERE id=?").run(channelId);
    const e = {
      type: "leave",
      webhookEventId: id(),
      source: { type: "group", groupId: "test-group" },
    };
    await webhook([e, e]);
    expect(
      db
        .prepare("SELECT 1 FROM line_bindings WHERE group_id='test-group'")
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT 1 FROM line_challenges WHERE group_id='test-group'")
        .get(),
    ).toBeUndefined();
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) n FROM audit WHERE action='line.group_left' AND target=?",
          )
          .get(binding.room_id) as any
      ).n,
    ).toBe(1);
    expect(state.calls).toHaveLength(0);
    db.prepare("UPDATE line_channels SET enabled=1 WHERE id=?").run(channelId);
  });
});
