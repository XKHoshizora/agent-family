import type { FastifyInstance } from "fastify";
import { describe, expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { onSessionEnded } from "../src/auth/auth.ts";
import { createInvite, hashInviteCode } from "../src/auth/invites.ts";
import { api, cookieHeaderFrom, mailLink, signIn, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

const PASSWORD = "correct horse battery";

describe("accounts", () => {
  const { app, db } = useApp();

  async function register(body: Record<string, unknown>, target: FastifyInstance = app) {
    return api(target, null, "POST", "/api/register", {
      email: "new@example.test",
      password: PASSWORD,
      displayName: "New Person",
      handle: "new_person",
      ...body,
    });
  }

  const invite = (ttlHours = 1) => createInvite(db, { ttlHours });
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);

  /** Same app wiring, different config; shares the test pool (so closing it leaves the pool open). */
  async function appWith(config: Partial<typeof app.deps.config>): Promise<FastifyInstance> {
    const built = await buildApp({ config: { ...app.deps.config, ...config }, db: app.deps.db });
    await built.ready();
    return built;
  }

  test("register sends a verification mail, sign-in is refused until the link is followed, then /api/me works", async () => {
    const code = await invite();
    expect(await register({ inviteCode: code })).toEqual({ status: 201, json: { ok: true } });
    expect(
      await count("select count(*) n from mail_outbox where recipient = 'new@example.test' and kind = 'verify_email'"),
    ).toBe(1);

    const early = await signIn(app, "new@example.test", PASSWORD);
    expect(early.statusCode).toBe(403);
    expect(early.headers["set-cookie"]).toBeUndefined();

    const verify = await app.inject({ method: "GET", url: await mailLink(app, "new@example.test", "verify_email") });
    expect(verify.statusCode).toBeLessThan(400);

    const ok = await signIn(app, "new@example.test", PASSWORD);
    expect(ok.statusCode).toBe(200);
    const me = await api(app, { cookie: cookieHeaderFrom(ok.headers["set-cookie"]) }, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ handle: "new_person", displayName: "New Person", email: "new@example.test" });
    expect(Object.keys(me.json).sort()).toEqual(["displayName", "email", "handle", "id"]);
  });

  test("register without an invite code is refused", async () => {
    expect(await register({})).toEqual({ status: 400, json: { error: "invalid_invite" } });
  });

  test("register with an unknown invite code is refused", async () => {
    expect(await register({ inviteCode: "does-not-exist-00000" })).toEqual({
      status: 400,
      json: { error: "invalid_invite" },
    });
  });

  test("register with an expired invite code is refused", async () => {
    const code = await invite(-1);
    expect(await register({ inviteCode: code })).toEqual({ status: 400, json: { error: "invalid_invite" } });
  });

  test("register with a used invite code is refused", async () => {
    const code = await invite();
    expect((await register({ inviteCode: code })).status).toBe(201);
    const second = await register({ inviteCode: code, email: "other@example.test", handle: "other_person" });
    expect(second).toEqual({ status: 400, json: { error: "invalid_invite" } });
    expect(await count("select count(*) n from principals")).toBe(1);
  });

  test("invite codes are 20 characters and only their SHA-256 is stored", async () => {
    const code = await invite();
    expect(code).toMatch(/^[A-Za-z0-9_-]{20}$/);
    const { rows } = await db.query("select code_hash from invites");
    expect(rows).toEqual([{ code_hash: hashInviteCode(code) }]);
  });

  test("with REGISTRATION_MODE=open no invite code is needed", async () => {
    const open = await appWith({ registrationMode: "open" });
    try {
      expect((await register({}, open)).status).toBe(201);
    } finally {
      await open.close();
    }
  });

  test("a handle that is already taken is refused with 409 and leaves nothing behind", async () => {
    await signUp(app, "taken_one");
    const code = await invite();
    const res = await register({ inviteCode: code, email: "late@example.test", handle: "taken_one" });
    expect(res).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect(await count(`select count(*) n from "user" where email = 'late@example.test'`)).toBe(0);
    expect(await count("select count(*) n from invites where used_by is null")).toBe(1);
  });

  test("a 9 character password is refused", async () => {
    const res = await register({ inviteCode: await invite(), password: "123456789" });
    expect(res).toEqual({ status: 400, json: { error: "invalid_request" } });
    expect(await count(`select count(*) n from "user"`)).toBe(0);
  });

  test("a malformed body is refused with 400 before any handler code runs", async () => {
    expect((await register({ handle: "Not Valid!", inviteCode: await invite() })).status).toBe(400);
    expect((await register({ email: "not-an-email", inviteCode: await invite() })).status).toBe(400);
    expect((await api(app, null, "POST", "/api/register", { handle: "x" })).status).toBe(400);
  });

  test("a taken e-mail gets the same 201, creates nothing, consumes no invite and sends no mail", async () => {
    const first = await signUp(app, "first_owner");
    const mailBefore = await count("select count(*) n from mail_outbox");
    const code = await invite();
    const res = await register({ inviteCode: code, email: first.email, handle: "second_try" });
    expect(res).toEqual({ status: 201, json: { ok: true } });
    expect(await count("select count(*) n from principals")).toBe(1);
    expect(await count(`select count(*) n from "user"`)).toBe(1);
    expect(await count("select count(*) n from invites where used_by is null")).toBe(1);
    expect(await count("select count(*) n from mail_outbox")).toBe(mailBefore);
    // the invite is still good for a different address
    expect((await register({ inviteCode: code, email: "fresh@example.test", handle: "fresh_one" })).status).toBe(201);
  });

  test("registration is atomic: a failure after the auth user is written leaves no user, account, mail or used invite", async () => {
    await db.query(
      "create function test_fail_principal() returns trigger language plpgsql as 'begin raise exception ''boom''; end'",
    );
    await db.query(
      "create trigger test_fail before insert on principals for each row execute function test_fail_principal()",
    );
    try {
      const code = await invite();
      const res = await register({ inviteCode: code });
      expect(res.status).toBe(500);
    } finally {
      await db.query("drop trigger test_fail on principals");
      await db.query("drop function test_fail_principal()");
    }
    expect(await count(`select count(*) n from "user"`)).toBe(0);
    expect(await count(`select count(*) n from "account"`)).toBe(0);
    expect(await count("select count(*) n from mail_outbox")).toBe(0);
    expect(await count("select count(*) n from principals")).toBe(0);
    expect(await count("select count(*) n from invites where used_by is null")).toBe(1);
  });

  test("Better Auth's own sign-up endpoint is not reachable (it would bypass invites)", async () => {
    const res = await api(app, null, "POST", "/api/auth/sign-up/email", {
      name: "Sneaky",
      email: "sneaky@example.test",
      password: PASSWORD,
    });
    expect(res).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await count(`select count(*) n from "user"`)).toBe(0);
  });

  test("password reset answers identically for a registered and an unregistered address, and mails only the registered one", async () => {
    const a = await signUp(app, "reset_known");
    const known = await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
    const unknown = await api(app, null, "POST", "/api/auth/request-password-reset", { email: "nobody@example.test" });
    expect(known.status).toBe(200);
    expect(unknown).toEqual(known);
    expect(
      await count("select count(*) n from mail_outbox where kind = 'reset_password' and recipient = $1", [a.email]),
    ).toBe(1);
    expect(await count("select count(*) n from mail_outbox where kind = 'reset_password'")).toBe(1);
  });

  async function resetToken(email: string): Promise<string> {
    const link = await mailLink(app, email, "reset_password");
    return new URLSearchParams(link.split("?")[1]).get("token")!;
  }

  test("a reset link works once, a second use is refused, and the old session is revoked", async () => {
    const a = await signUp(app, "reset_flow");
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);
    await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
    const token = await resetToken(a.email);

    const newPassword = "an entirely new password";
    const first = await api(app, null, "POST", "/api/auth/reset-password", { newPassword, token });
    expect(first.status).toBe(200);
    const second = await api(app, null, "POST", "/api/auth/reset-password", {
      newPassword: "yet another password",
      token,
    });
    expect(second.status).toBe(400);

    expect((await api(app, a, "GET", "/api/me")).status).toBe(401);
    expect((await signIn(app, a.email, a.password)).statusCode).toBe(401);
    expect((await signIn(app, a.email, newPassword)).statusCode).toBe(200);
  });

  test("sign-out invalidates the session cookie", async () => {
    const a = await signUp(app, "signs_out");
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);
    expect((await api(app, a, "POST", "/api/auth/sign-out", {})).status).toBe(200);
    expect(await api(app, a, "GET", "/api/me")).toEqual({ status: 401, json: { error: "unauthenticated" } });
  });

  test("/api/me without a session is 401 unauthenticated", async () => {
    expect(await api(app, null, "GET", "/api/me")).toEqual({ status: 401, json: { error: "unauthenticated" } });
  });

  test("a session of a user whose e-mail is not verified is refused", async () => {
    const a = await signUp(app, "unverified_later");
    await db.query(`update "user" set "emailVerified" = false`);
    expect(await api(app, a, "GET", "/api/me")).toEqual({ status: 401, json: { error: "unauthenticated" } });
  });

  test("onSessionEnded fires on sign-out, and on password reset once for every session of the user", async () => {
    const a = await signUp(app, "notify_me");
    const ended: Array<[string, string]> = [];
    const off = onSessionEnded((principalId, sessionId) => ended.push([principalId, sessionId]));
    try {
      await api(app, a, "POST", "/api/auth/sign-out", {});
      expect(ended).toHaveLength(1);
      expect(ended[0]![0]).toBe(a.id);
      expect(ended[0]![1]).toBeTruthy();

      ended.length = 0;
      const s1 = cookieHeaderFrom((await signIn(app, a.email, a.password)).headers["set-cookie"]);
      const s2 = cookieHeaderFrom((await signIn(app, a.email, a.password)).headers["set-cookie"]);
      expect(s1).not.toBe(s2);
      await api(app, null, "POST", "/api/auth/request-password-reset", { email: a.email });
      const token = await resetToken(a.email);
      const reset = await api(app, null, "POST", "/api/auth/reset-password", { newPassword: "brand new password", token });
      expect(reset.status).toBe(200);
      expect(ended).toHaveLength(2);
      expect(ended.every(([p]) => p === a.id)).toBe(true);
      expect(new Set(ended.map(([, s]) => s)).size).toBe(2);
    } finally {
      off();
    }
  });

  test("the 11th sign-in attempt within a minute from one address is 429 rate_limited; another address is unaffected", async () => {
    const strict = await appWith({ rateLimitScale: 1 });
    try {
      const attempt = (remoteAddress: string, headers: Record<string, string> = {}) =>
        strict.inject({
          method: "POST",
          url: "/api/auth/sign-in/email",
          remoteAddress,
          headers,
          payload: { email: "nobody@example.test", password: "whatever password" },
        });
      for (let i = 0; i < 10; i++) expect((await attempt("10.0.0.1")).statusCode).toBe(401);
      const blocked = await attempt("10.0.0.1");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toEqual({ error: "rate_limited" });
      // a client-supplied X-Forwarded-For must not let the same address dodge the limit
      expect((await attempt("10.0.0.1", { "x-forwarded-for": "203.0.113.9" })).statusCode).toBe(429);
      expect((await attempt("10.0.0.2")).statusCode).toBe(401);
    } finally {
      await strict.close();
    }
  });

  test("/api/register and the reset request are limited to 10 per minute per address too", async () => {
    const strict = await appWith({ rateLimitScale: 1 });
    try {
      for (let i = 0; i < 10; i++) expect((await register({}, strict)).status).toBe(400);
      expect((await register({}, strict)).status).toBe(429);
      const reset = () => api(strict, null, "POST", "/api/auth/request-password-reset", { email: "x@example.test" });
      for (let i = 0; i < 10; i++) expect((await reset()).status).toBe(200);
      expect((await reset()).status).toBe(429);
    } finally {
      await strict.close();
    }
  });

  test("a wrong password takes about as long for an existing as for a non-existing e-mail", async () => {
    const a = await signUp(app, "timing_known");
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    const time = async (email: string) => {
      const t0 = performance.now();
      const res = await signIn(app, email, "definitely the wrong one");
      const dt = performance.now() - t0;
      expect(res.statusCode).toBe(401);
      return dt;
    };
    await time(a.email); // warm up both paths
    await time("ghost@example.test");
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 15; i++) {
      // interleaved so drift in machine load hits both samples alike
      known.push(await time(a.email));
      unknown.push(await time(`ghost${i}@example.test`));
    }
    const ratio = Math.max(median(known), median(unknown)) / Math.min(median(known), median(unknown));
    expect(ratio).toBeLessThan(3);
  });
});
