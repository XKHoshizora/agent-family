import net from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { appOriginCheck } from "../src/origin.ts";
import { api, befriend, cookieHeaderFrom, signIn, signUp, type Actor } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { listen } from "./helpers/ws.ts";

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

describe("the Origin check cannot be sidestepped", () => {
  it("by a percent-encoded or otherwise disguised path: 403 on a JSON route, the upload route and a Better Auth route", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    const evil = "https://evil.example.test";
    const send = (url: string, origin: string) =>
      call("POST", url, { who: a, origin, json: { text: "forged", clientTxn: `e${Math.random().toString(36).slice(2)}` } });
    const messagePaths = [
      `/%61pi/conversations/${dm}/messages`, // "a" escaped
      `/%61pi/conversations/${dm}/m%65ssages`,
      `/api/conversations/${dm}/%6d%65ssages`, // lower-case hex
      `/api/conversations/${dm}/%6D%65ssages`, // upper-case hex
      `/%61pi/conversations/${dm}/%6D%65ssages`, // mixed
      `//api/conversations/${dm}/messages`, // double slash
      `/api//conversations/${dm}/messages`,
    ];
    // The router decodes these: with the app's own Origin the encoded ones reach the handler...
    expect((await send(messagePaths[0]!, APP_ORIGIN)).statusCode).toBe(201);
    expect((await send(messagePaths[3]!, APP_ORIGIN)).statusCode).toBe(201);
    // ...and from a foreign origin every one of them is refused before any of that.
    for (const url of messagePaths) {
      const res = await send(url, evil);
      expect([url, res.statusCode, res.body]).toEqual([url, 403, FORBIDDEN]);
    }
    const patched = await call("PATCH", "/%61pi/me", { who: a, origin: evil, json: { displayName: "pwned" } });
    expect([patched.statusCode, patched.body]).toEqual([403, FORBIDDEN]);
    const uploaded = await call("POST", `/%61pi/conversations/${dm}/attachments`, {
      who: a,
      origin: evil,
      payload: multipart([{ name: "file", filename: "a.txt", type: "text/plain", data: "hello" }]),
      contentType: MULTIPART,
    });
    expect([uploaded.statusCode, uploaded.body]).toEqual([403, FORBIDDEN]);
    for (const url of ["/%61pi/auth/sign-out", "/api/auth/sign-%6Fut", "//api/auth/sign-out"]) {
      const res = await call("POST", url, { who: a, origin: evil, json: {} });
      expect([url, res.statusCode, res.body]).toEqual([url, 403, FORBIDDEN]);
    }

    expect(await count("select count(*) n from messages where kind = 'text'")).toBe(2); // only the two above
    expect((await api(app, a, "GET", "/api/me")).json.displayName).toBe("alice");
    expect(await count("select count(*) n from attachments")).toBe(0);
    expect((await api(app, a, "GET", "/api/me")).status).toBe(200); // still signed in
    // The auth allowlist matches the exact path: an encoded one is not an exposed endpoint even from the app.
    expect((await call("POST", "/%61pi/auth/sign-out", { who: a, origin: APP_ORIGIN, json: {} })).statusCode).toBe(404);
  });

  it("by a near-miss Origin: anything but the exact serialisation a browser sends for the app is refused", async () => {
    const a = await signUp(app, "alice");
    const verdicts: Array<[string, number]> = [
      [APP_ORIGIN, 200], // exactly the app: allowed
      ["http://LOCALHOST:5173", 403], // browsers serialise the host in lower case; this is not one of them
      ["HTTP://localhost:5173", 403],
      ["http://localhost:5173/", 403], // an origin has no path, not even "/"
      ["http://localhost:5173:5173", 403], // malformed
      ["null", 403], // opaque origin (sandboxed frame, file:, data:)
      ["", 403], // present but empty
      [" http://localhost:5173", 403],
    ];
    for (const [origin, status] of verdicts) {
      const res = await call("PATCH", "/api/me", { who: a, origin, json: { displayName: "Alice" } });
      expect([origin, res.statusCode]).toEqual([origin, status]);
    }
    // An explicit default port: a browser never sends one, so for an https app ":443" is not its origin.
    const check = appOriginCheck("https://app.example.test");
    expect(check("https://app.example.test")).toBe(true);
    expect(check("https://app.example.test:443")).toBe(false);
    expect(check("https://app.example.test/")).toBe(false);
    expect(check("https://APP.example.test")).toBe(false);
    expect(check(undefined)).toBe(false);

    // A repeated header, over a real connection: Node joins the values into a list, which is no origin.
    const { port } = await listen(app);
    const twice = await rawStatus(port, [
      "PATCH /api/me HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      `Cookie: ${a.cookie}`,
      `Origin: ${APP_ORIGIN}`,
      `Origin: ${APP_ORIGIN}`,
      "Content-Type: application/json",
      "Content-Length: 24",
      "Connection: close",
    ], '{"displayName":"Twice!"}');
    expect(twice).toBe(403);
    expect((await api(app, a, "GET", "/api/me")).json.displayName).toBe("Alice");
  });
});

/** Sends a hand-written HTTP/1.1 request and returns the response status. */
function rawStatus(port: number, head: string[], body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" }, () => socket.write(`${head.join("\r\n")}\r\n\r\n${body}`));
    let received = "";
    socket.on("data", (c) => {
      received += String(c);
      const line = /^HTTP\/1\.1 (\d{3})/.exec(received);
      if (line) {
        resolve(Number(line[1]));
        socket.destroy();
      }
    });
    socket.on("error", reject);
  });
}

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
        PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000",
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
