import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { api, befriend, cookieHeaderFrom, signIn, signUp, type Actor } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

const { blobs, files: blobFiles } = useProbeBlobs("af-origin-");
const { app, db } = useApp({ blobs });

const APP_ORIGIN = "http://localhost:5173"; // what useApp() configures
const FOREIGN = [
  "https://evil.test",
  "http://localhost:5173.evil.test", // look-alike suffix
  "https://localhost:5173", // other scheme
  "http://localhost:5174", // other port
  "null", // sandboxed frame, file: page
  `${APP_ORIGIN}, https://evil.test`, // a list is not the app's origin
];
const FORBIDDEN = '{"error":"forbidden"}';

type Method = "POST" | "PUT" | "PATCH" | "DELETE" | "GET";
function call(
  method: Method,
  url: string,
  { who, origin, json, payload, contentType }: { who?: Actor | null; origin?: string; json?: unknown; payload?: string | Buffer; contentType?: string } = {},
) {
  return app.inject({
    method,
    url,
    headers: {
      ...(who ? { cookie: who.cookie } : {}),
      ...(origin === undefined ? {} : { origin }),
      ...(contentType ? { "content-type": contentType } : {}),
    },
    ...(json !== undefined ? { payload: json as object } : payload !== undefined ? { payload } : {}),
  });
}
const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);

describe("state-changing requests from another origin", () => {
  it("are refused with 403 forbidden on JSON routes, before parsing or any handler; the app's origin and no Origin pass", async () => {
    const [a, b, c] = [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const { conversationId: dm } = await befriend(app, a, b);

    for (const origin of FOREIGN) {
      const cases: Array<[Method, string, unknown]> = [
        ["POST", "/api/friend-requests", { handle: c.handle }],
        ["PATCH", "/api/me", { displayName: "pwned" }],
        ["POST", `/api/conversations/${dm}/messages`, { text: "forged", clientTxn: "x1" }],
        ["PUT", `/api/blocks/${b.id}`, undefined],
        ["DELETE", `/api/friends/${b.id}`, undefined],
      ];
      for (const [method, url, json] of cases) {
        const res = await call(method, url, { who: a, origin, json });
        expect([origin, method, url, res.statusCode, res.body]).toEqual([origin, method, url, 403, FORBIDDEN]);
      }
      // Before body parsing (malformed JSON is not even looked at) and before authentication.
      const malformed = await call("POST", "/api/friend-requests", { who: a, origin, payload: "{not json", contentType: "application/json" });
      expect([malformed.statusCode, malformed.body]).toEqual([403, FORBIDDEN]);
      expect((await call("POST", "/api/friend-requests", { origin, json: { handle: c.handle } })).statusCode).toBe(403);
    }
    expect(await count("select count(*) n from friend_requests where status = 'pending'")).toBe(0);
    expect(await count("select count(*) n from messages where kind = 'text'")).toBe(0);
    expect(await count("select count(*) n from blocks")).toBe(0);
    expect((await api(app, a, "GET", "/api/me")).json.displayName).toBe("alice");

    // Reads are not affected; the app's own origin and no Origin at all behave as before.
    expect((await call("GET", "/api/me", { who: a, origin: "https://evil.test" })).statusCode).toBe(200);
    expect((await call("POST", `/api/conversations/${dm}/messages`, { who: a, origin: APP_ORIGIN, json: { text: "hi", clientTxn: "ok1" } })).statusCode).toBe(201);
    expect((await call("POST", `/api/conversations/${dm}/messages`, { who: a, json: { text: "hi", clientTxn: "ok2" } })).statusCode).toBe(201);
    expect((await call("PATCH", "/api/me", { who: a, origin: APP_ORIGIN, json: { displayName: "Alice" } })).statusCode).toBe(200);
    expect((await call("POST", "/api/friend-requests", { who: a, origin: APP_ORIGIN, json: { handle: c.handle } })).statusCode).toBe(201);
  });

  it("are refused on the multipart upload route; the app's origin and no Origin upload as before", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    const upload = (origin?: string) =>
      call("POST", `/api/conversations/${dm}/attachments`, {
        who: a,
        origin,
        payload: multipart([{ name: "file", filename: "a.txt", type: "text/plain", data: "hello" }]),
        contentType: MULTIPART,
      });
    for (const origin of FOREIGN) {
      const res = await upload(origin);
      expect([origin, res.statusCode, res.body]).toEqual([origin, 403, FORBIDDEN]);
    }
    expect(blobFiles()).toEqual([]);
    expect(await count("select count(*) n from pending_blobs")).toBe(0);
    expect(await count("select count(*) n from attachments")).toBe(0);
    expect((await upload(APP_ORIGIN)).statusCode).toBe(201);
    expect((await upload()).statusCode).toBe(201);
  });

  it("are refused on Better Auth routes (sign-out keeps the session); the app's origin and no Origin sign out", async () => {
    const a = await signUp(app, "alice");
    const second = async () => ({ ...a, cookie: cookieHeaderFrom((await signIn(app, a.email, a.password)).headers["set-cookie"]) });

    for (const origin of FOREIGN) {
      const res = await call("POST", "/api/auth/sign-out", { who: a, origin, json: {} });
      expect([origin, res.statusCode, res.body]).toEqual([origin, 403, FORBIDDEN]);
    }
    const foreignSignIn = await call("POST", "/api/auth/sign-in/email", { origin: "https://evil.test", json: { email: a.email, password: a.password } });
    expect(foreignSignIn.statusCode).toBe(403);
    expect(foreignSignIn.headers["set-cookie"]).toBeUndefined();
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200);

    expect((await call("POST", "/api/auth/sign-out", { who: a, origin: APP_ORIGIN, json: {} })).statusCode).toBe(200);
    expect((await api(app, a, "GET", "/api/me")).status).toBe(401);
    const other = await second();
    expect((await call("POST", "/api/auth/sign-out", { who: other, json: {} })).statusCode).toBe(200);
    expect((await api(app, other, "GET", "/api/me")).status).toBe(401);
  });
});

describe("session cookie", () => {
  let httpsApp: FastifyInstance | undefined;
  afterAll(async () => httpsApp?.close());

  it("is SameSite=Lax and HttpOnly; Secure only when the app origin is https (the tests run on http)", async () => {
    const a = await signUp(app, "alice");
    const res = await signIn(app, a.email, a.password);
    const cookie = String(([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.includes("session_token")));
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).not.toMatch(/; Secure/);

    // The same account through an app configured for https.
    httpsApp = await buildApp({
      config: loadConfig({
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
        APP_ORIGIN: "https://app.example.test",
        RATE_LIMIT_SCALE: "1000",
      }),
      db,
      blobs,
    });
    await httpsApp.ready();
    const secure = await httpsApp.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: "https://app.example.test" },
      payload: { email: a.email, password: a.password },
    });
    expect(secure.statusCode).toBe(200);
    const secureCookie = String(([] as string[]).concat(secure.headers["set-cookie"] ?? []).find((c) => c.includes("session_token")));
    expect(secureCookie).toMatch(/^__Secure-/);
    expect(secureCookie).toMatch(/; Secure/);
    expect(secureCookie).toMatch(/; SameSite=Lax/);
    expect(secureCookie).toMatch(/; HttpOnly/);
  });
});
