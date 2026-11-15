import { randomUUID } from "node:crypto";
import net from "node:net";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { RouteEntry } from "../src/app.ts";
import { createInvite } from "../src/auth/invites.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { BOUNDARY, CLOSING, MULTIPART, multipart, partHead } from "./helpers/multipart.ts";
import { APP_ORIGIN, issueTicket, listen, tryConnect } from "./helpers/ws.ts";

/**
 * Robustness: every route the app registers (read from `app.routeList`, so a route added later is fuzzed
 * without touching this file) gets malformed paths, queries, bodies and content types, signed in and
 * signed out. Every answer must be < 500; every 4xx must be a well-formed `{"error": "<snake_case>"}`
 * JSON body; and the process must still serve `/api/health` afterwards.
 */

const { blobs } = useProbeBlobs("af-fuzz-");
const { app } = useApp({ blobs });

const FUZZ_TIMEOUT = 120_000;
const UUID = "3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b";
const MEGA = "x".repeat(1_000_000);

// --- the verdict ----------------------------------------------------------------------------------

interface Finding {
  probe: string;
  status: number;
  why: string;
  body: string;
}

const SNAKE = /^[a-z][a-z0-9_]*$/;

/** Why `res` is not an acceptable answer, or null. */
function verdict(method: string, res: LightMyRequestResponse): string | null {
  if (res.statusCode >= 500) return `status ${res.statusCode}`;
  if (method === "HEAD" || res.statusCode < 400) return null;
  if (!String(res.headers["content-type"] ?? "").startsWith("application/json")) return "4xx without a JSON content type";
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    return "4xx body is not JSON";
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return "4xx body is not an object";
  const { error, ...rest } = json as Record<string, unknown>;
  if (typeof error !== "string" || !SNAKE.test(error)) return "4xx body has no snake_case error";
  if (Object.values(rest).some((v) => typeof v !== "string")) return "4xx body has a non-string extra field";
  return null;
}

/** Sends probes in order, recording every bad answer; returns every status. */
async function probeAll(probes: Array<InjectOptions & { label: string }>, findings: Finding[]): Promise<number[]> {
  const statuses: number[] = [];
  for (const { label, ...opts } of probes) {
    const res = await app.inject(opts);
    statuses.push(res.statusCode);
    const why = verdict(String(opts.method), res);
    if (why) findings.push({ probe: label, status: res.statusCode, why, body: res.body.slice(0, 300) });
  }
  return statuses;
}

