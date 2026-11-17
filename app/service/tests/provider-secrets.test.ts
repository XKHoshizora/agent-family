import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InjectOptions } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { KeyUnreadableError, openKey, sealKey } from "../src/providers/crypto.ts";
import { loadProviderForCall } from "../src/providers/store.ts";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { providerBody, useProviderStub, type StubReply } from "./helpers/providers.ts";

/**
 * A provider's API key is written once and never shown again: not in any answer, push, error or log line, and
 * not in the database in the clear. Only `loadProviderForCall` opens it, to hand it to the upstream call.
 */

const lines: string[] = [];
const stub = useProviderStub();
const { app, db } = useApp({ env: SITE_ENV, allowInsecureLocal: true, logStream: { write: (line) => void lines.push(line) } });

const KEY = "sk-test-SECRET-1234567890";
const NEEDLE = "SECRET-1234567890";
const SECRET = "a-provider-key-secret-of-32-chars-or-more";

/** The provider row a key is sealed for. */
const ROW = { ownerId: "0b9d2a52-7a3e-4c43-9e0a-5f1f4f2b8c11", providerId: "6d1f0c8e-2b7a-4f6e-8a3d-9c5e1b2a7f40" } as const;

/** What `attempt` throws, or undefined. */
function thrown(attempt: () => unknown): unknown {
  try {
    attempt();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("sealKey / openKey", () => {
  it("round-trips, in the layout version(2) | nonce(12) | tag(16) | ciphertext, with a fresh nonce each time", () => {
    const a = sealKey(KEY, SECRET, ROW);
    const b = sealKey(KEY, SECRET, ROW);
    expect(a[0]).toBe(2);
    expect(a.length).toBe(1 + 12 + 16 + Buffer.byteLength(KEY));
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from(NEEDLE))).toBe(false);
    expect(openKey(a, SECRET, ROW)).toBe(KEY);
    expect(openKey(b, SECRET, ROW)).toBe(KEY);
    expect(openKey(sealKey("ключ 🔑", SECRET, ROW), SECRET, ROW)).toBe("ключ 🔑");
  });

  it("refuses another secret, any changed byte, a short value and an unknown version, without saying the key", () => {
    const sealed = sealKey(KEY, SECRET, ROW);
    const attempts: Buffer[] = [];
    for (const at of [0, 1, 12, 13, 28, 29, sealed.length - 1]) {
      const changed = Buffer.from(sealed);
      changed[at]! ^= 0x01;
      attempts.push(changed);
    }
    const versionOne = Buffer.from(sealed);
    versionOne[0] = 1;
    attempts.push(versionOne, sealed.subarray(0, 28), sealed.subarray(0, sealed.length - 1), Buffer.alloc(0));
    const failures = [() => openKey(sealed, `${SECRET}x`, ROW), ...attempts.map((c) => () => openKey(c, SECRET, ROW))];
    for (const [i, attempt] of failures.entries()) {
      const error = thrown(attempt);
      expect([i, error instanceof KeyUnreadableError]).toEqual([i, true]);
      expect(String((error as Error).message)).not.toContain(NEEDLE);
    }
  });

  it("is bound to its row: under another provider's id, or another owner's, it does not open", () => {
    const sealed = sealKey(KEY, SECRET, ROW);
    const elsewhere = [
      { ownerId: ROW.ownerId, providerId: "6d1f0c8e-2b7a-4f6e-8a3d-9c5e1b2a7f41" },
      { ownerId: "0b9d2a52-7a3e-4c43-9e0a-5f1f4f2b8c12", providerId: ROW.providerId },
      { ownerId: ROW.providerId, providerId: ROW.ownerId },
    ];
    for (const row of elsewhere) expect([row, thrown(() => openKey(sealed, SECRET, row)) instanceof KeyUnreadableError]).toEqual([row, true]);
  });
});

