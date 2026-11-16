import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.ts";
import { admitRun, type Admission } from "../src/metering/admit.ts";
import { settle } from "../src/metering/settle.ts";
import type { Resolved } from "../src/models/resolve.ts";
import { signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { ESTIMATE, FULL_USAGE, grant, MAX_COST, METER_ENV, meteredAgent, runningRun } from "./helpers/metering.ts";

/**
 * Review Focus 2: however many replies one user starts at once, the forgiven free overrun and the negative balance
 * are each at most one reply's maximum cost. Real parallel transactions on separate pool connections against the
 * real Postgres; a hold is released only by settlement; every call costs the most it can (`FULL_USAGE`).
 * Two orders each round: all admissions at once and then all settlements at once, or every call admitting and
 * settling on its own while the others do the same.
 */

const { app, db } = useApp({ env: METER_ENV });
const config = () => app.deps.config;
const PARALLEL = 20;
const ROUNDS = 4;

type Attempt = { run: string; admission: Admission } | { run: string; refused: AppError };

async function tryAdmit(run: string, ownerId: string, resolved: Resolved): Promise<Attempt> {
  try {
    return { run, admission: await db.tx((t) => admitRun(t, config(), run, ownerId, resolved, ESTIMATE, new Date())) };
  } catch (err) {
    if (err instanceof AppError) return { run, refused: err };
    throw err;
  }
}

const settleFull = (run: string, resolved: Resolved) =>
  db.tx((t) => settle(t, config(), run, resolved, FULL_USAGE, { inputChars: 0, outputChars: 0 }, "done", new Date()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `PARALLEL` running drafts of `ownerId` contend for admission on `resolved`; every admitted one is settled. */
async function contend(ownerId: string, resolved: Resolved, round: number): Promise<Attempt[]> {
  const runs = await Promise.all(Array.from({ length: PARALLEL }, () => runningRun(db, ownerId)));
  if (round % 2 === 0) {
    const attempts = await Promise.all(runs.map((run) => tryAdmit(run, ownerId, resolved)));
    await Promise.all(attempts.flatMap((a) => ("admission" in a ? [settleFull(a.run, resolved)] : [])));
    return attempts;
  }
  return Promise.all(
    runs.map(async (run, i) => {
      const attempt = await tryAdmit(run, ownerId, resolved);
      if ("admission" in attempt) {
        await sleep(i % 4);
        await settleFull(run, resolved);
      }
      return attempt;
    }),
  );
}

async function totals(ownerId: string) {
  const { rows } = await db.query<{ records: number; cost: string; free: string; balance: string; forgiven: string }>(
    `select count(*)::int as records, coalesce(sum(cost_micro), 0)::text as cost, coalesce(sum(free_micro), 0)::text as free,
            coalesce(sum(balance_micro), 0)::text as balance, coalesce(sum(forgiven_micro), 0)::text as forgiven
       from usage_records where owner_id = $1`,
    [ownerId],
  );
  const used = await db.query<{ used: string }>("select coalesce(sum(used_micro), 0)::text as used from free_usage where owner_id = $1", [ownerId]);
  const account = await db.query<{ b: string }>("select balance_micro::text b from accounts where principal_id = $1", [ownerId]);
  const r = rows[0]!;
  return {
    records: r.records,
    cost: BigInt(r.cost),
    free: BigInt(r.free),
    charged: BigInt(r.balance),
    forgiven: BigInt(r.forgiven),
    freeUsed: BigInt(used.rows[0]!.used),
    balance: BigInt(account.rows[0]?.b ?? "0"),
  };
}

function split(attempts: Attempt[]) {
  const admitted = attempts.flatMap((a) => ("admission" in a ? [a.admission] : []));
  const refused = attempts.flatMap((a) => ("refused" in a ? [a.refused] : []));
  return { admitted, refused, reasons: [...new Set(refused.map((e) => `${e.status} ${e.code} ${e.details.reason}`))] };
}

/** The whole site: every balance equals its ledger, and no hold is left. */
async function expectBooksBalanced(): Promise<void> {
  const { rows } = await db.query<{ balance: string; ledger: string }>(
    `select a.balance_micro::text as balance, coalesce(sum(l.delta_micro), 0)::text as ledger
       from accounts a left join balance_ledger l on l.owner_id = a.principal_id
      group by a.principal_id, a.balance_micro`,
  );
  for (const r of rows) expect(r.ledger).toBe(r.balance);
  expect((await db.query("select id from agent_runs where hold_micro > 0")).rows).toEqual([]);
}

it("runs against a real pool of at least 10 connections", () => {
  expect(db.pool.options.max).toBeGreaterThanOrEqual(10);
});

describe(`${PARALLEL} replies started at once by one user`, () => {
  it("free model, allowance 1.5 × the maximum cost, balance 0: two admitted, at most one maximum cost forgiven", { timeout: 60_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const owner = await signUp(app, `freerace${round}`);
      const { resolved } = await meteredAgent(app, db, owner, { source: "site", id: "meter_free" });
      const { admitted, refused, reasons } = split(await contend(owner.id, resolved, round));
      expect(admitted.length).toBeLessThanOrEqual(2);
      expect(admitted).toEqual([
        { chargeTo: "free", holdMicro: MAX_COST },
        { chargeTo: "free", holdMicro: MAX_COST },
      ]);
      expect(refused).toHaveLength(PARALLEL - 2);
      expect(reasons).toEqual(["402 no_quota free_and_balance"]);
      const t = await totals(owner.id);
      expect(t.forgiven).toBeLessThanOrEqual(MAX_COST);
      expect(t).toEqual({ records: 2, cost: 2n * MAX_COST, free: 3_000_000n, charged: 0n, forgiven: 1_000_000n, freeUsed: 3_000_000n, balance: 0n });
      await expectBooksBalanced();
    }
  });

  it("paid model, balance 0.5 × the maximum cost: exactly one admitted, the balance ends no lower than minus one maximum cost", { timeout: 60_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const owner = await signUp(app, `paidrace${round}`);
      const { resolved } = await meteredAgent(app, db, owner, { source: "site", id: "meter_paid" });
      await grant(db, owner.id, MAX_COST / 2n);
      const { admitted, refused, reasons } = split(await contend(owner.id, resolved, round));
      expect(admitted).toEqual([{ chargeTo: "balance", holdMicro: MAX_COST }]);
      expect(refused).toHaveLength(PARALLEL - 1);
      expect(reasons).toEqual(["402 no_quota balance"]);
      const t = await totals(owner.id);
      expect(t.balance).toBeGreaterThanOrEqual(-MAX_COST);
      expect(t).toEqual({ records: 1, cost: MAX_COST, free: 0n, charged: MAX_COST, forgiven: 0n, freeUsed: 0n, balance: -MAX_COST / 2n });
      await expectBooksBalanced();
    }
  });

  it("free model with both an allowance and a balance: each bound holds on its own source", { timeout: 60_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const owner = await signUp(app, `bothrace${round}`);
      const { resolved } = await meteredAgent(app, db, owner, { source: "site", id: "meter_free" });
      await grant(db, owner.id, MAX_COST / 2n);
      const { admitted, refused, reasons } = split(await contend(owner.id, resolved, round));
      expect(admitted.map((a) => a.chargeTo).sort()).toEqual(["balance", "free", "free"]);
      expect(refused).toHaveLength(PARALLEL - 3);
      expect(reasons).toEqual(["402 no_quota free_and_balance"]);
      const t = await totals(owner.id);
      expect(t.forgiven).toBeLessThanOrEqual(MAX_COST);
      expect(t.balance).toBeGreaterThanOrEqual(-MAX_COST);
      expect(t).toEqual({ records: 3, cost: 3n * MAX_COST, free: 3_000_000n, charged: MAX_COST, forgiven: 1_000_000n, freeUsed: 3_000_000n, balance: -MAX_COST / 2n });
      await expectBooksBalanced();
    }
  });
});
