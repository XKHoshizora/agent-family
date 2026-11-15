import { afterEach, describe, expect, it } from "vitest";
import { redactQuery } from "../src/app.ts";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { closeAllSockets, issueTicket, tryConnect } from "./helpers/ws.ts";

// The real logger, at info level, writing into this array instead of stdout.
const lines: string[] = [];
const { app, db } = useApp({ logStream: { write: (line) => void lines.push(line) } });
afterEach(closeAllSockets);

describe("request logging", () => {
  it("never writes a query string: no WebSocket ticket, verification token or search term reaches the log", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")]; // follows a verification link
    await befriend(app, a, b);
    const verifyToken = new URL(
      /https?:\/\/\S+/.exec((await db.query<{ body: string }>("select body from mail_outbox where recipient = $1", [a.email])).rows[0]!.body)![0],
    ).searchParams.get("token")!;

    const ticket = await issueTicket(app, a);
    const opened = await tryConnect(app, { ticket });
    expect("socket" in opened).toBe(true);
    const unknownTicket = "u".repeat(43);
    expect(await tryConnect(app, { ticket: unknownTicket })).toEqual({ status: 401 });
    expect((await api(app, a, "GET", "/api/search?q=very-private-term")).status).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/attachments/%zz?also=secret-in-a-bad-url" })).statusCode).toBe(400);

    const log = lines.join("");
    for (const secret of [ticket, unknownTicket, verifyToken, "very-private-term", "secret-in-a-bad-url"]) {
      expect(log).not.toContain(secret);
    }
    // Nor the session cookie (headers are not logged at all).
    expect(log).not.toContain(a.cookie.split("=")[1]!.slice(0, 20));

    // The requests themselves are logged, each URL without its query.
    const urls = lines.map((l) => JSON.parse(l) as { req?: { url: string } }).flatMap((e) => (e.req ? [e.req.url] : []));
    expect(urls).toContain("/api/ws?[redacted]");
    expect(urls).toContain("/api/search?[redacted]");
    expect(urls.some((u) => u.startsWith("/api/auth/verify-email?[redacted]"))).toBe(true);
    expect(urls.filter((u) => u.includes("?")).every((u) => u.endsWith("?[redacted]"))).toBe(true);
  });

  it("redactQuery keeps the path and drops everything after the first ?", () => {
    expect(redactQuery("/api/ws?ticket=abc")).toBe("/api/ws?[redacted]");
    expect(redactQuery("/api/search?q=a?b&limit=2")).toBe("/api/search?[redacted]");
    expect(redactQuery("/api/me")).toBe("/api/me");
    expect(redactQuery("/api/me?")).toBe("/api/me?[redacted]");
  });
});
