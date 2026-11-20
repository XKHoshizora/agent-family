import { afterEach, describe, expect, it } from "vitest";
import { memoryCall, type MemoryCallDeps } from "../src/memory/call.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { costOf, grant, METER_ENV } from "./helpers/metering.ts";
import { providerBody } from "./helpers/providers.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * The owner's choice of the model that tidies their memory (`accounts.memory_model`; README "Memory calls" and
 * `PATCH /api/me`): null is the site's memory model; anything else is a model the owner could give an Agent, metered as a
 * reply on it is, and never replaced by the site's when it cannot be used.
 */

const gateway = scriptedGateway();
const log = { error: () => undefined, warn: () => undefined };
const { app, db } = useApp({ env: METER_ENV, models: gateway, agentWorker: false });

afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const USAGE = { inputTokens: 100, outputTokens: 50 } as const;
const INPUT = { system: "你是记忆助手。", user: "主人说：我喜欢喝茶。", maxOutputTokens: 100 } as const;
const never = new AbortController().signal;
const deps = (over: Partial<MemoryCallDeps> = {}): MemoryCallDeps => ({ db, models: gateway, config: app.deps.config, log, inFlight: new Set(), ...over });

const SITE_FREE = { source: "site", id: "meter_free" } as const;
const SITE_PAID = { source: "site", id: "meter_paid" } as const;

const setModel = (who: Actor, memoryModel: unknown) => api(app, who, "PATCH", "/api/me", { memoryModel });
/** A choice as a row written before a rule refused it would hold it. */
const storeChoice = (ownerId: string, choice: unknown) =>
  db.query("insert into accounts (principal_id, memory_model) values ($1, $2::jsonb) on conflict (principal_id) do update set memory_model = excluded.memory_model", [ownerId, JSON.stringify(choice)]);
const me = async (who: Actor) => (await api(app, who, "GET", "/api/me")).json;
const addProvider = async (who: Actor, models: unknown[] = [{ name: "own-model", contextTokens: 50_000 }], name = "My provider") =>
  (await api(app, who, "POST", "/api/providers", providerBody({ name, baseUrl: "https://own.example.test/v1", models }))).json.id as string;
const records = async (ownerId: string) =>
  (
    await db.query(
      `select purpose, agent_id, source, model, input_tokens::text, output_tokens::text, cost_micro::text, free_micro::text,
              balance_micro::text, memory_micro::text, outcome from usage_records where owner_id = $1 order by id`,
      [ownerId],
    )
  ).rows;
const runs = async (ownerId: string) =>
  (await db.query("select purpose, status, source, model, charge_to, hold_micro::text as hold from agent_runs where owner_id = $1 order by created_at", [ownerId])).rows;
const memoryUsed = async (ownerId: string) => (await db.query("select used_micro::text as used from memory_usage where owner_id = $1", [ownerId])).rows;
const freeUsed = async (ownerId: string) => (await db.query("select used_micro::text as used from free_usage where owner_id = $1", [ownerId])).rows;
const balance = async (ownerId: string) => (await db.query("select balance_micro::text as b from accounts where principal_id = $1", [ownerId])).rows[0]?.b;