async function stillHealthy(): Promise<void> {
  const res = await app.inject({ method: "GET", url: "/api/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
}

// --- malformed values -------------------------------------------------------------------------------

/** Path segment values: never a canonical UUID or a positive integer. */
const BAD_PATH = [
  "abc",
  "1",
  "0",
  "-1",
  "1.5",
  "1e400",
  "NaN",
  "Infinity",
  "12345678901234567890123",
  "%00",
  "%ED%A0%80", // a lone surrogate, UTF-8 encoded (invalid UTF-8)
  "%F0%9F%98", // a truncated UTF-8 sequence
  "%",
  "%zz",
  "%2F",
  "a%2Fb",
  "%2F..%2F",
  "..",
  "%2e%2e",
  ".",
  "%20",
  "x".repeat(10_000),
  UUID.toUpperCase(),
  `{${UUID}}`,
  `${UUID}%00`,
  `${UUID}%2F..`,
  "00000000-0000-0000-0000-000000000000",
];

/** Query values (already URL-encoded). */
const BAD_QUERY = [
  "",
  "abc",
  "-1",
  "0",
  "1.5",
  "1e400",
  "NaN",
  "12345678901234567890123",
  "%00",
  "%ED%A0%80",
  "%0A",
  "%E2%80%AE",
  "%",
  encodeURIComponent(MEGA),
];

/** JSON texts put in place of one field of an otherwise plausible body. */
const BAD_JSON = [
  "null",
  "[]",
  "[1]",
  "{}",
  '{"a":1}',
  '"1"',
  "1",
  "-1",
  "0",
  "-0",
  "1.5",
  "true",
  "1e400",
  "-1e400",
  "12345678901234567890123",
  '"NaN"',
  '"\\u0000"',
  '"a\\u0000b"',
  '"\\ud800"',
  '"\\udfff\\ud800"',
  JSON.stringify(MEGA),
  '""',
  '" "',
  '"\\n"',
  '"%00"',
  '"../.."',
  JSON.stringify(UUID.toUpperCase()),
  JSON.stringify(randomUUID()),
  '"<script>alert(1)</script>"',
  '{"__proto__":{"polluted":true}}',
  '{"constructor":{"prototype":{"polluted":true}}}',
  `[${'"a",'.repeat(10_000)}"a"]`,
];

/** Whole request bodies (raw text, sent as application/json). */
const BAD_BODIES = [
  "null",
  "[]",
  '"x"',
  "1",
  "true",
  "{",
  '{"a":',
  "NaN",
  "1e400",
  "\u0000",
  JSON.stringify(MEGA),
  '{"__proto__":{"polluted":true}}',
  JSON.stringify({ pad: "y".repeat(2 * 1024 * 1024) }), // over the body limit
];

/** Content types sent with an otherwise plausible JSON body. */
const BAD_CONTENT_TYPES = [
  "text/plain",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  `multipart/form-data; boundary=${BOUNDARY}`,
  "application/json; charset=utf-16",
  "application/json; charset=bogus",
  "application/octet-stream",
  "image/png",
  "",
];

const HOLE = "\u0001fuzz-hole\u0001";

/** `body` with `field` replaced by the raw JSON text `raw`. */
function withField(body: Record<string, unknown>, field: string, raw: string): string {
  return JSON.stringify({ ...body, [field]: HOLE }).replace(JSON.stringify(HOLE), raw);
}

/** The keys of a zod object schema, looking through optional/nullable/default/pipe wrappers. */
function shapeKeys(schema: unknown): string[] {
  let s = schema as { _zod?: { def: Record<string, any> } } | undefined;
  for (let depth = 0; depth < 10 && s?._zod; depth++) {
    const def = s._zod.def;
    if (def.type === "object") return Object.keys(def.shape);
    if (["optional", "nullable", "default", "catch", "readonly", "nonoptional"].includes(def.type)) s = def.innerType;
    else if (def.type === "pipe") s = def.in;
    else return [];
  }
  return [];
}

const params = (url: string): string[] => [...url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
const fill = (url: string, values: Record<string, string>): string =>
  url.replace(/:([A-Za-z]+)/g, (_, name: string) => values[name] ?? UUID);

// --- fixtures -----------------------------------------------------------------------------------------

interface Fixture {
  me: Actor;
  peer: Actor;
  victim: Actor;
  stranger: Actor;
  group: string;
  dm: string;
  attachment: string;
  request: string;
  invite: string;
}

async function fixture(): Promise<Fixture> {
  const [me, peer, victim, stranger] = [
    await signUp(app, "fuzzer"),
    await signUp(app, "peer"),
    await signUp(app, "victim"),
    await signUp(app, "stranger"),
  ];
  const { conversationId: dm } = await befriend(app, me, peer);
  const g = await group(app, me, "fuzz", [peer, victim]);
  const said = await api(app, me, "POST", `/api/conversations/${g}/messages`, { text: "hello", clientTxn: "fx1" });
  if (said.status !== 201) throw new Error(`fixture send ${said.status}`);
  const up = await app.inject({
    method: "POST",
    url: `/api/conversations/${g}/attachments`,
    headers: { cookie: me.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename: "a.txt", type: "text/plain", data: "bytes" }]),
  });
  if (up.statusCode !== 201) throw new Error(`fixture upload ${up.statusCode}`);
  const attachment = up.json().id as string;
  await api(app, me, "POST", `/api/conversations/${g}/messages`, { attachmentId: attachment, clientTxn: "fx2" });
  const req = await api(app, stranger, "POST", "/api/friend-requests", { handle: me.handle });
  if (req.status !== 201) throw new Error(`fixture request ${req.status}`);
  return {
    me,
    peer,
    victim,
    stranger,
    group: g,
    dm,
    attachment,
    request: req.json.id,
    invite: await createInvite(app.deps.db, { ttlHours: 1 }),
  };
}

/** A real id for each path parameter, so malformed bodies and queries reach as deep as they can. */
function validParams(url: string, fx: Fixture): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of params(url)) {
    if (name === "seq") out[name] = "2";
    else if (name === "principalId") out[name] = fx.victim.id; // the one whose removal, unfriending or blocking costs nothing
    else {
      const collection = url.split(`/:${name}`)[0]!.split("/").pop();
      out[name] =
        collection === "conversations"
          ? fx.group
          : collection === "attachments"
            ? fx.attachment
            : collection === "friend-requests"
              ? fx.request
              : collection === "principals"
                ? fx.peer.id
                : randomUUID(); // a route added later: still fuzzed, with an id nobody has
    }
  }
  return out;
}

