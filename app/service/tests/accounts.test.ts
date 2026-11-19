import { describe, expect, it, vi } from "vitest";
import { applyLedger, ensureAccount, formatPoints, freeUsedToday, lockAccount, nextSiteMidnight, parsePoints, siteDay } from "../src/accounts/store.ts";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

const { app, db } = useApp();

/** An Agent principal owned by `ownerId` with an `agents` row (the agents module does not exist yet). */
async function insertAgent(ownerId: string, handle: string, deleted = false): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into principals (kind, handle, display_name, owner_id) values ('agent', $1, $3, $2) returning id",
    [handle, ownerId, handle],
  );
  const id = rows[0]!.id;
  await db.query("insert into agents (principal_id, deleted_at) values ($1, $2)", [id, deleted ? new Date() : null]);
  return id;
}

/** A usage record; unless `over` splits it otherwise, its whole cost was charged to the free allowance. */
async function insertUsage(ownerId: string, agentId: string | null, over: Record<string, unknown> = {}): Promise<void> {
  const cost = (over.cost_micro as number | undefined) ?? 1_500_000;
  const r = { purpose: "reply", source: "site", model: "fast", cost_micro: cost, free_micro: cost, balance_micro: 0, forgiven_micro: 0, outcome: "done", created_at: new Date(), ...over };
  await db.query(
    `insert into usage_records (owner_id, agent_id, purpose, source, model, cost_micro, free_micro, balance_micro, forgiven_micro, outcome, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [ownerId, agentId, r.purpose, r.source, r.model, r.cost_micro, r.free_micro, r.balance_micro, r.forgiven_micro, r.outcome, r.created_at],
  );
}

describe("points", () => {
  it("formats micro-points as exact decimal strings and parses them back", () => {
    expect(formatPoints(0n)).toBe("0");
    expect(formatPoints(5_000_000n)).toBe("5");
    expect(formatPoints(3_500_000n)).toBe("3.5");
    expect(formatPoints(1n)).toBe("0.000001");
    expect(formatPoints(-2_000_001n)).toBe("-2.000001");
    expect(formatPoints(-1n)).toBe("-0.000001");
    expect(formatPoints(9_007_199_254_740_993_000_000n)).toBe("9007199254740993");
    expect(parsePoints("5")).toBe(5_000_000n);
    expect(parsePoints("-2.5")).toBe(-2_500_000n);
    expect(parsePoints("0.000001")).toBe(1n);
    expect(parsePoints("+1.10")).toBe(1_100_000n);
    for (const bad of ["abc", "", "1.0000001", "1e3", "--1", "1.", ".5", "NaN", "1,5", " 1", "Infinity"]) {
      expect([bad, parsePoints(bad)]).toEqual([bad, null]);
    }
  });
});

describe("site day", () => {
  it("follows the site time zone, not UTC", () => {
    const t = new Date("2026-03-01T17:30:00Z"); // 01:30 on the 2nd in Shanghai, 12:30 on the 1st in New York
    expect(siteDay(t, "Asia/Shanghai")).toBe("2026-03-02");
    expect(siteDay(t, "America/New_York")).toBe("2026-03-01");
    expect(siteDay(t, "UTC")).toBe("2026-03-01");
  });

  it("resets at the next midnight of the zone, as an instant", () => {
    expect(nextSiteMidnight(new Date("2026-03-01T17:30:00Z"), "Asia/Shanghai").toISOString()).toBe("2026-03-02T16:00:00.000Z");
    expect(nextSiteMidnight(new Date("2026-03-01T17:30:00Z"), "UTC").toISOString()).toBe("2026-03-02T00:00:00.000Z");
    // New York leaves daylight saving on 2026-11-01: that day is 25 hours long.
    expect(nextSiteMidnight(new Date("2026-11-01T12:00:00Z"), "America/New_York").toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(nextSiteMidnight(new Date("2026-11-01T03:00:00Z"), "America/New_York").toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  it("freeUsedToday reads only the current site day", async () => {
    const a = await signUp(app, "freeday");
    await db.query("insert into free_usage (owner_id, day, used_micro) values ($1, '2026-03-02', 7), ($1, '2026-03-01', 100)", [a.id]);
    const now = new Date("2026-03-01T17:30:00Z");
    expect(await freeUsedToday(db, a.id, now, "Asia/Shanghai")).toBe(7n);
    expect(await freeUsedToday(db, a.id, now, "UTC")).toBe(100n);
    expect(await freeUsedToday(db, a.id, new Date("2026-03-05T00:00:00Z"), "UTC")).toBe(0n);
  });
});

describe("ledger", () => {
  it("ensureAccount is idempotent and lockAccount creates the row first", async () => {
    const a = await signUp(app, "ledgera");
    await db.tx(async (t) => {
      await ensureAccount(t, a.id);
      await ensureAccount(t, a.id);
    });
    expect((await db.query("select * from accounts where principal_id = $1", [a.id])).rowCount).toBe(1);
    const b = await signUp(app, "ledgerb");
    expect(await db.tx((t) => lockAccount(t, b.id))).toEqual({ tier: "free", balanceMicro: 0n });
  });

  it("after any sequence of applyLedger calls the ledger sums to the balance", async () => {
    const a = await signUp(app, "ledgersum");
    const b = await signUp(app, "ledgerother");
    const deltas = [5_000_000n, -2_000_000n, 123n, -9_000_000n, 1n, 40_000_000n];
    let expected = 0n;
    for (const [i, d] of deltas.entries()) {
      const reason = i % 3 === 0 ? "grant" : i % 3 === 1 ? "adjust" : "usage";
      expected += d;
      const returned = await db.tx((t) => applyLedger(t, a.id, d, reason, i === 0 ? "first" : null));
      expect(returned).toBe(expected);
    }
    await db.tx((t) => applyLedger(t, b.id, 77n, "grant", null));
    const { rows } = await db.query<{ owner_id: string; balance_micro: string; ledger: string }>(
      `select a.principal_id as owner_id, a.balance_micro::text, coalesce(sum(l.delta_micro), 0)::text as ledger
         from accounts a left join balance_ledger l on l.owner_id = a.principal_id
        group by a.principal_id, a.balance_micro`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.ledger).toBe(r.balance_micro);
    expect(rows.find((r) => r.owner_id === a.id)!.balance_micro).toBe(String(expected));
    expect((await db.query("select note from balance_ledger where owner_id = $1 order by id limit 1", [a.id])).rows[0].note).toBe("first");
  });

  it("a failed transaction leaves neither ledger row nor balance change", async () => {
    const a = await signUp(app, "ledgerroll");
    await expect(
      db.tx(async (t) => {
        await applyLedger(t, a.id, 5_000_000n, "grant", null);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await db.query("select count(*)::int n from balance_ledger where owner_id = $1", [a.id])).rows[0].n).toBe(0);
    expect(await db.tx((t) => lockAccount(t, a.id))).toEqual({ tier: "free", balanceMicro: 0n });
  });

  it("concurrent ledger entries on one account all land", async () => {
    const a = await signUp(app, "ledgerrace");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        db.tx(async (t) => {
          await lockAccount(t, a.id);
          await applyLedger(t, a.id, 1_000_000n, "grant", null);
        }),
      ),
    );
    expect(await db.tx((t) => lockAccount(t, a.id))).toEqual({ tier: "free", balanceMicro: 20_000_000n });
  });
});

describe("GET /api/usage", () => {
  it("needs a session", async () => {
    expect((await api(app, null, "GET", "/api/usage")).status).toBe(401);
  });

  it("an account with no row reads as free tier, zero balance, nothing used", async () => {
    const a = await signUp(app, "usagefresh");
    const res = await api(app, a, "GET", "/api/usage");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      tier: "free",
      agentLimit: 20,
      agentCount: 0,
      balance: "0",
      free: { allowance: "200", used: "0" },
      canStartFreeReply: true,
      recent: [],
    });
    const wait = new Date(res.json.free.resetsAt).getTime() - Date.now();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(25 * 3600_000);
    // reading did not create an account
    expect((await db.query("select 1 from accounts")).rowCount).toBe(0);
  });

  it("shows tier, balance and counts only live agents", async () => {
    const a = await signUp(app, "usagefull");
    await db.tx((t) => applyLedger(t, a.id, 12_500_000n, "grant", null));
    await insertAgent(a.id, "usage_bot_1");
    await insertAgent(a.id, "usage_bot_2");
    await insertAgent(a.id, "usage_bot_gone", true);
    const res = await api(app, a, "GET", "/api/usage");
    expect(res.json.balance).toBe("12.5");
    expect(res.json.agentCount).toBe(2);
    expect(res.json.tier).toBe("free");
    // a tier the configuration no longer knows gets the free limit
    await db.query("update accounts set tier = 'retired' where principal_id = $1", [a.id]);
    const retired = await api(app, a, "GET", "/api/usage");
    expect([retired.json.tier, retired.json.agentLimit]).toEqual(["retired", 20]);
  });

  it("is read in one snapshot: a settlement that commits while it reads is seen whole or not at all", async () => {
    const a = await signUp(app, "usagesnap");
    const agent = await insertAgent(a.id, "snap_bot");
    await db.tx((t) => applyLedger(t, a.id, 5_000_000n, "grant", null));
    // A settlement in progress: it holds usage_records until the read is waiting for it, then charges 2 points to the
    // balance with its usage record, both in one commit.
    const settling = await db.pool.connect();
    try {
      await settling.query("begin");
      await settling.query("lock table usage_records in access exclusive mode");
      const pid = (await settling.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const reading = api(app, a, "GET", "/api/usage");
      await vi.waitFor(async () => expect((await db.query("select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))", [pid])).rowCount).toBe(1));
      const record = await settling.query<{ id: string }>(
        `insert into usage_records (owner_id, agent_id, purpose, source, model, cost_micro, free_micro, balance_micro, forgiven_micro, outcome)
         values ($1, $2, 'reply', 'site', 'fast', 2000000, 0, 2000000, 0, 'done') returning id::text`,
        [a.id, agent],
      );
      await applyLedger(settling, a.id, -2_000_000n, "usage", null, record.rows[0]!.id);
      await settling.query("commit");
      const seen = (await reading).json;
      // Before the settlement (or after it): never the record without its charge.
      expect([seen.balance, seen.recent]).toEqual(["5", []]);
    } finally {
      settling.release();
    }
    const after = (await api(app, a, "GET", "/api/usage")).json;
    expect([after.balance, after.recent.map((r: { points: string }) => r.points)]).toEqual(["3", ["2"]]);
  });

  it("canStartFreeReply: allowance left or balance above zero", async () => {
    const a = await signUp(app, "usagecan");
    const today = siteDay(new Date(), "Asia/Shanghai");
    await db.query("insert into free_usage (owner_id, day, used_micro) values ($1, $2, 200000000)", [a.id, today]);
    const spent = await api(app, a, "GET", "/api/usage");
    expect(spent.json.free.used).toBe("200");
    expect(spent.json.canStartFreeReply).toBe(false);
    await db.tx((t) => applyLedger(t, a.id, 1n, "grant", null));
    expect((await api(app, a, "GET", "/api/usage")).json.canStartFreeReply).toBe(true);
    await db.tx((t) => applyLedger(t, a.id, -1n, "adjust", null));
    expect((await api(app, a, "GET", "/api/usage")).json.canStartFreeReply).toBe(false);
    await db.tx((t) => applyLedger(t, a.id, -5n, "adjust", null));
    expect((await api(app, a, "GET", "/api/usage")).json.balance).toBe("-0.000005");
  });

  it("recent aggregates the last 7 site-days per agent, model and source", async () => {
    const a = await signUp(app, "usagerecent");
    const x = await insertAgent(a.id, "recent_bot_x");
    const y = await insertAgent(a.id, "recent_bot_y");
    const day = 24 * 3600_000;
    await insertUsage(a.id, x, { cost_micro: 1_000_000 });
    await insertUsage(a.id, x, { cost_micro: 2_500_000, created_at: new Date(Date.now() - 5 * day) });
    await insertUsage(a.id, x, { cost_micro: 900_000_000, created_at: new Date(Date.now() - 9 * day) }); // too old
    await insertUsage(a.id, x, { cost_micro: 3_000_000, model: "big" });
    await insertUsage(a.id, y, { cost_micro: 0, source: "provider", model: "my-model" });
    await insertUsage(a.id, null, { purpose: "draft", cost_micro: 250_000 });
    const res = await api(app, a, "GET", "/api/usage");
    expect(res.json.recent).toEqual([
      { agentId: x, purpose: "reply", model: "fast", source: "site", points: "3.5", replies: 2 },
      { agentId: x, purpose: "reply", model: "big", source: "site", points: "3", replies: 1 },
      { agentId: null, purpose: "draft", model: "fast", source: "site", points: "0.25", replies: 0 },
      { agentId: y, purpose: "reply", model: "my-model", source: "provider", points: "0", replies: 1 },
    ]);
  });

  it("recent.points is what you were charged (allowance and balance), not the true cost: what was forgiven is left out", async () => {
    const a = await signUp(app, "usagecharged");
    const x = await insertAgent(a.id, "charged_bot");
    // Cost 10 points: 1 taken from the allowance, 0.5 from the balance, 8.5 forgiven (above the hold, or past the allowance).
    await insertUsage(a.id, x, { cost_micro: 10_000_000, free_micro: 1_000_000, balance_micro: 500_000, forgiven_micro: 8_500_000 });
    // Cost 2 points, all forgiven (the reply could not be stored: the service's own trouble).
    await insertUsage(a.id, x, { cost_micro: 2_000_000, free_micro: 0, balance_micro: 0, forgiven_micro: 2_000_000 });
    // Cost 3 points on another model, charged in full to the balance: it is listed first.
    await insertUsage(a.id, x, { model: "big", cost_micro: 3_000_000, free_micro: 0, balance_micro: 3_000_000 });
    expect((await api(app, a, "GET", "/api/usage")).json.recent).toEqual([
      { agentId: x, purpose: "reply", model: "big", source: "site", points: "3", replies: 1 },
      { agentId: x, purpose: "reply", model: "fast", source: "site", points: "1.5", replies: 2 },
    ]);
  });

  it("never contains another user's rows, and takes no parameter that could select one", async () => {
    const a = await signUp(app, "usagea");
    const b = await signUp(app, "usageb");
    const botB = await insertAgent(b.id, "usage_b_bot");
    await db.tx((t) => applyLedger(t, b.id, 99_000_000n, "grant", null));
    await insertUsage(b.id, botB);
    const mine = await api(app, a, "GET", "/api/usage");
    expect(mine.json.balance).toBe("0");
    expect(mine.json.agentCount).toBe(0);
    expect(mine.json.recent).toEqual([]);
    expect(JSON.stringify(mine.json)).not.toContain(botB);
    for (const q of [`?owner=${b.id}`, `?ownerId=${b.id}`, `?principalId=${b.id}`, "?x=1"]) {
      const res = await api(app, a, "GET", `/api/usage${q}`);
      expect([q, res.status]).toEqual([q, 400]);
      expect(res.json).toEqual({ error: "invalid_request" });
    }
    expect((await api(app, b, "GET", "/api/usage")).json.balance).toBe("99");
  });

  it("there is no write route under /api/usage, /api/credits or /api/accounts", async () => {
    const a = await signUp(app, "usagewrite");
    for (const base of ["/api/usage", "/api/credits", "/api/accounts", "/api/accounts/me", "/api/credits/grant"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const res = await api(app, a, method, base, { points: "100", balance: "100", tier: "paid" });
        expect([base, method, res.status]).toEqual([base, method, 404]);
        expect(res.json).toEqual({ error: "not_found" });
      }
    }
    expect((await db.query("select 1 from balance_ledger")).rowCount).toBe(0);
    expect((await db.query("select 1 from accounts")).rowCount).toBe(0);
  });
});
