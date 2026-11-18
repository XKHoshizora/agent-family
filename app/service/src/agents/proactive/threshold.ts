// The floating threshold above which an Agent speaks in a group without being asked. Pure arithmetic: no I/O, and the
// clock is always a parameter. It rises each time the Agent speaks unasked (the surcharge) and when someone asks it to be
// quiet (the quiet raise); both fall back with time, the surcharge also with other people's messages.

export type Level = "less" | "normal" | "more";

export interface ProactiveNumbers {
  base: { less: number; normal: number; more: number };
  surchargeStep: number;
  surchargeMax: number;
  surchargeHalfLifeS: number;
  surchargeHalfMessages: number;
  quietBig: { at: number; raise: number; halfLifeS: number };
  quietSmall: { at: number; raise: number; halfLifeS: number };
  cap: number;
}

export type GroupState = {
  surcharge: number;
  surchargeAt: Date | null;
  /** Messages by others since the surcharge was stamped. */
  othersSince: number;
  quiet: number;
  quietHalfLifeS: number | null;
  quietAt: Date | null;
};

export const NO_STATE: GroupState = { surcharge: 0, surchargeAt: null, othersSince: 0, quiet: 0, quietHalfLifeS: null, quietAt: null };

/** A stored number that is not finite, or is negative, counts as 0. */
function nonNegative(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** Seconds from `at` to `now`; 0 when there is no `at`, or it is not a date, or it lies in the future. */
function secondsSince(at: Date | null, now: Date): number {
  if (!at) return 0;
  const s = (now.getTime() - at.getTime()) / 1000;
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/** How many times `amount` halves at one halving every `per`: none when `per` is not a positive number (no decay, never NaN). */
function halvings(amount: number, per: number): number {
  return Number.isFinite(per) && per > 0 ? amount / per : 0;
}

export function surchargeNow(s: GroupState, now: Date, P: ProactiveNumbers): number {
  const surcharge = nonNegative(s.surcharge);
  if (surcharge === 0) return 0;
  const byTime = halvings(secondsSince(s.surchargeAt, now), P.surchargeHalfLifeS);
  const byMessages = halvings(nonNegative(s.othersSince), P.surchargeHalfMessages);
  return surcharge * Math.pow(0.5, Math.max(byTime, byMessages));
}

export function quietNow(s: GroupState, now: Date): number {
  const quiet = nonNegative(s.quiet);
  if (quiet === 0 || s.quietHalfLifeS === null) return 0;
  return quiet * Math.pow(0.5, halvings(secondsSince(s.quietAt, now), s.quietHalfLifeS));
}

export function thresholdNow(level: Level, s: GroupState, now: Date, P: ProactiveNumbers): number {
  return Math.min(P.cap, P.base[level] + surchargeNow(s, now, P) + quietNow(s, now));
}

/** The state after the Agent has spoken unasked: the surcharge rises one step (to at most the maximum), stamped now. */
export function afterProactive(s: GroupState, now: Date, P: ProactiveNumbers): GroupState {
  return {
    ...s,
    surcharge: Math.min(P.surchargeMax, surchargeNow(s, now, P) + P.surchargeStep),
    surchargeAt: now,
    othersSince: 0,
  };
}

/**
 * The state after someone asked the Agent to be quiet with probability `q`; null when `q` is too small to matter.
 * A smaller raise never lowers or shortens a bigger one still in force.
 */
export function afterQuiet(s: GroupState, q: number, now: Date, P: ProactiveNumbers): { state: GroupState; big: boolean } | null {
  if (!(q >= P.quietSmall.at)) return null;
  const big = q >= P.quietBig.at;
  const candidate = big ? P.quietBig : P.quietSmall;
  const current = quietNow(s, now);
  const state: GroupState =
    candidate.raise >= current
      ? { ...s, quiet: candidate.raise, quietHalfLifeS: candidate.halfLifeS, quietAt: now }
      : { ...s, quiet: current, quietAt: now };
  return { state, big };
}