let unique = 0;

/** A plausible body for known routes (so one broken field is the only problem); `{}` for anything else. */
function plausibleBody(route: RouteEntry, fx: Fixture): Record<string, unknown> {
  const n = ++unique;
  switch (`${route.method} ${route.url}`) {
    case "POST /api/register":
      return { inviteCode: fx.invite, email: `fz${n}@example.test`, password: "fuzz-password-1", displayName: "Fuzz", handle: `fz${n}` };
    case "POST /api/friend-requests":
      return { handle: fx.peer.handle };
    case "PATCH /api/me":
      return { displayName: "Fuzz" };
    case "POST /api/conversations":
      return { title: "t", memberIds: [fx.peer.id, fx.victim.id] };
    case "PATCH /api/conversations/:id":
      return { title: "t" };
    case "POST /api/conversations/:id/members":
      return { principalId: fx.victim.id };
    case "POST /api/conversations/:id/messages":
      return { text: "hi", clientTxn: `fz${n}` };
    case "POST /api/conversations/:id/read":
      return { seq: 1 };
    case "POST /api/sync/catchup":
      return { positions: { [fx.group]: 0 } };
    default:
      return {};
  }
}

/** A plausible query for known routes. */
function plausibleQuery(keys: string[], fx: Fixture): Record<string, string> {
  const q: Record<string, string> = {};
  if (keys.includes("q")) q.q = "hi";
  if (keys.includes("handle")) q.handle = fx.peer.handle;
  if (keys.includes("ticket")) q.ticket = "nope";
  return q;
}

const qs = (q: Record<string, string>): string => {
  const s = Object.entries(q)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return s ? `?${s}` : "";
};

const HAS_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Every probe for one route, each to be sent signed in and signed out. */
function probesFor(route: RouteEntry, fx: Fixture): Array<InjectOptions & { label: string }> {
  const { method, url } = route;
  const good = validParams(url, fx);
  const queryKeys = shapeKeys(route.schema?.querystring);
  const baseQuery = plausibleQuery(queryKeys, fx);
  const at = (values: Record<string, string>, query = baseQuery) => fill(url, values) + qs(query);
  const out: Array<Omit<InjectOptions, "method"> & { label: string }> = [];

  // Paths: each parameter in turn takes every malformed value, the others stay real.
  for (const name of params(url)) {
    for (const bad of BAD_PATH) out.push({ label: `path ${name}=${bad.slice(0, 40)}`, url: at({ ...good, [name]: bad }) });
  }

  // Queries: each known key in turn takes every malformed value, repeated, or nested; plus unknown keys.
  for (const key of queryKeys) {
    for (const bad of BAD_QUERY) out.push({ label: `query ${key}=${bad.slice(0, 40)}`, url: at(good, { ...baseQuery, [key]: bad }) });
    out.push({ label: `query ${key} twice`, url: at(good) + `${Object.keys(baseQuery).length ? "&" : "?"}${key}=1&${key}=2` });
    out.push({ label: `query ${key}[a]`, url: fill(url, good) + `?${key}[a]=1&${key}[]=2` });
  }
  out.push({ label: "query unknown key", url: at(good, { ...baseQuery, zzz: "1", __proto__x: "1" }) });

  // Bodies.
  if (HAS_BODY.has(method)) {
    const body = plausibleBody(route, fx);
    const fields = [...new Set([...Object.keys(body), ...shapeKeys(route.schema?.body)])];
    const json = (payload: string | undefined, contentType = "application/json") => ({
      url: at(good),
      ...(payload === undefined ? {} : { payload, headers: contentType ? { "content-type": contentType } : {} }),
    });
    out.push({ label: "no body", ...json(undefined) });
    for (const raw of BAD_BODIES) out.push({ label: `body ${raw.slice(0, 40)}`, ...json(raw) });
    for (const ct of BAD_CONTENT_TYPES) out.push({ label: `content-type "${ct}"`, ...json(JSON.stringify(body), ct) });
    for (const field of fields) {
      for (const raw of BAD_JSON) out.push({ label: `body.${field}=${raw.slice(0, 40)}`, ...json(withField(body, field, raw)) });
    }
  }
  return out.map((p) => ({ ...p, method: method as InjectOptions["method"] }));
}

