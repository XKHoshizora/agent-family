import type http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHAT_TEST } from "../src/providers/routes.ts";
import { DETAIL_CHARS, holdsKeyPiece, KEY_PIECE, upstreamDetail } from "../src/providers/upstream-detail.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { answerCanned, protocolStub, scriptedGateway, STUB_MODEL, type ProtocolStub, type StubHandler } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";

/**
 * Adding and debugging a provider (README "Model providers"): 测试连接 with a model makes one tiny real call through the
 * gateway (and costs nothing); a failed test or model list says what the upstream said — to the provider's owner only,
 * bounded, cleaned and never with a piece of the key.
 */

const lines: string[] = [];
const { app, db } = useApp({ allowInsecureLocal: true, logStream: { write: (line) => void lines.push(line) } });
let stub: ProtocolStub;
beforeAll(async () => {
  stub = await protocolStub();
});
afterAll(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.reset();
  stub.answer(listOrStream);
  lines.length = 0;
});

const KEY = "sk-live-Q7f3K9pX2mZ8vB4n";
const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";

const send = (res: http.ServerResponse, status: number, body: unknown, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
/** `GET …/models` answers a list; the four protocols' streaming endpoints their canned answer. */
const listOrStream: StubHandler = (req, res) => {
  if (req.method === "GET" && req.path.endsWith("/models")) send(res, 200, { data: [{ id: STUB_MODEL }] });
  else answerCanned(req, res);
};
/** Every request (the model list and the streaming endpoints alike) answered `status` with `body`. */
const failWith = (status: number, body: string, type = "application/json"): StubHandler => (_req, res) => send(res, status, body, type);

async function provider(owner: Actor, over: Record<string, unknown> = {}) {
  const res = await api(app, owner, "POST", "/api/providers", providerBody({ apiKey: KEY, baseUrl: stub.baseUrl, ...over }));
  if (res.status !== 201) throw new Error(`create provider: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json as { id: string };
}
/** The route's answer, and its raw body (to look for the key in). */
async function call(owner: Actor, url: string, payload?: unknown) {
  const res = await app.inject({ method: "POST", url, headers: { cookie: owner.cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: res.statusCode, json: JSON.parse(res.body), raw: res.body };
}
const testOf = (owner: Actor, id: string, payload?: unknown) => call(owner, `/api/providers/${id}/test`, payload);
const listOf = (owner: Actor, id: string) => call(owner, `/api/providers/${id}/models/list`);

describe("测试连接 with a model: one tiny real call through the gateway", () => {
  const sentLimit = (protocol: string, body: any) =>
    protocol === "gemini" ? body.generationConfig?.maxOutputTokens : protocol === "openai_responses" ? body.max_output_tokens : body.max_tokens;

  it("says hi to the model once, per protocol: no system text, no thinking, 16 tokens; answers ok, mode chat and the time it took", async () => {
    const owner = await signUp(app, "chatty");
    const paths: Record<string, string> = {
      openai_chat: "/v1/chat/completions",
      openai_responses: "/v1/responses",
      anthropic: "/v1/messages",
      gemini: `/v1/models/${STUB_MODEL}:streamGenerateContent?alt=sse`,
    };
    for (const [protocol, path] of Object.entries(paths)) {
      const p = await provider(owner, { name: protocol, protocol, models: [{ name: STUB_MODEL }] });
      stub.requests.length = 0;
      const res = await testOf(owner, p.id, { model: STUB_MODEL });
      expect([protocol, res.status, res.json]).toEqual([protocol, 200, { ok: true, mode: "chat", latencyMs: expect.any(Number) }]);
      expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${path}`]);
      const [req] = stub.requests;
      const body = req!.body;
      expect([protocol, sentLimit(protocol, body)]).toEqual([protocol, CHAT_TEST.maxOutputTokens]);
      const text = JSON.stringify(body);
      expect(text).toContain('"hi"');
      expect(text).not.toMatch(/system|developer|systemInstruction/);
      expect([protocol, text]).not.toEqual([protocol, expect.stringMatching(/reasoning_effort|"effort"|thinkingConfig|"adaptive"/)]);
      if (protocol === "anthropic") expect(body.thinking).toEqual({ type: "disabled" });
    }
  });

  it("a model flagged reasoning gets the thinking switch (off); without the flag nothing is sent about thinking", async () => {
    const owner = await signUp(app, "thinker");
    const p = await provider(owner, { models: [{ name: "deep", reasoning: true }, { name: "plain" }] });
    expect((await testOf(owner, p.id, { model: "deep" })).json.ok).toBe(true);
    expect((await testOf(owner, p.id, { model: "plain" })).json.ok).toBe(true);
    expect(stub.requests.map((r) => [r.body.model, r.body.thinking])).toEqual([
      ["deep", { type: "disabled" }],
      ["plain", undefined],
    ]);
  });

  it("only a saved model (400 otherwise, nothing sent); any well-formed name while the provider has none; a malformed name is 400", async () => {
    const owner = await signUp(app, "picky");
    const listed = await provider(owner, { name: "listed", models: [{ name: "a" }] });
    expect(await testOf(owner, listed.id, { model: "b" })).toMatchObject({ status: 400, json: { error: "invalid_request" } });
    expect(stub.requests).toEqual([]);
    const bare = await provider(owner, { name: "bare" });
    expect((await testOf(owner, bare.id, { model: " any-name " })).json).toMatchObject({ ok: true, mode: "chat" });
    expect(stub.requests.map((r) => r.body.model)).toEqual(["any-name"]);
    for (const model of ["", "x".repeat(101), "two\nlines", 5, null]) {
      expect([model, (await testOf(owner, bare.id, { model })).status]).toEqual([model, 400]);
    }
    expect(stub.requests).toHaveLength(1);
  });

  it("without a model, the model list as before: ok, mode list; also for {} and null", async () => {
    const owner = await signUp(app, "lister");
    const p = await provider(owner, { models: [{ name: "a" }] });
    for (const payload of [undefined, {}, null, { other: 1 }]) {
      expect([payload, (await testOf(owner, p.id, payload)).json]).toEqual([payload, { ok: true, mode: "list", latencyMs: expect.any(Number) }]);
    }
    expect(new Set(stub.requests.map((r) => `${r.method} ${r.path}`))).toEqual(new Set(["GET /v1/models"]));
  });

  it("a model that spends its 16 tokens thinking did answer: ok", async () => {
    const owner = await signUp(app, "pondering");
    const p = await provider(owner, { models: [{ name: STUB_MODEL, reasoning: true }] });
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: STUB_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const usage = { id: "c", object: "chat.completion.chunk", created: 1, model: STUB_MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 16, total_tokens: 19, completion_tokens_details: { reasoning_tokens: 16 } } };
    stub.answer((_req, res) => send(res, 200, `${chunk({ role: "assistant", content: "" })}${chunk({ reasoning_content: "Hmm" })}${chunk({}, "length")}data: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`, "text/event-stream"));
    expect((await testOf(owner, p.id, { model: STUB_MODEL })).json).toMatchObject({ ok: true, mode: "chat" });
  });

  it("a failure is answered as the model list's: the code, the upstream's status, and detail with that status only (the gateway keeps no text)", async () => {
    const owner = await signUp(app, "failing");
    const p = await provider(owner, { models: [{ name: STUB_MODEL }] });
    const cases: Array<[number, string, string]> = [
      [401, "provider_rejected", "401"],
      [404, "provider_unavailable", "404"],
      [429, "provider_unavailable", "429"],
    ];
    for (const [status, error, upstreamStatus] of cases) {
      stub.answer(failWith(status, JSON.stringify({ error: { message: `The model does not exist (${KEY})`, type: "x" } })));
      const res = await testOf(owner, p.id, { model: STUB_MODEL });
      expect([status, res.json]).toEqual([status, { ok: false, error, upstreamStatus, detail: { upstreamStatus } }]);
      expect(holdsKeyPiece(res.raw, KEY)).toBe(false);
    }
    const q = await provider(owner, { name: "private", baseUrl: "https://10.0.0.5/v1", models: [{ name: "m" }] });
    expect((await testOf(owner, q.id, { model: "m" })).json).toEqual({ ok: false, error: "address_not_allowed" });
  });

  it("costs nothing: no points, no usage, no run", async () => {
    const owner = await signUp(app, "freeloader");
    const p = await provider(owner, { models: [{ name: STUB_MODEL }] });
    const tables = ["usage_records", "balance_ledger", "free_usage", "agent_runs"];
    const counts = async () => Promise.all(tables.map(async (t) => [t, (await db.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0]!.n]));
    const account = async () => (await db.query("select * from accounts where principal_id = $1", [owner.id])).rows;
    const [beforeCounts, beforeAccount] = [await counts(), await account()];
    for (let i = 0; i < 3; i++) expect((await testOf(owner, p.id, { model: STUB_MODEL })).json.ok).toBe(true);
    expect(await counts()).toEqual(beforeCounts);
    expect(await account()).toEqual(beforeAccount);
    expect(beforeCounts.every(([, n]) => n === 0)).toBe(true);
  });

  it("gives up after 15 s: provider_unavailable", { timeout: 30_000 }, async () => {
    const owner = await signUp(app, "patient");
    const p = await provider(owner, { models: [{ name: STUB_MODEL }] });
    stub.answer(() => {}); // never answers
    const started = Date.now();
    expect((await testOf(owner, p.id, { model: STUB_MODEL })).json).toEqual({ ok: false, error: "provider_unavailable" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(CHAT_TEST.timeoutMs - 100);
    expect(Date.now() - started).toBeLessThan(CHAT_TEST.timeoutMs + 5000);
  });

  it("someone else's provider is the 404 of an id that does not exist, with a model too; nothing is sent", async () => {
    const [alice, eve] = [await signUp(app, "alice"), await signUp(app, "eve")];
    const p = await provider(alice, { models: [{ name: "m" }] });
    for (const payload of [{ model: "m" }, { model: "other" }, undefined]) {
      const theirs = await app.inject({ method: "POST", url: `/api/providers/${p.id}/test`, headers: { cookie: eve.cookie }, ...(payload ? { payload } : {}) });
      const random = await app.inject({ method: "POST", url: `/api/providers/${RANDOM}/test`, headers: { cookie: eve.cookie }, ...(payload ? { payload } : {}) });
      expect([theirs.statusCode, theirs.body]).toEqual([404, '{"error":"not_found"}']);
      expect([random.statusCode, random.body, random.headers["content-type"]]).toEqual([theirs.statusCode, theirs.body, theirs.headers["content-type"]]);
    }
    expect(stub.requests).toEqual([]);
  });
});

