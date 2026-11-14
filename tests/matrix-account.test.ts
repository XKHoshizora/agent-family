/**
 * Matrix account provisioning: unit tests of provisionMatrixAccount with an injected
 * request function, and route tests through createApp() with REAL Better Auth cookies.
 * Every network call is a mocked fetch; nothing leaves the process.
 */
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
vi.hoisted(() => {
  process.env.DATA_DIR = `${process.env.TEMP || "/tmp"}/agent-family-matrix-${process.pid}-${Date.now()}`;
  process.env.CANAL_KEY_FILE = `${process.env.DATA_DIR}/no-key.txt`;
  process.env.CANAL_API_KEY = "";
  process.env.APP_URL = "http://localhost:4317";
  process.env.TEST_MODE = "true";
});
import crypto from "node:crypto";
import { createApp } from "../server/app";
import { db } from "../server/db";
import { auth } from "../server/auth";
import {
  matrixLocalpart,
  registrationMac,
  provisionMatrixAccount,
  matrixOptions,
} from "../server/matrix-account";

const ORIGIN = "http://localhost:4317";
const PASSWORD = "Test-password-123!";
const SECRET = "SHARED-REGISTRATION-SECRET-do-not-leak";
const HS = "https://matrix.example.test";
const OPTIONS = {
  homeserver: HS,
  serverName: "example.test",
  elementUrl: "https://chat.example.test",
  registrationSecret: SECRET,
};
const MATRIX_ENV = {
  MATRIX_HOMESERVER_URL: HS,
  MATRIX_SERVER_NAME: "example.test",
  MATRIX_ELEMENT_URL: "https://chat.example.test",
  MATRIX_REGISTRATION_SECRET: SECRET,
};
type Seen = { url: string; init: any; body: any };
/** Fake Synapse. `mode` drives the register outcome; `loginAs` the login outcome. */
function fakeSynapse(opts: {
  register?: "ok" | "in_use" | "forbidden" | "wrong_id";
  existingPassword?: string;
  loginUserId?: string;
  nonceStatus?: number;
  gate?: Promise<void>;
}) {
  const seen: Seen[] = [];
  const nonces = new Set<string>();
  const fn = vi.fn(async (url: any, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    seen.push({ url: String(url), init, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const path = String(url).replace(HS, "");
    if (
      path === "/_synapse/admin/v1/register" &&
      (init.method || "GET") === "GET"
    ) {
      if (opts.gate) await opts.gate;
      if (opts.nonceStatus)
        return json(opts.nonceStatus, {
          errcode: "M_UNKNOWN",
          error: "SYNAPSE-INTERNAL-DETAIL",
        });
      const nonce = crypto.randomBytes(8).toString("hex");
      nonces.add(nonce);
      return json(200, { nonce });
    }
    if (path === "/_synapse/admin/v1/register") {
      // Real Synapse semantics: nonce single use, MAC over nonce\0user\0password\0notadmin.
      if (!nonces.delete(body.nonce))
        return json(400, { errcode: "M_UNKNOWN", error: "unrecognised nonce" });
      const expected = crypto
        .createHmac("sha1", SECRET)
        .update(
          `${body.nonce}\0${body.username}\0${body.password}\0${body.admin ? "admin" : "notadmin"}`,
        )
        .digest("hex");
      if (body.mac !== expected)
        return json(403, { errcode: "M_FORBIDDEN", error: "HMAC incorrect" });
      if (opts.register === "in_use")
        return json(400, {
          errcode: "M_USER_IN_USE",
          error: "User ID already taken.",
        });
      if (opts.register === "forbidden")
        return json(403, {
          errcode: "M_FORBIDDEN",
          error: "SYNAPSE-INTERNAL-DETAIL",
        });
      const userId =
        opts.register === "wrong_id"
          ? "@admin:example.test"
          : `@${body.username}:example.test`;
      return json(200, {
        user_id: userId,
        access_token: "SYNAPSE-ACCESS-TOKEN",
        device_id: "D",
      });
    }
    if (path === "/_matrix/client/v3/login") {
      const expectedUser = opts.loginUserId ?? body.identifier.user;
      if (body.password !== opts.existingPassword)
        return json(403, { errcode: "M_FORBIDDEN", error: "Invalid password" });
      return json(200, {
        user_id: expectedUser,
        access_token: "LOGIN-ACCESS-TOKEN",
        device_id: "D2",
      });
    }
    if (path === "/_matrix/client/v3/logout") return json(200, {});
    return json(404, { errcode: "M_UNRECOGNIZED" });
  });
  return { fn, seen };
}

describe("provisionMatrixAccount (unit, injected fetch)", () => {
  const uid = "user-123";
  const expectedId = `@${matrixLocalpart(uid)}:example.test`;

  it("derives a deterministic, opaque, per-user localpart", () => {
    expect(matrixLocalpart(uid)).toBe(matrixLocalpart(uid));
    expect(matrixLocalpart(uid)).toMatch(/^af_[0-9a-f]{24}$/);
    expect(matrixLocalpart(uid)).not.toBe(matrixLocalpart("user-124"));
    expect(matrixLocalpart(uid)).not.toContain(uid);
  });

  it("computes the Synapse shared-secret MAC (non-admin) and it binds secret and password", () => {
    const mac = registrationMac(SECRET, "n1", "af_x", "pw-123456789012");
    expect(mac).toBe(
      crypto
        .createHmac("sha1", SECRET)
        .update("n1\0af_x\0pw-123456789012\0notadmin")
        .digest("hex"),
    );
    expect(
      registrationMac("other-secret", "n1", "af_x", "pw-123456789012"),
    ).not.toBe(mac);
    expect(registrationMac(SECRET, "n1", "af_x", "pw-different-0000")).not.toBe(
      mac,
    );
  });

  it("registers a non-admin account; the shared secret is never transmitted and no token is returned", async () => {
    const s = fakeSynapse({ register: "ok" });
    const result = await provisionMatrixAccount(
      OPTIONS,
      uid,
      "Alice",
      "correct-horse-battery",
      s.fn as any,
    );
    expect(result).toBe(expectedId);
    const post = s.seen.find((x) => x.init.method === "POST")!;
    expect(post.body.admin).toBe(false);
    expect(post.body.username).toBe(matrixLocalpart(uid));
    expect(post.body.inhibit_login).toBe(true);
    for (const x of s.seen) {
      expect(x.url.startsWith(HS + "/")).toBe(true);
      expect(x.init.redirect).toBe("error");
      expect(JSON.stringify(x)).not.toContain(SECRET);
    }
    expect(JSON.stringify(result)).not.toContain("ACCESS-TOKEN");
  });

  it("rejects a homeserver that answers with a different identity", async () => {
    const s = fakeSynapse({ register: "wrong_id" });
    await expect(
      provisionMatrixAccount(
        OPTIONS,
        uid,
        "Alice",
        "correct-horse-battery",
        s.fn as any,
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("fails closed (502) when the nonce endpoint or registration fails, without leaking upstream detail or trying login", async () => {
    for (const s of [
      fakeSynapse({ nonceStatus: 500 }),
      fakeSynapse({ register: "forbidden" }),
    ]) {
      const err: any = await provisionMatrixAccount(
        OPTIONS,
        uid,
        "Alice",
        "correct-horse-battery",
        s.fn as any,
      ).catch((e) => e);
      expect(err.statusCode).toBe(502);
      expect(err.message).not.toContain("SYNAPSE-INTERNAL-DETAIL");
      expect(s.seen.some((x) => x.url.includes("/login"))).toBe(false);
    }
  });

  it("existing identity: retry only succeeds with password proof, never resets the account", async () => {
    const wrong = fakeSynapse({
      register: "in_use",
      existingPassword: "the-original-password",
    });
    await expect(
      provisionMatrixAccount(
        OPTIONS,
        uid,
        "Alice",
        "attacker-guess-0000",
        wrong.fn as any,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(wrong.seen.some((x) => x.url.includes("/logout"))).toBe(false);
    // No password-reset/admin endpoints are ever touched.
    expect(
      wrong.seen.every((x) =>
        /\/_synapse\/admin\/v1\/register$|\/_matrix\/client\/v3\/login$/.test(
          x.url,
        ),
      ),
    ).toBe(true);

    const right = fakeSynapse({
      register: "in_use",
      existingPassword: "the-original-password",
    });
    expect(
      await provisionMatrixAccount(
        OPTIONS,
        uid,
        "Alice",
        "the-original-password",
        right.fn as any,
      ),
    ).toBe(expectedId);
    const login = right.seen.find((x) => x.url.endsWith("/login"))!;
    expect(login.body.identifier).toEqual({
      type: "m.id.user",
      user: expectedId,
    });
    // The verification session is logged out again.
    const logout = right.seen.find((x) => x.url.endsWith("/logout"))!;
    expect(logout.init.headers.Authorization).toBe("Bearer LOGIN-ACCESS-TOKEN");
  });

  it("existing identity: a login that authenticates a DIFFERENT user is rejected", async () => {
    const s = fakeSynapse({
      register: "in_use",
      existingPassword: "the-original-password",
      loginUserId: "@someone-else:example.test",
    });
    await expect(
      provisionMatrixAccount(
        OPTIONS,
        uid,
        "Alice",
        "the-original-password",
        s.fn as any,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses non-HTTPS or credential-bearing endpoints", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, MATRIX_ENV, {
        MATRIX_HOMESERVER_URL: "http://matrix.example.test",
      });
      expect(() => matrixOptions()).toThrow();
      Object.assign(process.env, MATRIX_ENV, {
        MATRIX_HOMESERVER_URL: "https://user:pw@matrix.example.test",
      });
      expect(() => matrixOptions()).toThrow();
      Object.assign(process.env, MATRIX_ENV);
      expect(matrixOptions()).toMatchObject({ homeserver: HS });
      delete process.env.MATRIX_REGISTRATION_SECRET;
      expect(matrixOptions()).toBeNull();
    } finally {
      for (const k of Object.keys(MATRIX_ENV)) delete process.env[k];
      Object.assign(process.env, { ...saved });
    }
  });
});

describe("/api/matrix/account routes (real sessions, mocked fetch)", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  const U: Record<string, { cookie: string; id: string }> = {};
  let ip = 10;
  const noNetwork = vi.fn(async () => {
    throw new Error("UNEXPECTED NETWORK REQUEST IN TEST");
  });
  async function login(email: string) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN },
      payload: { email, password: PASSWORD },
      remoteAddress: `127.0.3.${ip++}`,
    });
    expect(r.statusCode).toBe(200);
    return r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  const call = (
    user: string | null,
    method: string,
    body?: unknown,
    extra: Record<string, any> = {},
  ) =>
    app.inject({
      method: method as any,
      url: "/api/matrix/account",
      headers: {
        origin: ORIGIN,
        ...(user ? { cookie: U[user].cookie } : {}),
        ...(extra.headers || {}),
      },
      remoteAddress: extra.ip || `10.20.0.${ip++}`,
      ...(body !== undefined ? { payload: body as any } : {}),
    });

  beforeAll(async () => {
    vi.stubGlobal("fetch", noNetwork);
    app = await createApp();
    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: { origin: ORIGIN },
      payload: {
        name: "Admin",
        email: "admin@matrix.test",
        password: PASSWORD,
      },
    });
    expect(setup.statusCode).toBe(201);
    U.admin = { cookie: await login("admin@matrix.test"), id: "" };
    const me = (
      await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: U.admin.cookie },
      })
    ).json();
    U.admin.id = me.user.id;
    for (const [key, role] of [
      ["alice", "member"],
      ["bob", "member"],
      ["viewer", "viewer"],
      ["carol", "member"],
    ] as const) {
      const a = await auth.api.signUpEmail({
        body: { email: `${key}@matrix.test`, name: key, password: PASSWORD },
      });
      db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
        me.workspace.id,
        a.user.id,
        role,
      );
      U[key] = { cookie: await login(`${key}@matrix.test`), id: a.user.id };
    }
  }, 60000);
  beforeEach(() => {
    for (const k of Object.keys(MATRIX_ENV)) delete process.env[k];
    vi.stubGlobal("fetch", noNetwork);
    noNetwork.mockClear();
  });
  afterAll(async () => {
    for (const k of Object.keys(MATRIX_ENV)) delete process.env[k];
    await app?.close();
    vi.unstubAllGlobals();
  });

  it("requires a session, a trusted Origin and a writable role before any network call", async () => {
    Object.assign(process.env, MATRIX_ENV);
    const s = fakeSynapse({ register: "ok" });
    vi.stubGlobal("fetch", s.fn);
    expect((await call(null, "GET")).statusCode).toBe(401);
    expect(
      (await call(null, "POST", { password: "long-enough-password" }))
        .statusCode,
    ).toBe(401);
    // Cross-site POST with a valid cookie is refused by the origin guard.
    const noOrigin = await app.inject({
      method: "POST",
      url: "/api/matrix/account",
      headers: { cookie: U.alice.cookie },
      payload: { password: "long-enough-password" },
    });
    expect(noOrigin.statusCode).toBe(403);
    const evil = await call(
      "alice",
      "POST",
      { password: "long-enough-password" },
      { headers: { origin: "https://evil.example" } },
    );
    expect(evil.statusCode).toBe(403);
    expect(
      (await call("viewer", "POST", { password: "long-enough-password" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call("alice", "POST", { password: "short" })).statusCode,
    ).toBe(400);
    expect(
      (await call("alice", "POST", { password: "has\0nul-byte-inside" }))
        .statusCode,
    ).toBe(400);
    expect(s.fn).not.toHaveBeenCalled();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM matrix_accounts").get(),
    ).toEqual({ n: 0 });
  });

  it("reports unconfigured honestly and does not call out", async () => {
    const get = await call("alice", "GET");
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      configured: false,
      account: null,
      agentAutomation: false,
    });
    expect(
      (await call("alice", "POST", { password: "long-enough-password" }))
        .statusCode,
    ).toBe(503);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("creates the account only for the authenticated user; secret/password/token never returned or stored", async () => {
    Object.assign(process.env, MATRIX_ENV);
    const s = fakeSynapse({ register: "ok" });
    vi.stubGlobal("fetch", s.fn);
    // Bob tries to smuggle Alice's user id / a chosen username in the body.
    const r = await call("bob", "POST", {
      password: "bobs-own-password-1",
      userId: U.alice.id,
      username: "admin",
      matrixId: "@admin:example.test",
    });
    expect(r.statusCode, r.body).toBe(200);
    const bobId = `@${matrixLocalpart(U.bob.id)}:example.test`;
    expect(r.json()).toEqual({ matrixId: bobId });
    const reg = s.seen.find((x) => x.init.method === "POST")!;
    expect(reg.body.username).toBe(matrixLocalpart(U.bob.id));
    for (const text of [r.body, (await call("bob", "GET")).body]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("bobs-own-password-1");
      expect(text).not.toContain("ACCESS-TOKEN");
    }
    const stored =
      JSON.stringify(db.prepare("SELECT * FROM matrix_accounts").all()) +
      JSON.stringify(db.prepare("SELECT * FROM audit").all());
    expect(stored).not.toContain("bobs-own-password-1");
    expect(stored).not.toContain(SECRET);
    // Alice is unaffected and does not see Bob's account.
    expect((await call("alice", "GET")).json().account).toBeNull();
    expect((await call("bob", "GET")).json().account.matrixId).toBe(bobId);
  });

  it("existing account is returned without another upstream call; upstream errors are not leaked", async () => {
    Object.assign(process.env, MATRIX_ENV);
    const again = fakeSynapse({ register: "ok" });
    vi.stubGlobal("fetch", again.fn);
    const r = await call("bob", "POST", { password: "a-totally-different-pw" });
    expect(r.statusCode).toBe(200);
    expect(again.fn).not.toHaveBeenCalled();
    const bad = fakeSynapse({ register: "forbidden" });
    vi.stubGlobal("fetch", bad.fn);
    const e = await call("alice", "POST", { password: "alices-password-123" });
    expect(e.statusCode).toBe(502);
    expect(e.body).not.toContain("SYNAPSE-INTERNAL-DETAIL");
    expect(e.body).not.toContain(SECRET);
    expect((await call("alice", "GET")).json().account).toBeNull();
  });

  it("retry after an ambiguous earlier create: wrong password is refused, right password records the identity", async () => {
    Object.assign(process.env, MATRIX_ENV);
    const wrong = fakeSynapse({
      register: "in_use",
      existingPassword: "alice-original-password",
    });
    vi.stubGlobal("fetch", wrong.fn);
    const w = await call("alice", "POST", {
      password: "attacker-guess-password",
    });
    expect(w.statusCode).toBe(409);
    expect((await call("alice", "GET")).json().account).toBeNull();
    const right = fakeSynapse({
      register: "in_use",
      existingPassword: "alice-original-password",
    });
    vi.stubGlobal("fetch", right.fn);
    const ok = await call("alice", "POST", {
      password: "alice-original-password",
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.body).not.toContain("LOGIN-ACCESS-TOKEN");
    expect((await call("alice", "GET")).json().account.matrixId).toBe(
      `@${matrixLocalpart(U.alice.id)}:example.test`,
    );
  });

  it("concurrent creation for the same user is serialized (second request gets 409, one upstream registration)", async () => {
    Object.assign(process.env, MATRIX_ENV);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = fakeSynapse({ register: "ok", gate });
    vi.stubGlobal("fetch", s.fn);
    const first = call("carol", "POST", { password: "carol-password-123" });
    await new Promise((r) => setTimeout(r, 50));
    const second = await call("carol", "POST", {
      password: "carol-password-123",
    });
    expect(second.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
    const registrations = s.seen.filter(
      (x) =>
        x.init.method === "POST" &&
        x.url.endsWith("/_synapse/admin/v1/register"),
    );
    expect(
      registrations.length,
      JSON.stringify(s.seen.map((x) => [x.init.method, x.url])),
    ).toBe(1);
  });

  it("rate-limits account creation per client IP and X-Forwarded-For cannot reset it", async () => {
    Object.assign(process.env, MATRIX_ENV);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await call(
        "viewer",
        "POST",
        { password: "long-enough-password" },
        { ip: "10.30.0.1", headers: { "x-forwarded-for": `198.51.100.${i}` } },
      );
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 403)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
    expect(noNetwork).not.toHaveBeenCalled();
  });
});
