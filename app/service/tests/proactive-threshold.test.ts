import { describe, expect, test } from "vitest";
import {
  NO_STATE,
  afterProactive,
  afterQuiet,
  quietNow,
  surchargeNow,
  thresholdNow,
  type GroupState,
  type Level,
  type ProactiveNumbers,
} from "../src/agents/proactive/threshold.ts";

const P: ProactiveNumbers = {
  base: { less: 0.6, normal: 0.45, more: 0.35 },
  surchargeStep: 0.15,
  surchargeMax: 0.4,
  surchargeHalfLifeS: 120,
  surchargeHalfMessages: 4,
  quietBig: { at: 0.8, raise: 0.5, halfLifeS: 3600 },
  quietSmall: { at: 0.3, raise: 0.15, halfLifeS: 600 },
  cap: 0.9,
};

const T0 = new Date("2026-11-19T12:00:00Z");
const later = (s: number) => new Date(T0.getTime() + s * 1000);
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.005);
const spoke = (times: number, s: GroupState = NO_STATE) => {
  for (let i = 0; i < times; i++) s = afterProactive(s, T0, P);
  return s;
};
const quieted = (q: number, s: GroupState = NO_STATE, now = T0) => afterQuiet(s, q, now, P)!;
const others = (s: GroupState, n: number): GroupState => ({ ...s, othersSince: n });

describe("thresholdNow: the surcharge", () => {
  const rows: Array<[string, Level, GroupState, number, number]> = [
    ["idle, normal", "normal", NO_STATE, 0, 0.45],
    ["idle, less", "less", NO_STATE, 0, 0.6],
    ["idle, more", "more", NO_STATE, 0, 0.35],
    ["after one reply", "normal", spoke(1), 0, 0.6],
    ["after two in a row", "normal", spoke(2), 0, 0.75],
    ["after three (surcharge capped at 0.4)", "normal", spoke(3), 0, 0.85],
    ["after two, 240 s later", "normal", spoke(2), 240, 0.525],
    ["after two, 8 messages by others", "normal", others(spoke(2), 8), 0, 0.525],
    ["after two, 120 s and 8 messages: the larger decay", "normal", others(spoke(2), 8), 120, 0.525],
    ["after two, 360 s", "normal", spoke(2), 360, 0.4875],
    ["after two, 12 messages", "normal", others(spoke(2), 12), 0, 0.4875],
    ["quiet big + two replies: capped", "normal", spoke(2, quieted(0.95).state), 0, 0.9],
  ];
  test.each(rows)("%s", (_name, level, state, afterS, expected) => {
    close(thresholdNow(level, state, later(afterS), P), expected);
  });
});

describe("quiet", () => {
  test("big raise: 0.95 lifts to the cap, halves each hour, ignores othersSince", () => {
    const r = quieted(0.95);
    expect(r.big).toBe(true);
    close(thresholdNow("normal", r.state, T0, P), 0.9);
    close(thresholdNow("normal", r.state, later(3600), P), 0.7);
    close(thresholdNow("normal", r.state, later(7200), P), 0.575);
    close(thresholdNow("normal", others(r.state, 100), later(3600), P), 0.7);
    close(quietNow(others(r.state, 100), later(3600)), 0.25);
  });

  test("small raise: 0.35 adds 0.15 and halves in 10 minutes", () => {
    const r = quieted(0.35);
    expect(r.big).toBe(false);
    close(thresholdNow("normal", r.state, T0, P), 0.6);
    close(thresholdNow("normal", r.state, later(600), P), 0.525);
  });

  test("below the small bar nothing happens", () => {
    expect(afterQuiet(NO_STATE, 0.1, T0, P)).toBeNull();
    expect(afterQuiet(NO_STATE, 0.2999, T0, P)).toBeNull();
  });

  test("a small raise never shortens or lowers a bigger one", () => {
    const big = quieted(0.95).state;
    const r = quieted(0.35, big, later(600));
    expect(r.big).toBe(false);
    close(r.state.quiet, 0.5 * Math.pow(0.5, 600 / 3600));
    close(r.state.quiet, 0.4454);
    expect(r.state.quietHalfLifeS).toBe(3600);
    expect(r.state.quietAt).toEqual(later(600));
  });

  test("a big raise after a small one replaces it", () => {
    const r = quieted(0.9, quieted(0.35).state, later(60));
    expect(r.big).toBe(true);
    expect(r.state.quiet).toBe(0.5);
    expect(r.state.quietHalfLifeS).toBe(3600);
  });

  test("a small raise over a decayed bigger one is lifted back to the small raise with its own half-life", () => {
    const r = quieted(0.35, quieted(0.95).state, later(7 * 3600));
    expect(r.state.quiet).toBe(0.15);
    expect(r.state.quietHalfLifeS).toBe(600);
  });

  test("a small raise onto nothing", () => {
    const r = quieted(0.35);
    expect(r.state.quiet).toBe(0.15);
    expect(r.state.quietHalfLifeS).toBe(600);
    expect(r.state.quietAt).toEqual(T0);
  });
});

