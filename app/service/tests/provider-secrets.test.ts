import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { openKey, sealKey } from "../src/providers/crypto.ts";
import { loadProviderForCall } from "../src/providers/store.ts";
import { signUp } from "./helpers/actors.ts";
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

describe("sealKey / openKey", () => {
  it("round-trips, in the layout version(1) | nonce(12) | tag(16) | ciphertext, with a fresh nonce each time", () => {
    const a = sealKey(KEY, SECRET);
    const b = sealKey(KEY, SECRET);
    expect(a[0]).toBe(1);
    expect(a.length).toBe(1 + 12 + 16 + Buffer.byteLength(KEY));
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from(NEEDLE))).toBe(false);
    expect(openKey(a, SECRET)).toBe(KEY);
    expect(openKey(b, SECRET)).toBe(KEY);
    expect(openKey(sealKey("ключ 🔑", SECRET), SECRET)).toBe("ключ 🔑");
  });

  it("refuses another secret, any changed byte, a short value and an unknown version, without saying the key", () => {
    const sealed = sealKey(KEY, SECRET);
    const attempts: Buffer[] = [];
    for (const at of [0, 1, 12, 13, 28, 29, sealed.length - 1]) {
      const changed = Buffer.from(sealed);
      changed[at]! ^= 0x01;
      attempts.push(changed);
    }
    attempts.push(sealed.subarray(0, 28), sealed.subarray(0, sealed.length - 1), Buffer.alloc(0));
    const failures = [() => openKey(sealed, `${SECRET}x`), ...attempts.map((c) => () => openKey(c, SECRET))];
    for (const [i, attempt] of failures.entries()) {
      let error: unknown;
      try {
        attempt();
      } catch (e) {
        error = e;
      }
      expect([i, error instanceof Error]).toEqual([i, true]);
      expect(String((error as Error).message)).not.toContain(NEEDLE);
    }
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
    expect(await call("POST", `/api/providers/${id}/test`)).toEqual({ status: 200, json: { ok: false, error: "provider_rejected" } });
    expect(await call("POST", `/api/providers/${id}/models/refresh`)).toEqual({ status: 502, json: { error: "provider_rejected" } });
    mode = "html";
    expect(await call("POST", `/api/providers/${id}/test`)).toEqual({ status: 200, json: { ok: false, error: "provider_unavailable" } });
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
