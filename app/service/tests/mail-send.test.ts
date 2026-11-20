import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.ts";
import { createInvite } from "../src/auth/invites.ts";
import { mailCounts } from "../src/auth/mail-sender.ts";
import { sendMail } from "../src/auth/mailer.ts";
import { settled } from "../src/memory/stats.ts";
import { api } from "./helpers/actors.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";

const KEY = "re_test_key_that_must_never_be_printed";
const TO = "reader@example.test";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  json: Record<string, unknown>;
}
type Reply = { status: number; body?: unknown } | "hangup";

/** A local stand-in for the mail provider: records every request, answers from a script (then 200 with an id). */
const seen: Seen[] = [];
let script: Reply[] = [];
let delayMs = 0;
const provider: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, json: JSON.parse(raw || "{}") });
    const next = script.shift() ?? { status: 200, body: { id: `prov-${seen.length}` } };
    setTimeout(() => {
      if (next === "hangup") return void req.socket.destroy();
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body ?? {}));
    }, delayMs);
  });
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const apiUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/emails`;
afterAll(() => new Promise<void>((r) => provider.close(() => r())));

const logs: string[] = [];
const env = { MAIL_MODE: "resend", RESEND_API_KEY: KEY, MAIL_FROM: "Haiyo <no-reply@mail.example>", MAIL_REPLY_TO: "help@mail.example" };
const quiet = { answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false, proactive: false, memory: false, agentWorker: false } as const;

describe("mail is really sent", () => {
  const { app, db } = useApp({ env, mail: { apiUrl, sender: false }, logStream: { write: (l) => void logs.push(l) } });

  beforeEach(() => {
    seen.length = 0;
    script = [];
    delayMs = 0;
    logs.length = 0;
  });

  const queue = async (body = "link https://app.example/verify?token=abc"): Promise<string> => {
    await sendMail(db, "verify_email", TO, "Subject line", body);
    return (await db.query<{ id: string }>("select id::text from mail_outbox order by id desc limit 1")).rows[0]!.id;
  };
  const row = async (id: string) =>
    (await db.query<Record<string, any>>("select status, attempts, sent_at, last_error, provider_id, next_attempt_at from mail_outbox where id = $1", [id])).rows[0]!;
  const due = (id: string) => db.query("update mail_outbox set next_attempt_at = now() where id = $1", [id]);
  const counter = async (name: string) => {
    await settled();
    return (await db.query<{ n: number }>("select coalesce(sum(n), 0)::int as n from memory_stats where name = $1", [name])).rows[0]!.n;
  };

  test("a queued mail is delivered: provider call as documented, row sent with the provider's id", async () => {
    const id = await queue();
    expect((await row(id)).status).toBe("queued");
    expect(seen).toHaveLength(0); // writing the row sends nothing
    expect(await app.mailSender.runOnce()).toBe(1);
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(s.headers["idempotency-key"]).toBe(`mail-${id}`);
    expect(s.json).toEqual({
      from: "Haiyo <no-reply@mail.example>",
      to: [TO],
      subject: "Subject line",
      text: "link https://app.example/verify?token=abc",
      reply_to: "help@mail.example",
    });
    const r = await row(id);
    expect(r).toMatchObject({ status: "sent", attempts: 1, last_error: null, provider_id: "prov-1" });
    expect(r.sent_at).toBeInstanceOf(Date);
    expect(await counter("mail_sent")).toBe(1);
    expect(await app.mailSender.runOnce()).toBe(0); // sent once, never again
  });

  test("a 500 is retried later with the same idempotency key and the mail is sent once", async () => {
    script = [{ status: 500, body: { message: `boom ${TO}` } }];
    const id = await queue();
    await app.mailSender.runOnce();
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 1, last_error: "http_500" });
    expect(await app.mailSender.runOnce()).toBe(0); // backing off: not due yet
    expect(seen).toHaveLength(1);
    await due(id);
    await app.mailSender.runOnce();
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.headers["idempotency-key"])).toEqual([`mail-${id}`, `mail-${id}`]);
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 2, last_error: null, provider_id: "prov-2" });
    expect(await counter("mail_retry")).toBe(1);
    expect(await counter("mail_sent")).toBe(1);
  });

  test("429 and a dropped connection are retried too; the next try waits longer and longer", async () => {
    script = [{ status: 429, body: {} }, "hangup", { status: 503 }];
    const id = await queue();
    const waits: number[] = [];
    for (const code of ["http_429", "network", "http_503"]) {
      await app.mailSender.runOnce();
      const r = await row(id);
      expect(r).toMatchObject({ status: "queued", last_error: code });
      waits.push(r.next_attempt_at.getTime() - Date.now());
      await due(id);
    }
    expect(waits[0]! < waits[1]! && waits[1]! < waits[2]!).toBe(true);
    expect(waits[2]!).toBeLessThan(16 * 60_000);
  });

  test("five attempts at most: a provider that keeps failing ends the mail as failed", async () => {
    script = Array.from({ length: 6 }, () => ({ status: 500 }));
    const id = await queue();
    for (let i = 0; i < 7; i++) {
      await app.mailSender.runOnce();
      await due(id);
    }
    expect(seen).toHaveLength(5);
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 5, last_error: "http_500" });
    expect(await counter("mail_failed")).toBe(1);
    expect(await counter("mail_retry")).toBe(4);
  });

  test("a 422 fails at once: no retry; the error is a short code, not the provider's words", async () => {
    script = [{ status: 422, body: { name: "missing_required_field", message: `bad ${TO} ${KEY}` } }];
    const id = await queue();
    await app.mailSender.runOnce();
    await due(id);
    await app.mailSender.runOnce();
    expect(seen).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 1, last_error: "http_422", provider_id: null });
    expect(await counter("mail_failed")).toBe(1);
  });

  test("a restart between queueing and sending loses nothing: a fresh process picks the row up, with the same key", async () => {
    const id = await queue();
    // The first process never got to it (it is gone); a second one starts on the same database.
    const second = await buildApp({ config: app.deps.config, db: app.deps.db }, { ...quiet, mail: { apiUrl, sender: false } });
    await second.ready();
    try {
      expect(await second.mailSender.runOnce()).toBe(1);
    } finally {
      await second.close();
    }
    expect(seen.map((s) => s.headers["idempotency-key"])).toEqual([`mail-${id}`]);
    expect((await row(id)).status).toBe("sent");
  });

  test("a process that died in the middle of a send leaves the row to be retried (same key) once its lease has run out", async () => {
    const id = await queue();
    // What the claim leaves behind when the process dies before it records the answer.
    await db.query("update mail_outbox set attempts = 1, next_attempt_at = now() - interval '1 second' where id = $1", [id]);
    await app.mailSender.runOnce();
    expect(seen[0]!.headers["idempotency-key"]).toBe(`mail-${id}`);
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 2 });
  });

  test("two senders at once never send one row twice (skip locked)", async () => {
    delayMs = 150;
    const id = await queue();
    await Promise.all([app.mailSender.runOnce(), app.mailSender.runOnce()]);
    expect(seen).toHaveLength(1);
    expect((await row(id)).status).toBe("sent");
  });

  test("a mail that has waited more than an hour is not sent (a stale link), and a row that used its attempts is closed", async () => {
    const old = await queue();
    await db.query("update mail_outbox set created_at = now() - interval '61 minutes' where id = $1", [old]);
    const spent = await queue();
    await db.query("update mail_outbox set attempts = 5, next_attempt_at = now() - interval '1 second' where id = $1", [spent]);
    await app.mailSender.runOnce();
    expect(seen).toHaveLength(0);
    expect(await row(old)).toMatchObject({ status: "failed", last_error: "expired" });
    expect(await row(spent)).toMatchObject({ status: "failed", last_error: "gave_up" });
  });

  test("the key, the address and the mail's text are in no log line, no error and no row", async () => {
    script = [{ status: 500, body: { message: `${KEY} ${TO}` } }, { status: 422, body: { message: `${KEY} ${TO}` } }];
    const id = await queue("secret words in the body");
    await app.mailSender.runOnce();
    await due(id);
    await app.mailSender.runOnce();
    await settled();
    const rows = (await db.query("select * from mail_outbox where id = $1", [id])).rows.map((r) => ({ ...r, recipient: undefined, subject: undefined, body: undefined }));
    const everything = JSON.stringify(rows) + (await db.query("select * from memory_stats")).rows.map((r) => JSON.stringify(r)).join("") + logs.join("");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(TO);
    expect(everything).not.toContain("secret words");
    expect(logs.join("")).toMatch(/mail/); // it does say something: a code and the row id
  });

  test("a registration answers as ever while delivery is down: the mail is only queued", async () => {
    script = Array.from({ length: 3 }, () => ({ status: 500 }));
    const code = await createInvite(db, { ttlHours: 1 });
    const res = await api(app, null, "POST", "/api/register", { inviteCode: code, email: "new@example.test", password: "correct horse battery", displayName: "New", handle: "new_one" });
    expect(res).toEqual({ status: 201, json: { ok: true } });
    expect(seen).toHaveLength(0);
    const { rows } = await db.query<{ status: string }>("select status from mail_outbox where kind = 'verify_email'");
    expect(rows).toEqual([{ status: "queued" }]);
  });

  test("mail:status counts what waits, what was sent and what failed", async () => {
    script = [{ status: 200, body: { id: "a" } }, { status: 422 }];
    await queue();
    await queue();
    await queue();
    await db.query("update mail_outbox set next_attempt_at = now() + interval '1 hour' where id = (select max(id) from mail_outbox)");
    await app.mailSender.runOnce();
    expect(await mailCounts(db)).toEqual({ queued: 1, sent: 1, failed: 1 });
  });

  test("the sender's own timer delivers without anyone calling it", async () => {
    const timed = await buildApp({ config: app.deps.config, db: app.deps.db }, { ...quiet, mail: { apiUrl, sender: { intervalMs: 20 } } });
    await timed.ready();
    try {
      const id = await queue();
      for (let i = 0; i < 100 && (await row(id)).status !== "sent"; i++) await new Promise((r) => setTimeout(r, 30));
      expect((await row(id)).status).toBe("sent");
    } finally {
      await timed.close();
    }
  });

  test("outbox mode: rows are written as before, nothing is delivered, nothing is touched", async () => {
    const plain = await buildApp({ config: { ...app.deps.config, mailMode: "outbox", mail: undefined }, db: app.deps.db }, { ...quiet, mail: { apiUrl, sender: { intervalMs: 20 } } });
    await plain.ready();
    try {
      const id = await queue();
      expect(await plain.mailSender.runOnce()).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toHaveLength(0);
      expect(await row(id)).toMatchObject({ status: "queued", attempts: 0 });
      const listed = await db.query("select id, created_at, recipient, kind, subject, body from mail_outbox where recipient = $1 order by id", [TO]);
      expect(listed.rows).toHaveLength(1);
    } finally {
      await plain.close();
    }
  });
});