describe("the two halves do not touch each other", () => {
  test("afterProactive leaves the quiet fields alone", () => {
    const q = quieted(0.95).state;
    const s = afterProactive(q, later(10), P);
    expect({ quiet: s.quiet, h: s.quietHalfLifeS, at: s.quietAt }).toEqual({ quiet: q.quiet, h: q.quietHalfLifeS, at: q.quietAt });
    expect(s.surchargeAt).toEqual(later(10));
    expect(s.othersSince).toBe(0);
  });

  test("afterQuiet leaves the surcharge fields alone", () => {
    const sp = others(spoke(2), 3);
    const s = quieted(0.95, sp, later(5)).state;
    expect({ s: s.surcharge, at: s.surchargeAt, o: s.othersSince }).toEqual({ s: sp.surcharge, at: sp.surchargeAt, o: 3 });
  });

  test("surchargeNow of nothing is 0", () => {
    expect(surchargeNow(NO_STATE, T0, P)).toBe(0);
    expect(quietNow(NO_STATE, T0)).toBe(0);
  });
});

describe("garbage in", () => {
  const garbage: GroupState[] = [
    { ...NO_STATE, surcharge: NaN, surchargeAt: T0 },
    { ...NO_STATE, surcharge: -3, surchargeAt: T0 },
    { ...NO_STATE, surcharge: Infinity, surchargeAt: T0 },
    { ...NO_STATE, quiet: -1, quietHalfLifeS: 600, quietAt: T0 },
    { ...NO_STATE, quiet: NaN, quietHalfLifeS: 600, quietAt: T0 },
    { ...NO_STATE, quiet: 0.5, quietHalfLifeS: 0, quietAt: T0 },
    { ...NO_STATE, quiet: 0.5, quietHalfLifeS: NaN, quietAt: T0 },
    { ...NO_STATE, surcharge: 0.3, surchargeAt: later(1000), othersSince: -5 },
    { ...NO_STATE, surcharge: 0.3, surchargeAt: later(1000), othersSince: NaN },
    { ...NO_STATE, quiet: 0.5, quietHalfLifeS: 3600, quietAt: later(1000) },
    { ...NO_STATE, surcharge: 0.3, surchargeAt: new Date(NaN) },
  ];
  test.each(garbage.map((g, i) => [i, g] as const))("state %i stays finite, within base and cap", (_i, g) => {
    for (const level of ["less", "normal", "more"] as const) {
      const t = thresholdNow(level, g, T0, P);
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(P.base[level]);
      expect(t).toBeLessThanOrEqual(P.cap);
    }
    const a = afterProactive(g, T0, P);
    expect(Number.isFinite(a.surcharge) && a.surcharge >= 0).toBe(true);
    const q = afterQuiet(g, 0.95, T0, P)!;
    expect(Number.isFinite(q.state.quiet) && q.state.quiet >= 0).toBe(true);
  });

  test("a future surchargeAt does not boost the surcharge", () => {
    const s: GroupState = { ...NO_STATE, surcharge: 0.3, surchargeAt: later(1000) };
    expect(surchargeNow(s, T0, P)).toBeCloseTo(0.3, 10);
  });

  test("a non-finite q is below the bar", () => {
    expect(afterQuiet(NO_STATE, NaN, T0, P)).toBeNull();
  });
});