describe("what the upstream said (detail), for the provider's owner", () => {
  it("upstreamDetail: JSON error.message, message or error, else the text; cleaned, at most 300 characters", () => {
    expect(upstreamDetail(404, JSON.stringify({ error: { message: "Model not found", code: 1 } }), KEY)).toEqual({ upstreamStatus: "404", message: "Model not found" });
    expect(upstreamDetail(400, JSON.stringify({ message: "Bad field" }), KEY)).toEqual({ upstreamStatus: "400", message: "Bad field" });
    expect(upstreamDetail(400, JSON.stringify({ error: "invalid_model" }), KEY)).toEqual({ upstreamStatus: "400", message: "invalid_model" });
    expect(upstreamDetail(400, JSON.stringify([{ error: { message: "Gemini says no" } }]), KEY)).toEqual({ upstreamStatus: "400", message: "Gemini says no" });
    expect(upstreamDetail(404, JSON.stringify({ detail: "Not Found" }), KEY)).toEqual({ upstreamStatus: "404", message: '{"detail":"Not Found"}' });
    expect(upstreamDetail(503, "upstream connect error\r\n\t\u001b[31mreset\u0000 \u202egnp.​", KEY)).toEqual({ upstreamStatus: "503", message: "upstream connect error [31mreset gnp." });
    const long = upstreamDetail(500, JSON.stringify({ error: { message: "长".repeat(5000) } }), KEY);
    expect([...(long as { message: string }).message]).toHaveLength(DETAIL_CHARS);
    expect(upstreamDetail(500, "", KEY)).toEqual({ upstreamStatus: "500" });
    expect(upstreamDetail(500, " \n\u0007 ", KEY)).toEqual({ upstreamStatus: "500" });
    expect(upstreamDetail(undefined, "x", KEY)).toEqual({ message: "x" });
  });

  it("upstreamDetail: the key, or any 6-character run of it, anywhere in the answer (any case), drops the text", () => {
    const redacted = { upstreamStatus: "401", message: null, redacted: true };
    expect(upstreamDetail(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), KEY)).toEqual(redacted);
    expect(upstreamDetail(401, JSON.stringify({ error: { message: `key …${KEY.slice(5, 5 + KEY_PIECE)}… refused` } }), KEY)).toEqual(redacted);
    expect(upstreamDetail(401, JSON.stringify({ error: { message: `key ${KEY.slice(-9).toUpperCase()}` } }), KEY)).toEqual(redacted);
    // Elsewhere in the body than the message: an upstream echoing the request's headers.
    expect(upstreamDetail(401, JSON.stringify({ error: { message: "Unauthorized" }, headers: { authorization: `Bearer ${KEY}` } }), KEY)).toEqual(redacted);
    // A run shorter than six is no piece of the key.
    expect(upstreamDetail(401, JSON.stringify({ error: { message: `key ends with ${KEY.slice(-5)}` } }), KEY)).toEqual({ upstreamStatus: "401", message: `key ends with ${KEY.slice(-5)}` });
    expect(holdsKeyPiece(`x${KEY.slice(10, 16)}x`, KEY)).toBe(true);
    expect(holdsKeyPiece(KEY.slice(10, 15), KEY)).toBe(false);
  });

  /** `key` cut into runs of at most 5 characters, each pair joined by `sep`: no 6-character run of it is left whole. */
  const split = (key: string, sep: string) => (key.match(/.{1,5}/g) ?? []).join(sep);
  const REDACTED = { upstreamStatus: "401", message: null, redacted: true };

  it("upstreamDetail: a key split by characters the cleaning removes is not put back together (the check runs on the text returned)", () => {
    const separators: Array<[string, string]> = [
      ["zero-width space", "\u200b"],
      ["soft hyphen", "\u00ad"],
      ["NUL", "\u0000"],
      ["zero-width joiner", "\u200d"],
      ["zero-width non-joiner", "\u200c"],
      ["bidi override", "\u202e"],
      ["bidi isolate", "\u2066"],
      ["BEL", "\u0007"],
    ];
    for (const [name, sep] of separators) {
      const spelled = split(KEY, sep);
      expect([name, holdsKeyPiece(spelled, KEY)]).toEqual([name, false]); // the raw text alone would pass the old check
      for (const body of [JSON.stringify({ error: { message: `Bad key: ${spelled}` } }), `Bad key: ${spelled}`, JSON.stringify({ message: spelled })]) {
        expect([name, upstreamDetail(401, body, KEY)]).toEqual([name, REDACTED]);
      }
    }
  });

  it("upstreamDetail: a key spelled out with white space between its characters is dropped", () => {
    for (const sep of [" ", "  ", "\t", "\n", " \u200b "]) {
      expect([JSON.stringify(sep), upstreamDetail(401, JSON.stringify({ error: { message: `key: ${[...KEY].join(sep)}` } }), KEY)]).toEqual([JSON.stringify(sep), REDACTED]);
    }
    // White space alone does not condemn a message.
    expect(upstreamDetail(401, JSON.stringify({ error: { message: "key is not valid for this model" } }), KEY)).toEqual({ upstreamStatus: "401", message: "key is not valid for this model" });
  });

  it("upstreamDetail: the key in base64, base64url, percent-encoded or as \\uXXXX escapes is dropped", () => {
    const say = (text: string, key = KEY) => upstreamDetail(401, JSON.stringify({ error: { message: text } }), key);
    expect(say(`got ${Buffer.from(KEY).toString("base64")}`)).toEqual(REDACTED);
    expect(say(`got ${Buffer.from(KEY).toString("base64").replace(/=+$/, "")}`)).toEqual(REDACTED);
    // A key whose base64 has `+` and `/`, so that the url-safe form is a different text.
    const odd = "k1?>?>?>?>?>z9y8x7?>";
    const b64 = Buffer.from(odd).toString("base64");
    const url = Buffer.from(odd).toString("base64url");
    expect(b64).not.toBe(url);
    const at = url.search(/[-_]/);
    expect(at).toBeGreaterThanOrEqual(0);
    const window = url.slice(Math.max(0, at - 4), Math.max(0, at - 4) + 8);
    expect(b64.includes(window)).toBe(false);
    expect(say(`got ${b64}`, odd)).toEqual(REDACTED);
    expect(say(`got ${window}`, odd)).toEqual(REDACTED);
    // Percent-encoded: a key with reserved characters fewer than 6 apart has no 6-run left in that form.
    const reserved = "abc+def/ghi=jkl+mno";
    expect(holdsKeyPiece(encodeURIComponent(reserved), reserved)).toBe(false);
    expect(say(`got ${encodeURIComponent(reserved)}`, reserved)).toEqual(REDACTED);
    expect(say(`got ${encodeURIComponent(reserved).toLowerCase()}`, reserved)).toEqual(REDACTED);
    expect(say(`got abc%2Bdef%2Fghi`, reserved)).toEqual(REDACTED);
    // \uXXXX escapes (a doubly escaped JSON text), decoding to a 6-run of the key.
    const escaped = [...KEY.slice(0, 12)].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    expect(upstreamDetail(401, `bad ${escaped}`, KEY)).toEqual(REDACTED);
    expect(say(`bad ${escaped}`)).toEqual(REDACTED);
    // Seven characters of base64 are a coincidence, not the key.
    expect(say(`ref ${b64.slice(3, 10)}`, odd)).toEqual({ upstreamStatus: "401", message: `ref ${b64.slice(3, 10)}` });
  });

  it("test and models/list answer the detail alike; the refresh never does, nor the log", async () => {
    const owner = await signUp(app, "debugger");
    const p = await provider(owner, { models: [{ name: "kept" }] });
    const cases: Array<[number, string, string, object]> = [
      [404, JSON.stringify({ error: { message: "Route /v1/models not found" } }), "application/json", { message: "Route /v1/models not found" }],
      [401, JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), "application/json", { message: null, redacted: true }],
      [403, JSON.stringify({ error: { message: `key ${KEY.slice(3, 3 + KEY_PIECE)} blocked` } }), "application/json", { message: null, redacted: true }],
      [500, JSON.stringify({ error: { message: "oops" }, echo: { authorization: `Bearer ${KEY.toUpperCase()}` } }), "application/json", { message: null, redacted: true }],
      [503, "<html><body>Bad gateway\n\u001b[0m</body></html>", "text/html", { message: "<html><body>Bad gateway [0m</body></html>" }],
      [502, `{"error":{"message":"${"x".repeat(70_000)}"}}`, "application/json", { message: `{"error":{"message":"${"x".repeat(DETAIL_CHARS - 21)}` }],
      [200, "<!doctype html><title>Welcome</title>", "text/html", { message: "<!doctype html><title>Welcome</title>" }],
    ];
    for (const [status, body, type, said] of cases) {
      stub.answer(failWith(status, body, type));
      const [test, list] = [await testOf(owner, p.id), await listOf(owner, p.id)];
      const error = status === 401 || status === 403 ? "provider_rejected" : "provider_unavailable";
      const expected = { ok: false, error, upstreamStatus: String(status), detail: { upstreamStatus: String(status), ...said } };
      expect([status, test.json]).toEqual([status, expected]);
      expect([status, list.json]).toEqual([status, expected]);
      for (const raw of [test.raw, list.raw]) expect([status, holdsKeyPiece(raw, KEY)]).toEqual([status, false]);
      const refresh = await call(owner, `/api/providers/${p.id}/models/refresh`);
      expect([status, refresh.status, refresh.json]).toEqual([status, 502, { error }]);
    }
    // The log says as much as before: provider, protocol, code and status; nothing the upstream said, nothing of the key.
    const log = lines.join("\n");
    for (const said of ["Route /v1/models", "Incorrect API key", "Bad gateway", "Welcome", "oops", "xxxxxxxx"]) expect([said, log.includes(said)]).toEqual([said, false]);
    expect(holdsKeyPiece(log, KEY)).toBe(false);
    const failures = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.msg === "provider call failed");
    expect(failures).toHaveLength(cases.length * 3);
    for (const e of failures) expect(Object.keys(e).filter((k) => !["level", "time", "pid", "hostname", "reqId", "msg"].includes(k)).sort()).toEqual(["error", "protocol", "providerId", "upstreamStatus"]);
  });

  it("a model name from the upstream's list that holds a 6-character run of the key (not only the whole key) is not offered", async () => {
    const owner = await signUp(app, "lister2");
    const p = await provider(owner);
    const names = ["fine-model", `pre-${KEY.slice(4, 4 + KEY_PIECE)}-post`, `${KEY.slice(-9).toUpperCase()}`, `has-${KEY.slice(0, 5)}-only`, KEY, "other-model"];
    stub.answer((_req, res) => send(res, 200, { data: names.map((id) => ({ id })) }));
    const res = await listOf(owner, p.id);
    expect(res.status).toBe(200);
    expect((res.json.listed as Array<{ name: string }>).map((m) => m.name)).toEqual(["fine-model", `has-${KEY.slice(0, 5)}-only`, "other-model"]);
    expect(holdsKeyPiece(res.raw, KEY)).toBe(false);
  });

  it("no detail without an upstream answer: a refused address, an unreachable host", async () => {
    const owner = await signUp(app, "nowhere");
    const p = await provider(owner, { baseUrl: "https://192.168.0.10/v1" });
    expect((await testOf(owner, p.id)).json).toEqual({ ok: false, error: "address_not_allowed" });
    expect((await listOf(owner, p.id)).json).toEqual({ ok: false, error: "address_not_allowed" });
    const closed = await provider(owner, { name: "closed", baseUrl: "http://127.0.0.1:1/v1" });
    expect((await testOf(owner, closed.id)).json).toEqual({ ok: false, error: "provider_unavailable" });
  });
});

describe("the connection test names its upstream as a reply does", () => {
  const gateway = scriptedGateway();
  const second = useApp({ models: gateway, allowInsecureLocal: true });

  it("the call carries upstreamId provider:<id>@<baseUrl>, the key src/models/resolve.ts gives a reply, so a refusal learnt by one is honoured by the other", async () => {
    const owner = await signUp(second.app, "namer");
    const created = await api(second.app, owner, "POST", "/api/providers", providerBody({ apiKey: KEY, baseUrl: "https://Api.Example.com/", models: [{ name: "m", reasoning: true }] }));
    expect(created.status).toBe(201);
    const { id, baseUrl } = created.json as { id: string; baseUrl: string };
    expect(baseUrl).toBe("https://api.example.com/v1");
    gateway.reply("hi");
    const res = await api(second.app, owner, "POST", `/api/providers/${id}/test`, { model: "m" });
    expect(res.json).toMatchObject({ ok: true, mode: "chat" });
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.upstreamId).toBe(`provider:${id}@${baseUrl}`);
  });
});