/** Every probe as given, plus the same without the session cookie. */
function signedInAndOut(probes: Array<InjectOptions & { label: string }>, cookie: string) {
  return probes.flatMap((p) => [
    { ...p, label: `${p.label} [signed in]`, headers: { ...(p.headers as object), cookie } },
    { ...p, label: `${p.label} [signed out]` },
  ]);
}

// --- the suites -----------------------------------------------------------------------------------------

const isAuthMount = (r: RouteEntry) => r.url.endsWith("/*");

describe("fuzz", () => {
  it("every route answers malformed paths, queries and bodies with < 500 and a well-formed error", { timeout: FUZZ_TIMEOUT }, async () => {
    const fx = await fixture();
    const routes = app.routeList.filter((r) => !isAuthMount(r));
    // The table really is the app's: spot-check routes from every module.
    const names = new Set(routes.map((r) => `${r.method} ${r.url}`));
    for (const known of [
      "GET /api/health",
      "POST /api/register",
      "GET /api/principals/lookup",
      "PUT /api/me/avatar",
      "POST /api/friend-requests/:id/accept",
      "DELETE /api/conversations/:id/members/:principalId",
      "GET /api/conversations/:id/messages/:seq",
      "POST /api/conversations/:id/attachments",
      "GET /api/search",
      "POST /api/sync/catchup",
      "GET /api/ws",
      "HEAD /api/sync",
    ]) {
      expect(names).toContain(known);
    }

    const findings: Finding[] = [];
    const sent = await Promise.all(routes.map((r) => probeAll(signedInAndOut(probesFor(r, fx), fx.me.cookie), findings)));
    expect(findings).toEqual([]);
    expect(sent.flat().length).toBeGreaterThan(4000);
    await stillHealthy();
  });

  it("the Better Auth mount answers every path and malformed body with < 500 and a well-formed error", { timeout: FUZZ_TIMEOUT }, async () => {
    // Its own actor: sign-out probes end the session they carry.
    const me = await signUp(app, "authfuzz");
    const mounts = app.routeList.filter(isAuthMount);
    expect(mounts.map((r) => r.method).sort()).toEqual(["GET", "HEAD", "POST"]);
    const bodies: Record<string, Record<string, unknown>> = {
      "sign-in/email": { email: me.email, password: "not the password" },
      "request-password-reset": { email: me.email, redirectTo: "/reset" },
      "reset-password": { newPassword: "fuzz-password-2", token: "not-a-token" },
      "sign-out": {},
      "verify-email": {},
      "sign-up/email": { email: "new@example.test", password: "fuzz-password-1", name: "x" },
    };
    const extraFields = ["email", "password", "newPassword", "token", "callbackURL", "rememberMe", "redirectTo", "name"];
    const paths = [
      ...Object.keys(bodies),
      "get-session",
      "list-sessions",
      "",
      "..",
      "%2e%2e/%2e%2e/api/me",
      "sign-in/email/",
      "SIGN-IN/EMAIL",
      "sign-in%2Femail",
      "%00",
      "%ED%A0%80",
      "%",
      "x".repeat(5000),
    ];
    const probes: Array<InjectOptions & { label: string }> = [];
    for (const mount of mounts) {
      for (const path of paths) {
        const url = mount.url.replace("*", path);
        const base = { method: mount.method as InjectOptions["method"], url };
        probes.push({ ...base, label: `${mount.method} ${path.slice(0, 40)}` });
        for (const bad of BAD_QUERY) {
          probes.push({ ...base, url: `${url}?token=${bad}&callbackURL=${bad}`, label: `${mount.method} ${path.slice(0, 40)} ?token=${bad.slice(0, 30)}` });
        }
        if (mount.method !== "POST") continue;
        const body = bodies[path] ?? {};
        for (const raw of BAD_BODIES) {
          probes.push({ ...base, payload: raw, headers: { "content-type": "application/json" }, label: `POST ${path.slice(0, 40)} body ${raw.slice(0, 30)}` });
        }
        for (const ct of BAD_CONTENT_TYPES) {
          probes.push({ ...base, payload: JSON.stringify(body), headers: { "content-type": ct }, label: `POST ${path.slice(0, 40)} ct "${ct}"` });
        }
        for (const field of [...new Set([...Object.keys(body), ...extraFields])]) {
          for (const raw of BAD_JSON) {
            probes.push({
              ...base,
              payload: withField(body, field, raw),
              headers: { "content-type": "application/json" },
              label: `POST ${path.slice(0, 40)} body.${field}=${raw.slice(0, 30)}`,
            });
          }
        }
      }
    }
    const findings: Finding[] = [];
    // Signed out first: the signed-in pass ends its own session at its first sign-out.
    await probeAll(probes, findings);
    await probeAll(signedInAndOut(probes, me.cookie).filter((p) => p.label.endsWith("[signed in]")), findings);
    expect(findings).toEqual([]);
    await stillHealthy();
  });

  it("the upload route answers malformed multipart with < 500, keeps nothing, and keeps serving", { timeout: FUZZ_TIMEOUT }, async () => {
    const fx = await fixture();
    const url = `/api/conversations/${fx.group}/attachments`;
    expect(app.routeList.some((r) => r.method === "POST" && r.url === "/api/conversations/:id/attachments")).toBe(true);
    const file = (data = "bytes") => partHead({ name: "file", filename: "f.txt", type: "text/plain" }) + data;
    const cases: Array<{ label: string; contentType: string; payload: string | Buffer }> = [
      { label: "no boundary", contentType: "multipart/form-data", payload: file() + CLOSING },
      { label: "empty boundary", contentType: "multipart/form-data; boundary=", payload: file() + CLOSING },
      { label: "boundary of 200 characters", contentType: `multipart/form-data; boundary=${"b".repeat(200)}`, payload: file() + CLOSING },
      { label: "boundary mismatch", contentType: "multipart/form-data; boundary=other", payload: file() + CLOSING },
      { label: "truncated body", contentType: MULTIPART, payload: file("half a fi") },
      { label: "truncated part head", contentType: MULTIPART, payload: `--${BOUNDARY}\r\nContent-Dispo` },
      { label: "only the closing delimiter", contentType: MULTIPART, payload: `--${BOUNDARY}--\r\n` },
      { label: "empty body", contentType: MULTIPART, payload: "" },
      { label: "garbage", contentType: MULTIPART, payload: Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a, 0x2d, 0x2d]) },
      { label: "wrong part name", contentType: MULTIPART, payload: multipart([{ name: "files", filename: "f.txt", data: "x" }]) },
      { label: "a field, not a file", contentType: MULTIPART, payload: multipart([{ name: "file", data: "x" }]) },
      { label: "two files", contentType: MULTIPART, payload: multipart([{ name: "file", filename: "a", data: "1" }, { name: "file", filename: "b", data: "2" }]) },
      { label: "no Content-Disposition", contentType: MULTIPART, payload: `--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nx${CLOSING}` },
      {
        label: "huge part header",
        contentType: MULTIPART,
        payload: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${"n".repeat(200_000)}"\r\n\r\nx${CLOSING}`,
      },
      {
        label: "many part headers",
        contentType: MULTIPART,
        payload: `--${BOUNDARY}\r\n${Array.from({ length: 500 }, (_, i) => `X-H${i}: v`).join("\r\n")}\r\nContent-Disposition: form-data; name="file"; filename="f"\r\n\r\nx${CLOSING}`,
      },
      { label: "NUL and lone surrogate in the file name", contentType: MULTIPART, payload: multipart([{ name: "file", filename: "a\u0000b\ud800.txt", data: "x" }]) },
      { label: "invalid UTF-8 in the file name", contentType: MULTIPART, payload: Buffer.concat([Buffer.from(partHead({ name: "file", filename: "" }).replace('filename=""', 'filename="')), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from('"\r\n\r\nx' + CLOSING)]) },
      { label: "path traversal in the file name", contentType: MULTIPART, payload: multipart([{ name: "file", filename: "../../../etc/passwd", data: "x" }]) },
      { label: "multipart/mixed", contentType: `multipart/mixed; boundary=${BOUNDARY}`, payload: file() + CLOSING },
      { label: "JSON", contentType: "application/json", payload: "{}" },
    ];
    const findings: Finding[] = [];
    const probes = cases.map((c) => ({ label: c.label, method: "POST" as const, url, headers: { "content-type": c.contentType }, payload: c.payload }));
    const statuses = await probeAll(signedInAndOut(probes, fx.me.cookie), findings);
    // The same against a conversation id that is not one.
    await probeAll(signedInAndOut(probes.map((p) => ({ ...p, url: "/api/conversations/abc/attachments", label: `${p.label} (bad id)` })), fx.me.cookie), findings);
    expect(findings).toEqual([]);
    // Something was refused, and only what was accepted is kept: no stray row, blob or held key, no slot taken.
    const accepted = statuses.filter((s) => s === 201).length;
    expect(statuses.filter((s) => s === 400).length).toBeGreaterThan(10);
    const count = async (sql: string) => Number((await app.deps.db.query<{ n: string }>(sql)).rows[0]!.n);
    expect(await count("select count(*) n from attachments")).toBe(1 + accepted);
    await vi.waitFor(async () => expect(await count("select count(*) n from pending_blobs")).toBe(0));
    expect(app.deps.uploads.inProgress()).toBe(0);
    const names = (await app.deps.db.query<{ name: string }>("select name from attachments")).rows.map((r) => r.name);
    expect(names.every((n) => !/[\u0000-\u001f\ud800-\udfff/\\]/.test(n))).toBe(true);
    await stillHealthy();
  });

  it("the avatar routes answer malformed bodies and ids with < 500", { timeout: FUZZ_TIMEOUT }, async () => {
    const fx = await fixture();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d7e2d10000000049454e44ae426082", "hex");
    const cases: Array<{ label: string; contentType?: string; payload?: string | Buffer }> = [
      { label: "no body" },
      { label: "empty png", contentType: "image/png", payload: Buffer.alloc(0) },
      { label: "text as png", contentType: "image/png", payload: "not a png" },
      { label: "svg", contentType: "image/svg+xml", payload: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
      { label: "json", contentType: "application/json", payload: "{}" },
      { label: "upper-case type", contentType: "IMAGE/PNG", payload: png },
      { label: "type with parameters", contentType: "image/png; charset=utf-8", payload: png },
      { label: "multipart", contentType: MULTIPART, payload: multipart([{ name: "file", filename: "a.png", data: png }]) },
      { label: "octet-stream png", contentType: "application/octet-stream", payload: png },
      { label: "truncated png", contentType: "image/png", payload: png.subarray(0, 20) },
      { label: "over 2 MB", contentType: "image/png", payload: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]) },
      { label: "garbage type", contentType: "image/", payload: png },
    ];
    const findings: Finding[] = [];
    const puts = cases.map((c) => ({
      label: c.label,
      method: "PUT" as const,
      url: "/api/me/avatar",
      ...(c.contentType === undefined ? {} : { headers: { "content-type": c.contentType } }),
      ...(c.payload === undefined ? {} : { payload: c.payload }),
    }));
    await probeAll(signedInAndOut(puts, fx.me.cookie), findings);
    const gets = [fx.peer.id, fx.me.id, randomUUID(), ...BAD_PATH].map((id) => ({
      label: `avatar of ${id.slice(0, 40)}`,
      method: "GET" as const,
      url: `/api/principals/${id}/avatar`,
    }));
    await probeAll(signedInAndOut(gets, fx.me.cookie), findings);
    expect(findings).toEqual([]);
    await stillHealthy();
  });

  it("the WebSocket route refuses bad tickets, foreign origins and plain GETs with < 500 and keeps serving", { timeout: FUZZ_TIMEOUT }, async () => {
    const fx = await fixture();
    const statuses: Array<[string, number | "open"]> = [];
    const attempt = async (label: string, opts: Parameters<typeof tryConnect>[1]) => {
      const r = await tryConnect(app, opts);
      if ("socket" in r) {
        r.socket.close();
        statuses.push([label, "open"]);
      } else {
        statuses.push([label, r.status]);
      }
    };
    await attempt("no ticket", { ticket: null });
    for (const bad of ["", "nope", "x".repeat(128), "x".repeat(129), "x".repeat(5000), "\u0000", "\n", "../..", UUID]) {
      await attempt(`ticket ${JSON.stringify(bad.slice(0, 20))}`, { ticket: bad });
    }
    await attempt("foreign origin", { ticket: await issueTicket(app, fx.me), origin: "https://evil.example.test" });
    await attempt("no origin", { ticket: await issueTicket(app, fx.me), origin: null });
    await attempt("origin null", { ticket: await issueTicket(app, fx.me), origin: "null" });
    await attempt("good", { ticket: await issueTicket(app, fx.me) });
    expect(statuses.filter(([, s]) => s === "open").map(([l]) => l)).toEqual(["good"]);
    expect(statuses.filter(([, s]) => s !== "open" && (s >= 500 || s < 400))).toEqual([]);

    // Raw upgrade requests no client library would send.
    const { port } = await listen(app);
    const raw = async (request: string): Promise<string> =>
      new Promise((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        let got = "";
        socket.on("data", (c) => (got += c.toString("latin1")));
        socket.on("error", () => {});
        socket.on("close", () => resolve(got));
        socket.setTimeout(3000, () => socket.destroy());
        socket.write(request);
      });
    const head = (lines: string[]) => [...lines, "", ""].join("\r\n");
    const upgradeHeaders = [`Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", `Origin: ${APP_ORIGIN}`];
    const answers = [
      await raw(head(["GET /api/ws?ticket=x HTTP/1.1", ...upgradeHeaders])), // no key, no version
      await raw(head(["GET /api/ws?ticket=x HTTP/1.1", ...upgradeHeaders, "Sec-WebSocket-Key: short", "Sec-WebSocket-Version: 99"])),
      await raw(head(["GET /api/ws?ticket=%ED%A0%80 HTTP/1.1", ...upgradeHeaders, "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"])),
      await raw(head(["GET /api/ws?ticket=a&ticket=b HTTP/1.1", ...upgradeHeaders, "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"])),
      await raw(head(["GET /%61pi/ws?ticket=x HTTP/1.1", ...upgradeHeaders, "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"])),
      await raw(head(["POST /api/ws?ticket=x HTTP/1.1", ...upgradeHeaders, "Content-Length: 0"])),
    ];
    for (const answer of answers) {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? 0);
      // Either an HTTP refusal or a dropped connection, never a server error or an open socket.
      expect(status === 0 || (status >= 400 && status < 500)).toBe(true);
    }

    // A plain GET (no upgrade) is not an upgrade: 404 or 400, never spending a ticket.
    const ticket = await issueTicket(app, fx.me);
    expect(await api(app, fx.me, "GET", `/api/ws?ticket=${ticket}`)).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await api(app, null, "GET", "/api/ws")).toEqual({ status: 400, json: { error: "invalid_request" } });
    expect("socket" in (await tryConnect(app, { ticket }))).toBe(true);
    await stillHealthy();
  });
});
