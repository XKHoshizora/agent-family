import { AppError } from "./errors.ts";

/**
 * Work in progress per principal, in this process (the service runs as a single instance), with a cap per
 * principal and optionally one for everyone together: uploads (3 at once each) and searches (2 at once each,
 * 4 in all) each have one on `Deps`.
 */
export interface Slots {
  /**
   * Takes a slot for `principalId`: "taken", or which cap stood in the way — the principal's own
   * ("principal_full", checked first) or everyone's together ("total_full").
   */
  take(principalId: string): "taken" | "principal_full" | "total_full";
  release(principalId: string): void;
  /** In progress for one principal, or for everyone. For tests and diagnostics. */
  inProgress(principalId?: string): number;
}

export function createSlots(max: number, totalMax: number = Infinity): Slots {
  const counts = new Map<string, number>();
  let total = 0;
  return {
    take(principalId) {
      const n = counts.get(principalId) ?? 0;
      if (n >= max) return "principal_full";
      if (total >= totalMax) return "total_full";
      counts.set(principalId, n + 1);
      total++;
      return "taken";
    },
    release(principalId) {
      const n = counts.get(principalId) ?? 0;
      if (n === 0) return;
      total--;
      if (n > 1) counts.set(principalId, n - 1);
      else counts.delete(principalId);
    },
    inProgress(principalId) {
      return principalId === undefined ? total : (counts.get(principalId) ?? 0);
    },
  };
}

/**
 * Runs `work` holding one of `principalId`'s slots and gives it back exactly once, when `work` settles —
 * whether it returns or throws. Nothing runs between taking the slot and entering the `try`, so no path
 * keeps it. No slot: 429 `rate_limited` at the principal's own cap, 503 `busy` at everyone's.
 */
export async function withSlot<T>(slots: Slots, principalId: string, work: () => Promise<T>): Promise<T> {
  const taken = slots.take(principalId);
  if (taken === "principal_full") throw new AppError(429, "rate_limited");
  if (taken === "total_full") throw new AppError(503, "busy");
  try {
    return await work();
  } finally {
    slots.release(principalId);
  }
}