describe("a saved key moved to another provider's row", () => {
  it("does not open there, for the same owner or another: the test, the refresh, a reply and a draft say provider_rejected", async () => {
    const [owner, other] = [await signUp(app, "mover"), await signUp(app, "receiver")];
    const create = async (who: typeof owner, name: string, apiKey: string) =>
      (await api(app, who, "POST", "/api/providers", providerBody({ name, apiKey, baseUrl: stub.baseUrl(), models: [{ name: "m" }] }))).json.id as string;
    const source = await create(owner, "source", KEY);
    const mine = await create(owner, "mine", "sk-test-other-key-0001");
    const theirs = await create(other, "theirs", "sk-test-other-key-0002");
    await db.query("update providers set key_cipher = (select key_cipher from providers where id = $1) where id = any($2::uuid[])", [source, [mine, theirs]]);

    expect(await api(app, owner, "POST", `/api/providers/${source}/test`)).toEqual({ status: 200, json: { ok: true } });
    const sent = stub.requests.length;
    expect(await api(app, owner, "POST", `/api/providers/${mine}/test`)).toEqual({ status: 200, json: { ok: false, error: "provider_rejected" } });
    expect(await api(app, other, "POST", `/api/providers/${theirs}/test`)).toEqual({ status: 200, json: { ok: false, error: "provider_rejected" } });
    expect(await api(app, owner, "POST", `/api/providers/${mine}/models/refresh`)).toEqual({ status: 502, json: { error: "provider_rejected" } });
    expect(await api(app, owner, "POST", `/api/providers/${mine}/models/list`)).toEqual({ status: 200, json: { ok: false, error: "provider_rejected" } });
    const onMine = { source: "provider", providerId: mine, model: "m" };
    expect(await api(app, owner, "POST", "/api/agents/draft-persona", { name: "x", model: onMine })).toEqual({ status: 502, json: { error: "provider_rejected" } });
    const agent = await mustCreateAgent(app, owner, { model: onMine, persona: "简短。" });
    expect((await api(app, owner, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "你好", clientTxn: "moved-1" })).status).toBe(201);
    await vi.waitFor(async () =>
      expect((await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/run`)).json.run).toMatchObject({
        status: "failed",
        error: "provider_rejected",
        retryable: false,
      }),
    );
    // Nothing was sent anywhere with the moved key, and the log says why without saying the key.
    expect(stub.requests.length).toBe(sent);
    const why = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => String(e.msg).includes("cannot be opened"));
    expect(why.length).toBeGreaterThanOrEqual(4);
    expect(lines.join("")).not.toContain(NEEDLE);
  });
});

describe("a provider's key never comes back", () => {
  it("not from any provider route, /api/sync, a test against an upstream that echoes it, nor the log; not stored in the clear", async () => {
    const owner = await signUp(app, "keeper");
    const seen: string[] = [];
    const call = async (method: InjectOptions["method"], url: string, payload?: object) => {
      const res = await app.inject({ method, url, headers: { cookie: owner.cookie }, ...(payload === undefined ? {} : { payload }) });
      seen.push(JSON.stringify(res.headers), res.body);
      return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
    };
    // The upstream echoes whatever Authorization it got: in its error bodies and headers, and even as model names.
    let mode: "ok" | "reject" | "html" = "ok";
    stub.answer((req): StubReply => {
      const auth = String(req.headers.authorization ?? "");
      if (mode === "reject") {
        return {
          status: 401,
          headers: { "x-echo": auth, "www-authenticate": `Bearer realm="${auth}"` },
          body: JSON.stringify({ error: { message: `Incorrect API key provided: ${auth}` } }),
        };
      }
      if (mode === "html") return { status: 500, headers: { "content-type": "text/html" }, body: `<html><body>${auth}</body></html>` };
      return { status: 200, headers: { "x-echo": auth }, body: JSON.stringify({ data: [{ id: "model-a" }, { id: auth }, { id: KEY }], echo: auth }) };
    });

    const created = await call("POST", "/api/providers", providerBody({ apiKey: KEY, baseUrl: stub.baseUrl(), models: [{ name: "m" }] }));
    expect(created.status).toBe(201);
    expect(created.json.keyLast4).toBe("7890");
    const id = created.json.id as string;
    expect((await call("GET", "/api/providers")).status).toBe(200);
    expect((await call("PATCH", `/api/providers/${id}`, { name: "Renamed" })).status).toBe(200);
    expect((await call("PATCH", `/api/providers/${id}`, { baseUrl: `${stub.baseUrl()}/` })).status).toBe(200);
    expect((await call("PATCH", `/api/providers/${id}`, { models: [{ name: "m" }, { name: "n" }] })).status).toBe(200);
    expect((await call("PATCH", `/api/providers/${id}`, { apiKey: KEY })).json.keyLast4).toBe("7890");

    mode = "ok";
    const refreshed = await call("POST", `/api/providers/${id}/models/refresh`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.listed).toEqual(["model-a"]);
    expect(await call("POST", `/api/providers/${id}/test`)).toEqual({ status: 200, json: { ok: true } });
    mode = "reject";
    expect(await call("POST", `/api/providers/${id}/test`)).toEqual({ status: 200, json: { ok: false, error: "provider_rejected", upstreamStatus: "401" } });
    expect(await call("POST", `/api/providers/${id}/models/refresh`)).toEqual({ status: 502, json: { error: "provider_rejected" } });
    mode = "html";
    expect(await call("POST", `/api/providers/${id}/test`)).toEqual({ status: 200, json: { ok: false, error: "provider_unavailable", upstreamStatus: "500" } });
    expect(await call("POST", `/api/providers/${id}/models/refresh`)).toEqual({ status: 502, json: { error: "provider_unavailable" } });
    // The key really was sent, every time, to the upstream and nowhere else.
    expect(stub.requests.length).toBe(6);
    for (const r of stub.requests) expect(r.headers.authorization).toBe(`Bearer ${KEY}`);

    const agent = await mustCreateAgent(app, owner, { model: { source: "provider", providerId: id, model: "m" } });
    expect((await call("GET", "/api/agents")).status).toBe(200);
    expect((await call("GET", `/api/agents/${agent.id}`)).status).toBe(200);
    expect((await call("GET", "/api/sync")).status).toBe(200);
    expect((await call("DELETE", `/api/providers/${id}`)).status).toBe(409);

    // Stored: sealed, never in the clear (nor anywhere else in the row).
    const { rows } = await db.query<{ key_cipher: Buffer; row: string }>("select key_cipher, row_to_json(p)::text as row from providers p where id = $1", [id]);
    expect(rows[0]!.key_cipher.includes(Buffer.from(NEEDLE))).toBe(false);
    expect(rows[0]!.row).not.toContain(NEEDLE);
    expect((await loadProviderForCall(db, owner.id, id, app.deps.config.providerKeySecret))!.apiKey).toBe(KEY);

    expect((await call("DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    expect((await call("DELETE", `/api/providers/${id}`)).status).toBe(200);

    expect(seen.length).toBeGreaterThan(30);
    for (const text of seen) expect(text).not.toContain(NEEDLE);
    const log = lines.join("");
    expect(log).not.toContain(NEEDLE);

    // What the log does say about a failed call: the provider, its protocol, the code and the upstream's status.
    const failures = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.msg === "provider call failed");
    expect(failures.map((e) => [e.providerId, e.protocol, e.error, e.upstreamStatus])).toEqual([
      [id, "openai_chat", "provider_rejected", 401],
      [id, "openai_chat", "provider_rejected", 401],
      [id, "openai_chat", "provider_unavailable", 500],
      [id, "openai_chat", "provider_unavailable", 500],
    ]);
    for (const e of failures) {
      expect(Object.keys(e).filter((k) => !["level", "time", "pid", "hostname", "reqId", "msg"].includes(k)).sort()).toEqual([
        "error",
        "protocol",
        "providerId",
        "upstreamStatus",
      ]);
    }
  });

  it("the model list (models/list) answers names and hints only: never the key, the base URL or the upstream's text", async () => {
    const owner = await signUp(app, "lister");
    const seen: string[] = [];
    const list = async (id: string) => {
      const res = await app.inject({ method: "POST", url: `/api/providers/${id}/models/list`, headers: { cookie: owner.cookie } });
      seen.push(JSON.stringify(res.headers), res.body);
      return { status: res.statusCode, json: JSON.parse(res.body) };
    };
    // The upstream echoes the Authorization it got, and its own address, in its answers: as model names, in error bodies.
    let mode: "ok" | "reject" | "html" = "ok";
    stub.answer((req): StubReply => {
      const auth = String(req.headers.authorization ?? "");
      if (mode === "reject") return { status: 401, headers: { "x-echo": auth }, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${auth}` } }) };
      if (mode === "html") return { status: 500, headers: { "content-type": "text/html" }, body: `<html><body>${auth} at ${stub.baseUrl()}</body></html>` };
      return { status: 200, headers: { "x-echo": auth }, body: JSON.stringify({ data: [{ id: "model-a" }, { id: auth }, { id: KEY }, { id: `x-${KEY}-y` }], echo: auth, at: stub.baseUrl() }) };
    });
    const created = await api(app, owner, "POST", "/api/providers", providerBody({ apiKey: KEY, baseUrl: stub.baseUrl() }));
    const id = created.json.id as string;

    // A name that holds the key is never answered.
    expect(await list(id)).toEqual({ status: 200, json: { ok: true, listed: [{ name: "model-a", vision: false, pdf: false, reasoning: false, chat: true, known: false, added: false }] } });
    mode = "reject";
    expect(await list(id)).toEqual({ status: 200, json: { ok: false, error: "provider_rejected", upstreamStatus: "401" } });
    mode = "html";
    expect(await list(id)).toEqual({ status: 200, json: { ok: false, error: "provider_unavailable", upstreamStatus: "500" } });
    for (const r of stub.requests) expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(stub.requests).toHaveLength(3);

    for (const text of seen) {
      expect(text).not.toContain(NEEDLE);
      expect(text).not.toContain("Incorrect API key");
      expect(text).not.toContain("<html>");
      expect(text).not.toContain("x-echo");
      expect(text).not.toContain(stub.baseUrl());
    }
    expect(lines.join("")).not.toContain(NEEDLE);
    const failures = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.msg === "provider call failed" && e.providerId === id);
    expect(failures.map((e) => [e.protocol, e.error, e.upstreamStatus])).toEqual([
      ["openai_chat", "provider_rejected", 401],
      ["openai_chat", "provider_unavailable", 500],
    ]);
  });

  it("loadProviderForCall is the only place outside crypto.ts that opens a key", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    const users = files.filter((f) => readFileSync(path.join(src, f), "utf8").includes("openKey(")).map((f) => f.split(path.sep).join("/"));
    expect(users.sort()).toEqual(["providers/crypto.ts", "providers/store.ts"]);
    const store = readFileSync(path.join(src, "providers", "store.ts"), "utf8");
    const calls = [...store.matchAll(/openKey\(/g)].length;
    expect(calls).toBe(1);
    const reader = store.slice(store.indexOf("export async function loadProviderForCall"));
    expect(reader.slice(0, reader.indexOf("\n}\n"))).toContain("openKey(");
  });
});
