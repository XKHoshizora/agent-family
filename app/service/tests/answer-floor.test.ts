import type { FastifyRequest } from "fastify";
import { describe, expect, test } from "vitest";
import { ANSWER_FLOOR, holdUntilFloor, noteArrival } from "../src/auth/answer-floor.ts";
import { createInvite } from "../src/auth/invites.ts";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

// Long enough to cover a registration's password hashing on a loaded machine, short enough to keep the file quick.
const FLOOR = { ms: 300, jitterMs: 10 };

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;

/** Runs the timings `a` and `b` alternately (which goes first alternates too), so drift in machine load hits both alike. */
async function interleaved(rounds: number, a: () => Promise<number>, b: () => Promise<number>) {
  const as: number[] = [];
  const bs: number[] = [];
  for (let i = 0; i < rounds; i++) {
    if (i % 2 === 0) {
      as.push(await a());
      bs.push(await b());
    } else {
      bs.push(await b());
      as.push(await a());
    }
  }
  return { as, bs };
}

describe("holdUntilFloor", () => {
  test("is 400 ms plus up to 50 ms outside tests", () => {
    expect(ANSWER_FLOOR).toEqual({ ms: 400, jitterMs: 50 });
  });

  test("waits out what is left of the floor, and does not pad work that already took longer", async () => {
    const fresh = {} as FastifyRequest;
    await noteArrival(fresh);
    let t0 = performance.now();
    await holdUntilFloor(fresh, { ms: 80, jitterMs: 0 });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(75);

    const slow = {} as FastifyRequest;
    await noteArrival(slow);
    await new Promise((resolve) => setTimeout(resolve, 60));
    t0 = performance.now();
    await holdUntilFloor(slow, { ms: 50, jitterMs: 0 });
    expect(performance.now() - t0).toBeLessThan(10);
  });
});

describe("answer floor", () => {
  const { app, db } = useApp({ answerFloor: FLOOR });

  async function timed(path: string, body: object, status: number): Promise<number> {
    const t0 = performance.now();
    const res = await api(app, null, "POST", path, body);
    const dt = performance.now() - t0;
    expect([path, res.status]).toEqual([path, status]);
    return dt;
  }

  test("a reset request answers no sooner than the floor, and as fast for a registered as for an unregistered address", async () => {
    const a = await signUp(app, "floor_known");
    const reset = (email: string) => () => timed("/api/auth/request-password-reset", { email }, 200);
    let n = 0;
    const unknown = () => reset(`ghost${n++}@example.test`)();
    await reset(a.email)(); // warm up both paths
    await unknown();
    const { as: known, bs: absent } = await interleaved(9, reset(a.email), unknown);
    expect(Math.min(...known, ...absent)).toBeGreaterThanOrEqual(FLOOR.ms);
    expect(Math.abs(median(known) - median(absent))).toBeLessThan(40);
    // Only the registered address got mail.
    const { rows } = await db.query<{ recipient: string }>("select distinct recipient from mail_outbox where kind = 'reset_password'");
    expect(rows).toEqual([{ recipient: a.email }]);
  });

  test("a registration answers no sooner than the floor, and as fast for an e-mail that has an account as for a new one", async () => {
    const owner = await signUp(app, "floor_owner");
    let n = 0;
    const register = (email: string) => async () => {
      const i = n++;
      const inviteCode = await createInvite(db, { ttlHours: 1 });
      const t0 = performance.now();
      const res = await api(app, null, "POST", "/api/register", { inviteCode, email, password: "a good long password", displayName: "Floor", handle: `floor_${i}` });
      const dt = performance.now() - t0;
      expect(res).toEqual({ status: 201, json: { ok: true } });
      return dt;
    };
    const fresh = () => register(`fresh${n}@example.test`)();
    await register(owner.email)(); // warm up both paths
    await fresh();
    const { as: taken, bs: free } = await interleaved(7, register(owner.email), fresh);
    expect(Math.min(...taken, ...free)).toBeGreaterThanOrEqual(FLOOR.ms);
    expect(Math.abs(median(taken) - median(free))).toBeLessThan(40);
  });
});