describe("the owner's memory model", () => {
  it("is null at first (the site's model, charged to the memory allowance), and usable", async () => {
    const owner = await signUp(app, "mmdefault");
    expect(await me(owner)).toMatchObject({ memoryModel: null, memoryModelUsable: true });
    gateway.reply("好", { usage: USAGE });
    const first = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBe("好");
    expect(gateway.calls[first]!.model).toBe("upstream-meter_free");
    expect(await freeUsed(owner.id)).toEqual([]);
    expect(await memoryUsed(owner.id)).toEqual([{ used: costOf(USAGE).toString() }]);
  });

  it("a model of their own provider: that model is called, no site point is charged, the usage record is purpose memory and costs nothing", async () => {
    const owner = await signUp(app, "mmown");
    const providerId = await addProvider(owner);
    const choice = { source: "provider", providerId, model: "own-model" };
    expect((await setModel(owner, choice)).status).toBe(200);
    expect(await me(owner)).toMatchObject({ memoryModel: choice, memoryModelUsable: true });

    gateway.reply("  喜欢喝茶  ", { usage: USAGE });
    const first = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBe("喜欢喝茶");
    const call = gateway.calls[first]!;
    expect({ model: call.model, baseUrl: call.baseUrl, reasoning: call.reasoning, maxOutputTokens: call.maxOutputTokens }).toEqual({
      model: "own-model",
      baseUrl: "https://own.example.test/v1",
      reasoning: "none",
      maxOutputTokens: 100,
    });

    expect(await freeUsed(owner.id)).toEqual([]);
    expect(await runs(owner.id)).toEqual([{ purpose: "memory", status: "done", source: "provider", model: "own-model", charge_to: null, hold: "0" }]);
    expect(await records(owner.id)).toEqual([
      { purpose: "memory", agent_id: null, source: "provider", model: "own-model", input_tokens: "100", output_tokens: "50", cost_micro: "0", free_micro: "0", balance_micro: "0", memory_micro: "0", outcome: "done" },
    ]);
  });

  it("an owner out of the memory allowance still gets their own model's reviews", async () => {
    const owner = await signUp(app, "mmbroke");
    await db.query("insert into memory_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, 20000000)", [owner.id]);
    gateway.reply("x", { usage: USAGE });
    const first = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(first);
    const providerId = await addProvider(owner);
    expect((await setModel(owner, { source: "provider", providerId, model: "own-model" })).status).toBe(200);
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBe("x");
    expect(gateway.calls[first]!.model).toBe("own-model");
  });

  it("a free site model they may choose: called, and charged to the memory allowance, never their balance", async () => {
    const owner = await signUp(app, "mmsitefree");
    await grant(db, owner.id, 5_000_000n);
    expect((await setModel(owner, SITE_FREE)).status).toBe(200);
    expect(await me(owner)).toMatchObject({ memoryModel: SITE_FREE, memoryModelUsable: true });
    gateway.reply("好", { usage: USAGE });
    const first = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBe("好");
    expect(gateway.calls[first]!.model).toBe("upstream-meter_free");
    expect(await balance(owner.id)).toBe("5000000");
    expect(await records(owner.id)).toMatchObject([
      { purpose: "memory", source: "site", model: "meter_free", cost_micro: costOf(USAGE).toString(), balance_micro: "0", free_micro: "0", memory_micro: costOf(USAGE).toString() },
    ]);
  });

  it("memory the site pays for runs only on free-tier site models: a paid site model is refused as a choice (400, as an unknown one)", async () => {
    const owner = await signUp(app, "mmpaid");
    const res = await setModel(owner, SITE_PAID);
    expect([res.status, res.json]).toEqual([400, { error: "invalid_request" }]);
    expect(await me(owner)).toMatchObject({ memoryModel: null, memoryModelUsable: true });
  });

  it("a paid site model stored before that rule is not used: the site's memory model is called and recorded instead, and the choice reads as not usable", async () => {
    const owner = await signUp(app, "mmpaidold");
    await grant(db, owner.id, 5_000_000n);
    await storeChoice(owner.id, SITE_PAID);
    expect(await me(owner)).toMatchObject({ memoryModel: SITE_PAID, memoryModelUsable: false });
    gateway.reply("好", { usage: USAGE });
    const first = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBe("好");
    expect(gateway.calls[first]!.model).toBe("upstream-meter_free");
    expect(await balance(owner.id)).toBe("5000000");
    expect(await records(owner.id)).toMatchObject([{ purpose: "memory", source: "site", model: "meter_free", memory_micro: costOf(USAGE).toString(), balance_micro: "0" }]);
  });

  it("the operator's own MEMORY.model is not limited by the tier: a paid one is called", async () => {
    const owner = await signUp(app, "mmoperator");
    const config = { ...app.deps.config, memory: { ...app.deps.config.memory, model: "meter_paid" } };
    gateway.reply("好", { usage: USAGE });
    const first = gateway.calls.length;
    expect(await memoryCall(deps({ config }), owner.id, INPUT, never)).toBe("好");
    expect(gateway.calls[first]!.model).toBe("upstream-meter_paid");
  });

  it("a stored paid choice with the memory allowance used up: nothing called, nothing recorded, the balance is not touched", async () => {
    const owner = await signUp(app, "mmnobalance");
    await grant(db, owner.id, 5_000_000n);
    await db.query("insert into memory_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, 20000000)", [owner.id]);
    await storeChoice(owner.id, SITE_PAID);
    const first = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(first);
    expect(await runs(owner.id)).toEqual([]);
    expect(await balance(owner.id)).toBe("5000000");
  });

  it("rejects what an Agent's model may not be: an unknown site model, another person's provider, a model not on the list, a too small one, a malformed choice", async () => {
    const owner = await signUp(app, "mmreject");
    const other = await signUp(app, "mmother");
    const theirs = await addProvider(other);
    const small = await addProvider(owner, [{ name: "tiny", contextTokens: 100 }]);
    const mine = await addProvider(owner);
    const bad: unknown[] = [
      { source: "site", id: "nope" },
      { source: "provider", providerId: theirs, model: "own-model" },
      { source: "provider", providerId: mine, model: "missing" },
      { source: "provider", providerId: small, model: "tiny" },
      { source: "provider", providerId: "not-a-uuid", model: "own-model" },
      { source: "site", id: "meter_free", extra: 1 },
      "meter_free",
    ];
    for (const choice of bad) {
      const res = await setModel(owner, choice);
      expect([choice, res.status, res.json]).toEqual([choice, 400, { error: "invalid_request" }]);
    }
    expect((await me(owner)).memoryModel).toBeNull();
  });

  it("null clears the choice; the site's model is used again", async () => {
    const owner = await signUp(app, "mmclear");
    const choice = { source: "provider", providerId: await addProvider(owner), model: "own-model" };
    await setModel(owner, choice);
    expect((await me(owner)).memoryModel).toEqual(choice);
    expect((await setModel(owner, null)).status).toBe(200);
    expect(await me(owner)).toMatchObject({ memoryModel: null, memoryModelUsable: true });
    gateway.reply("好", { usage: USAGE });
    const first = gateway.calls.length;
    await memoryCall(deps(), owner.id, INPUT, never);
    expect(gateway.calls[first]!.model).toBe("upstream-meter_free");
  });

  it("a chosen model whose provider is then deleted: no call to any model, nothing recorded, not usable", async () => {
    const owner = await signUp(app, "mmgone");
    const providerId = await addProvider(owner);
    const choice = { source: "provider", providerId, model: "own-model" };
    await setModel(owner, choice);
    expect((await api(app, owner, "DELETE", `/api/providers/${providerId}`)).status).toBeLessThan(300);
    const first = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(first);
    expect(await runs(owner.id)).toEqual([]);
    expect(await records(owner.id)).toEqual([]);
    expect(await freeUsed(owner.id)).toEqual([]);
    expect(await me(owner)).toMatchObject({ memoryModel: choice, memoryModelUsable: false });
  });

  it("a refused model changes nothing else in the same PATCH: the name and newNotes stay", async () => {
    const owner = await signUp(app, "mmatomic");
    const res = await api(app, owner, "PATCH", "/api/me", { displayName: "Renamed", newNotes: "vault", memoryModel: { source: "site", id: "nope" } });
    expect([res.status, res.json]).toEqual([400, { error: "invalid_request" }]);
    expect(await me(owner)).toMatchObject({ displayName: "mmatomic", newNotes: "auto", memoryModel: null });
    const ok = await api(app, owner, "PATCH", "/api/me", { displayName: "Renamed", newNotes: "vault", memoryModel: SITE_FREE });
    expect(ok.status).toBe(200);
    expect(await me(owner)).toMatchObject({ displayName: "Renamed", newNotes: "vault", memoryModel: SITE_FREE });
  });

  it("a provider key that cannot be opened: null, no call, nothing recorded, not usable, and nothing of the key or the error in /api/me", async () => {
    const owner = await signUp(app, "mmkey");
    const providerId = await addProvider(owner);
    const spare = await addProvider(owner, [{ name: "spare", contextTokens: 50_000 }], "Spare");
    const choice = { source: "provider", providerId, model: "own-model" };
    await setModel(owner, choice);
    // The saved key of another row moved onto this one: it does not open there.
    await db.query("update providers set key_cipher = (select key_cipher from providers where id = $1) where id = $2", [spare, providerId]);
    const first = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(first);
    expect(await runs(owner.id)).toEqual([]);
    const got = await api(app, owner, "GET", "/api/me");
    expect(got.json).toMatchObject({ memoryModel: choice, memoryModelUsable: false });
    const body = JSON.stringify(got.json).toLowerCase();
    expect(["sk-test", "cipher", "key_", "unreadable", "provider_rejected"].filter((w) => body.includes(w))).toEqual([]);
  });

  it("a provider transferred to another owner (not deleted): the same as deleted", async () => {
    const owner = await signUp(app, "mmmoved");
    const other = await signUp(app, "mmreceiver");
    const providerId = await addProvider(owner);
    const choice = { source: "provider", providerId, model: "own-model" };
    await setModel(owner, choice);
    await db.query("update providers set owner_id = $2 where id = $1", [providerId, other.id]);
    const first = gateway.calls.length;
    expect(await memoryCall(deps(), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(first);
    expect(await runs(owner.id)).toEqual([]);
    expect(await me(owner)).toMatchObject({ memoryModel: choice, memoryModelUsable: false });
    expect(await me(other)).toMatchObject({ memoryModel: null, memoryModelUsable: true });
  });

  it("a chosen site model that is no longer configured: null, no call, not usable", async () => {
    const owner = await signUp(app, "mmremoved");
    expect((await setModel(owner, SITE_FREE)).status).toBe(200);
    const config = { ...app.deps.config, siteModels: app.deps.config.siteModels.filter((m) => m.id !== "meter_free") };
    const first = gateway.calls.length;
    expect(await memoryCall(deps({ config }), owner.id, INPUT, never)).toBeNull();
    expect(gateway.calls).toHaveLength(first);
    expect(await runs(owner.id)).toEqual([]);
  });

  it("a chosen model is used even when the site has no memory model of its own", async () => {
    const owner = await signUp(app, "mmnosite");
    const providerId = await addProvider(owner);
    await setModel(owner, { source: "provider", providerId, model: "own-model" });
    const config = { ...app.deps.config, siteModels: [] };
    gateway.reply("好", { usage: USAGE });
    expect(await memoryCall(deps({ config }), owner.id, INPUT, never)).toBe("好");
  });

  it("nobody else sees it: another member's /api/me, /api/sync and principal lookup carry no memoryModel", async () => {
    const owner = await signUp(app, "mmprivate");
    const other = await signUp(app, "mmpeek");
    const providerId = await addProvider(owner);
    await setModel(owner, { source: "provider", providerId, model: "own-model" });
    expect(await me(other)).toMatchObject({ memoryModel: null });
    for (const [who, url] of [
      [other, "/api/sync"],
      [other, `/api/principals/lookup?handle=${owner.handle}`],
    ] as const) {
      const body = JSON.stringify((await api(app, who, "GET", url)).json);
      expect([url, body.includes("memoryModel"), body.includes(providerId), body.includes("own-model")]).toEqual([url, false, false, false]);
    }
  });
});
