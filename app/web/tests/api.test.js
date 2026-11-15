import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, request, setUnauthenticatedHandler } from "../src/api/http.js";
import * as routes from "../src/api/routes.js";

const ID = "0b9c1c6e-0000-4000-8000-000000000001";
const ID2 = "0b9c1c6e-0000-4000-8000-000000000002";

let fetchMock;
function reply(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  fetchMock = vi.fn(async () => reply(200, { ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  setUnauthenticatedHandler(null);
  vi.unstubAllGlobals();
});

// [name, call, method, path, body]  (body undefined: no body and no content type)
const table = [
  ["register", () => routes.register({ email: "a@b.test", password: "pppppppppp", displayName: "A", handle: "alice" }), "POST", "/api/register", { email: "a@b.test", password: "pppppppppp", displayName: "A", handle: "alice" }],
  ["signIn", () => routes.signIn({ email: "a@b.test", password: "x" }), "POST", "/api/auth/sign-in/email", { email: "a@b.test", password: "x" }],
  ["signOut", () => routes.signOut(), "POST", "/api/auth/sign-out", undefined],
  ["verifyEmail", () => routes.verifyEmail("t k"), "GET", "/api/auth/verify-email?token=t+k", undefined],
  ["requestPasswordReset", () => routes.requestPasswordReset({ email: "a@b.test" }), "POST", "/api/auth/request-password-reset", { email: "a@b.test" }],
  ["resetPassword", () => routes.resetPassword({ newPassword: "n", token: "t" }), "POST", "/api/auth/reset-password", { newPassword: "n", token: "t" }],
  ["getMe", () => routes.getMe(), "GET", "/api/me", undefined],
  ["updateMe", () => routes.updateMe("新名字"), "PATCH", "/api/me", { displayName: "新名字" }],
  ["lookupPrincipal", () => routes.lookupPrincipal("bob"), "GET", "/api/principals/lookup?handle=bob", undefined],
  ["getSocial", () => routes.getSocial(), "GET", "/api/social", undefined],
  ["sendFriendRequest", () => routes.sendFriendRequest("bob"), "POST", "/api/friend-requests", { handle: "bob" }],
  ["getFriendRequest", () => routes.getFriendRequest(ID), "GET", `/api/friend-requests/${ID}`, undefined],
  ["acceptFriendRequest", () => routes.acceptFriendRequest(ID), "POST", `/api/friend-requests/${ID}/accept`, undefined],
  ["rejectFriendRequest", () => routes.rejectFriendRequest(ID), "POST", `/api/friend-requests/${ID}/reject`, undefined],
  ["withdrawFriendRequest", () => routes.withdrawFriendRequest(ID), "POST", `/api/friend-requests/${ID}/withdraw`, undefined],
  ["removeFriend", () => routes.removeFriend(ID), "DELETE", `/api/friends/${ID}`, undefined],
  ["blockPrincipal", () => routes.blockPrincipal(ID), "PUT", `/api/blocks/${ID}`, undefined],
  ["unblockPrincipal", () => routes.unblockPrincipal(ID), "DELETE", `/api/blocks/${ID}`, undefined],
  ["createGroup", () => routes.createGroup({ title: "team", memberIds: [ID, ID2] }), "POST", "/api/conversations", { title: "team", memberIds: [ID, ID2] }],
  ["getConversation", () => routes.getConversation(ID), "GET", `/api/conversations/${ID}`, undefined],
  ["renameGroup", () => routes.renameGroup(ID, "new"), "PATCH", `/api/conversations/${ID}`, { title: "new" }],
  ["listMembers", () => routes.listMembers(ID), "GET", `/api/conversations/${ID}/members`, undefined],
  ["addMember", () => routes.addMember(ID, ID2), "POST", `/api/conversations/${ID}/members`, { principalId: ID2 }],
  ["removeMember", () => routes.removeMember(ID, ID2), "DELETE", `/api/conversations/${ID}/members/${ID2}`, undefined],
  ["sendMessage", () => routes.sendMessage(ID, { text: "hi", replyToSeq: 3, clientTxn: "tx_1" }), "POST", `/api/conversations/${ID}/messages`, { text: "hi", replyToSeq: 3, clientTxn: "tx_1" }],
  ["sendMessage (file)", () => routes.sendMessage(ID, { attachmentId: ID2, clientTxn: "tx_2" }), "POST", `/api/conversations/${ID}/messages`, { attachmentId: ID2, clientTxn: "tx_2" }],
  ["listMessages", () => routes.listMessages(ID), "GET", `/api/conversations/${ID}/messages`, undefined],
  ["listMessages (page)", () => routes.listMessages(ID, { before: 31, limit: 30 }), "GET", `/api/conversations/${ID}/messages?before=31&limit=30`, undefined],
  ["getMessage", () => routes.getMessage(ID, 7), "GET", `/api/conversations/${ID}/messages/7`, undefined],
  ["markRead", () => routes.markRead(ID, 12), "POST", `/api/conversations/${ID}/read`, { seq: 12 }],
  ["getSync", () => routes.getSync(), "GET", "/api/sync", undefined],
  ["catchUp", () => routes.catchUp({ [ID]: 4 }), "POST", "/api/sync/catchup", { positions: { [ID]: 4 } }],
  ["requestWsTicket", () => routes.requestWsTicket(), "POST", "/api/ws-ticket", undefined],
  ["searchConversation", () => routes.searchConversation(ID, { q: "100% 报告" }), "GET", `/api/conversations/${ID}/search?q=100%25+%E6%8A%A5%E5%91%8A`, undefined],
  ["searchConversation (page)", () => routes.searchConversation(ID, { q: "a", before: 9, limit: 20 }), "GET", `/api/conversations/${ID}/search?q=a&before=9&limit=20`, undefined],
  ["searchAll", () => routes.searchAll({ q: "a" }), "GET", "/api/search?q=a", undefined],
  ["searchAll (cursor)", () => routes.searchAll({ q: "a", before: "cur+sor/=", limit: 5 }), "GET", "/api/search?q=a&before=cur%2Bsor%2F%3D&limit=5", undefined],
];

describe("routes.js builds the service's method, path and body", () => {
  it.each(table)("%s", async (_name, call, method, path, body) => {
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(path);
    expect(init.method).toBe(method);
    expect(init.credentials).toBe("same-origin");
    if (body === undefined) {
      expect(init.body).toBeUndefined();
      expect(init.headers["Content-Type"]).toBeUndefined();
    } else {
      expect(JSON.parse(init.body)).toEqual(body);
      expect(init.headers["Content-Type"]).toBe("application/json");
    }
  });

  it("encodes path segments", async () => {
    await routes.getMessage("a/b", 1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/a%2Fb/messages/1");
  });
});

describe("URL builders", () => {
  it("builds attachment and avatar URLs", () => {
    expect(routes.attachmentUploadUrl(ID)).toBe(`/api/conversations/${ID}/attachments`);
    expect(routes.attachmentUrl(ID)).toBe(`/api/attachments/${ID}`);
    expect(routes.avatarUrl(ID)).toBe(`/api/principals/${ID}/avatar`);
    expect(routes.myAvatarUploadUrl()).toBe("/api/me/avatar");
  });

  it("derives ws: or wss: from the page's own location", () => {
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:5273" });
    expect(routes.socketUrl("t+1")).toBe("ws://127.0.0.1:5273/api/ws?ticket=t%2B1");
    vi.stubGlobal("location", { protocol: "https:", host: "family.example" });
    expect(routes.socketUrl("abc")).toBe("wss://family.example/api/ws?ticket=abc");
  });
});

describe("ApiError mapping", () => {
  it("maps {error, reason} bodies", async () => {
    fetchMock.mockResolvedValue(reply(403, { error: "cannot_send", reason: "blocked" }));
    const err = await request("POST", "/api/x", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: "cannot_send", reason: "blocked" });
  });

  it("maps a body without a reason, including busy", async () => {
    fetchMock.mockResolvedValue(reply(503, { error: "busy" }));
    await expect(request("GET", "/api/search")).rejects.toMatchObject({ status: 503, code: "busy", reason: null });
  });

  it("falls back to unknown for a non-JSON error body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(request("GET", "/api/me")).rejects.toMatchObject({ status: 502, code: "unknown", reason: null });
  });

  it("maps a failed fetch to status 0 network_error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(request("GET", "/api/me")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("returns parsed JSON on success", async () => {
    fetchMock.mockResolvedValue(reply(201, { id: ID }));
    await expect(request("POST", "/api/conversations", {})).resolves.toEqual({ id: ID });
  });
});

describe("401 handler", () => {
  it("is called once per 401 and the ApiError is still thrown", async () => {
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    fetchMock.mockImplementation(async () => reply(401, { error: "unauthenticated" }));
    await expect(request("GET", "/api/me")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(request("GET", "/api/sync")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("is not called for other errors, and a throwing handler does not replace the ApiError", async () => {
    const handler = vi.fn(() => {
      throw new Error("boom");
    });
    setUnauthenticatedHandler(handler);
    fetchMock.mockResolvedValue(reply(403, { error: "forbidden" }));
    await expect(request("GET", "/api/me")).rejects.toMatchObject({ code: "forbidden" });
    expect(handler).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(reply(401, { error: "unauthenticated" }));
    await expect(request("GET", "/api/me")).rejects.toMatchObject({ code: "unauthenticated" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
