import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATA_DIR = `${process.env.TEMP || "/tmp"}/af-social-${process.pid}-${Date.now()}`;
  process.env.CANAL_KEY_FILE = process.env.DATA_DIR + "/absent";
  process.env.CANAL_API_KEY = "";
  process.env.APP_URL = "http://localhost:4317";
  process.env.TEST_MODE = "true";
  process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.test";
  process.env.MATRIX_SERVER_NAME = "matrix.example.test";
  process.env.MATRIX_ELEMENT_URL = "https://chat.example.test";
  process.env.MATRIX_REGISTRATION_SECRET = "testing-only";
});
import { db } from "../server/db";
import { auth, migrateAuth } from "../server/auth";
import {
  blockPerson,
  findPerson,
  friendAction,
  listFriends,
  localMatrixId,
  requestFriend,
} from "../server/social-store";
import {
  eligibleAgentMessage,
  reserveChatCall,
  updateChatAgent,
  openAgentRoom,
  ownerCanRun,
  publishAgentReply,
} from "../server/chat-agents";
let a: string, b: string, c: string;
beforeAll(async () => {
  await migrateAuth();
  const signup = async (name: string) =>
    (
      await auth.api.signUpEmail({
        body: {
          name,
          email: name + "@test.example",
          password: "Test-Password-123!",
        },
      })
    ).user.id;
  a = await signup("Alice");
  b = await signup("Bob");
  c = await signup("Carol");
});
afterAll(() => db.close());
describe("independent friendship lifecycle", () => {
  it("uses exact Matrix identity without returning emails", () => {
    expect(findPerson(localMatrixId(a))).toMatchObject({
      id: a,
      name: "Alice",
    });
    expect(findPerson(localMatrixId(a))).not.toHaveProperty("email");
    expect(findPerson("Alice")).toBeNull();
  });
  it("rejects self and unknown recipients", () => {
    expect(() => requestFriend(a, a, "")).toThrow("自己");
    expect(() => requestFriend(a, "missing", "")).toThrow("无法");
  });
  it("creates a pending request, not an accepted friendship", () => {
    requestFriend(a, b, "你好");
    const outgoing = listFriends(a).relations[0],
      incoming = listFriends(b).relations[0];
    expect(outgoing).toMatchObject({
      status: "pending",
      incoming: false,
      note: "你好",
    });
    expect(incoming).toMatchObject({ status: "pending", incoming: true });
    expect(() => requestFriend(b, a, "")).toThrow("对方已");
    expect(() => friendAction(a, outgoing.id, "accept")).toThrow("不能");
    expect(() => friendAction(c, outgoing.id, "accept")).toThrow("不存在");
  });
  it("only recipient accepts and replay is rejected", () => {
    const f = listFriends(b).relations[0];
    friendAction(b, f.id, "accept");
    expect(listFriends(a).relations[0].status).toBe("accepted");
    expect(() => friendAction(b, f.id, "accept")).toThrow("已经");
  });
  it("removing requires a fresh request and either side can remove", () => {
    friendAction(a, listFriends(a).relations[0].id, "remove");
    expect(listFriends(b).relations).toHaveLength(0);
    requestFriend(b, a, "重加");
    friendAction(a, listFriends(a).relations[0].id, "reject");
    expect(listFriends(b).relations).toHaveLength(0);
    requestFriend(a, b, "再申请");
    friendAction(a, listFriends(a).relations[0].id, "cancel");
    expect(listFriends(b).relations).toHaveLength(0);
  });
  it("blocking atomically removes friendship and prevents requests in both directions", () => {
    requestFriend(a, b, "");
    friendAction(b, listFriends(b).relations[0].id, "accept");
    blockPerson(a, b, true);
    expect(listFriends(a).relations).toHaveLength(0);
    expect(listFriends(b).relations).toHaveLength(0);
    expect(listFriends(a).blocked[0]?.id).toBe(b);
    expect(() => requestFriend(b, a, "")).toThrow("无法");
    expect(() => requestFriend(a, b, "")).toThrow("无法");
  });
  it("unblocking does not resurrect relationships or pending requests", () => {
    blockPerson(a, b, false);
    expect(listFriends(a).relations).toHaveLength(0);
    requestFriend(b, a, "重新确认");
    expect(listFriends(a).relations[0].status).toBe("pending");
  });
});
describe("bounded owner-only Agent execution", () => {
  const row = { status: "active", room_id: "!room:test" };
  const event = {
    type: "m.room.message",
    sender: "@owner:test",
    event_id: "$event",
    origin_server_ts: 200,
    content: { msgtype: "m.text", body: "hello" },
  };
  it("accepts only a new text event from the owner in the bound room", () => {
    expect(
      eligibleAgentMessage(row, row.room_id, event, "@owner:test", 100),
    ).toBe(true);
    expect(
      eligibleAgentMessage(
        row,
        row.room_id,
        { ...event, sender: "@other:test" },
        "@owner:test",
        100,
      ),
    ).toBe(false);
    expect(
      eligibleAgentMessage(row, "!other:test", event, "@owner:test", 100),
    ).toBe(false);
    expect(
      eligibleAgentMessage(
        row,
        row.room_id,
        { ...event, origin_server_ts: 99 },
        "@owner:test",
        100,
      ),
    ).toBe(false);
  });
  it("does not execute paused, edited, empty or file messages", () => {
    expect(
      eligibleAgentMessage(
        { ...row, status: "paused" },
        row.room_id,
        event,
        "@owner:test",
        100,
      ),
    ).toBe(false);
    for (const content of [
      { msgtype: "m.file", body: "file" },
      { msgtype: "m.text", body: " " },
      {
        msgtype: "m.text",
        body: "edit",
        "m.relates_to": { rel_type: "m.replace" },
      },
    ])
      expect(
        eligibleAgentMessage(
          row,
          row.room_id,
          { ...event, content },
          "@owner:test",
          100,
        ),
      ).toBe(false);
  });
  it("enforces a durable 20-call daily ceiling before network calls", () => {
    for (let i = 0; i < 20; i++)
      expect(reserveChatCall("test-agent", "2026-11-15")).toBe(true);
    expect(reserveChatCall("test-agent", "2026-11-15")).toBe(false);
    expect(reserveChatCall("test-agent", "2026-11-16")).toBe(true);
  });
  it("does not let other users update or open an Agent", async () => {
    db.prepare(
      `INSERT INTO chat_agents(id,owner_id,workspace_id,name,persona,provider,model,status,matrix_id,created_at,updated_at) VALUES('foreign',?,'workspace','Agent','','provider','model','paused','@agent:test','now','now')`,
    ).run(a);
    await expect(
      updateChatAgent(
        { user: { id: b }, workspaceId: "workspace" },
        "foreign",
        { paused: false },
      ),
    ).rejects.toThrow("不属于");
    await expect(openAgentRoom(b, "foreign")).rejects.toThrow("不属于");
  });
  it("requires the current role in the Agent model workspace", () => {
    db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(
      "workspace",
      "test",
      "now",
    );
    const agent = { owner_id: a, workspace_id: "workspace" };
    expect(ownerCanRun(agent)).toBe(false);
    db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
      "workspace",
      a,
      "viewer",
    );
    expect(ownerCanRun(agent)).toBe(false);
    db.prepare(
      "UPDATE memberships SET role='member' WHERE workspace_id='workspace' AND user_id=?",
    ).run(a);
    expect(ownerCanRun(agent)).toBe(true);
    db.prepare(
      "DELETE FROM memberships WHERE workspace_id=? AND user_id=?",
    ).run("workspace", a);
    expect(ownerCanRun(agent)).toBe(false);
  });
  it("rechecks pause AFTER the awaited Matrix membership response", async () => {
    db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
      "workspace",
      a,
      "owner",
    );
    db.prepare(
      "UPDATE chat_agents SET status='active',generation=0,room_id='!room:test' WHERE id='foreign'",
    ).run();
    const agent = db
      .prepare("SELECT * FROM chat_agents WHERE id='foreign'")
      .get() as any;
    let resolveMembers!: (members: any[]) => void;
    const client = {
      getRoomMembers: vi.fn(
        () =>
          new Promise<any[]>((resolve) => {
            resolveMembers = resolve;
          }),
      ),
      sendMessage: vi.fn(async () => "$sent"),
    };
    const live = {
      client,
      deliveries: new Set(),
      busy: true,
      after: 0,
      history: [],
    };
    const pending = publishAgentReply(agent, live as any, {
      msgtype: "m.text",
      body: "should not send",
    });
    db.prepare(
      "UPDATE chat_agents SET status='paused',generation=1 WHERE id='foreign'",
    ).run();
    resolveMembers([
      { membership: "join", membershipFor: agent.matrix_id },
      { membership: "join", membershipFor: localMatrixId(a) },
    ]);
    expect(await pending).toBe(false);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
  it("refuses publication when an unapproved invite exists", async () => {
    db.prepare(
      "UPDATE chat_agents SET status='active',generation=2 WHERE id='foreign'",
    ).run();
    const agent = db
      .prepare("SELECT * FROM chat_agents WHERE id='foreign'")
      .get() as any;
    const client = {
      getRoomMembers: vi.fn(async () => [
        { membership: "join", membershipFor: agent.matrix_id },
        { membership: "join", membershipFor: localMatrixId(a) },
        { membership: "invite", membershipFor: localMatrixId(b) },
      ]),
      sendMessage: vi.fn(),
    };
    expect(
      await publishAgentReply(agent, { client, deliveries: new Set() } as any, {
        msgtype: "m.text",
        body: "private",
      }),
    ).toBe(false);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
