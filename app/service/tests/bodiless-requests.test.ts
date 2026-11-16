import { describe, expect, test } from "vitest";
import { api, befriend, cookieHeaderFrom, signIn, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";
import { afterEach } from "vitest";

const { app } = useApp();
afterEach(closeAllSockets);

/** The three ways a client may state "no fields": nothing at all, an empty JSON body, `{}`. */
const FORMS = {
  "no body and no content type": {},
  "an empty body with content-type: application/json": { headers: { "content-type": "application/json" }, payload: "" },
  "{}": { headers: { "content-type": "application/json" }, payload: "{}" },
} as const;

type Form = (typeof FORMS)[keyof typeof FORMS];

const send = (method: "POST" | "PUT" | "DELETE", url: string, actor: { cookie: string } | null, form: Form) =>
  app.inject({
    method,
    url,
    ...form,
    headers: { ...(actor ? { cookie: actor.cookie } : {}), ...("headers" in form ? form.headers : {}) },
  });

describe("requests that take no fields", () => {
  for (const [name, form] of Object.entries(FORMS)) {
    describe(name, () => {
      test("POST /api/auth/sign-out ends the session, closes its sockets and clears the cookie", async () => {
        const a = await signUp(app, "signs_out");
        const socket = await connect(app, a);
        const res = await send("POST", "/api/auth/sign-out", a, form);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: true });
        expect(await socket.closed).toEqual({ code: 4001, reason: "session_ended" });
        expect(await api(app, a, "GET", "/api/me")).toEqual({ status: 401, json: { error: "unauthenticated" } });
        const cleared = [res.headers["set-cookie"]].flat().join(";");
        expect(cleared).toMatch(/session_token=;/);
        expect(cleared).toMatch(/Max-Age=0/i);
      });

      test("POST /api/ws-ticket issues a ticket", async () => {
        const a = await signUp(app, "ticketer");
        const res = await send("POST", "/api/ws-ticket", a, form);
        expect(res.statusCode).toBe(200);
        expect(typeof res.json().ticket).toBe("string");
      });

      for (const decision of ["accept", "reject", "withdraw"] as const) {
        test(`POST /api/friend-requests/:id/${decision}`, async () => {
          const [a, b] = [await signUp(app, "asker"), await signUp(app, "answerer")];
          const sent = await api<{ id: string }>(app, a, "POST", "/api/friend-requests", { handle: b.handle });
          const res = await send("POST", `/api/friend-requests/${sent.json.id}/${decision}`, decision === "withdraw" ? a : b, form);
          expect(res.statusCode).toBe(200);
          expect(res.json()).toMatchObject({ ok: true });
        });
      }

      test("DELETE /api/friends/:id and PUT/DELETE /api/blocks/:id", async () => {
        const [a, b] = [await signUp(app, "one"), await signUp(app, "two")];
        await befriend(app, a, b);
        expect((await send("DELETE", `/api/friends/${b.id}`, a, form)).statusCode).toBe(200);
        expect((await send("PUT", `/api/blocks/${b.id}`, a, form)).statusCode).toBe(200);
        expect((await send("DELETE", `/api/blocks/${b.id}`, a, form)).statusCode).toBe(200);
      });
    });
  }

  test("a no-body request to an endpoint that requires fields is still 400", async () => {
    const a: Actor = await signUp(app, "needs_fields");
    for (const form of Object.values(FORMS).slice(0, 2)) {
      for (const url of ["/api/auth/sign-in/email", "/api/auth/request-password-reset", "/api/auth/reset-password"]) {
        const res = await send("POST", url, null, form);
        expect([res.statusCode, res.json()]).toEqual([400, { error: "invalid_request" }]);
      }
      for (const url of ["/api/friend-requests", "/api/conversations", "/api/sync/catchup"]) {
        const res = await send("POST", url, a, form);
        expect([res.statusCode, res.json()]).toEqual([400, { error: "invalid_request" }]);
      }
    }
    // and the session survives those
    expect((await signIn(app, a.email, a.password)).statusCode).toBe(200);
    expect(cookieHeaderFrom(undefined)).toBe("");
  });
});
