import { AppError } from "./errors.ts";

/**
 * Work in progress per principal, in this process (the service runs as a single instance), with a cap:
 * uploads (3 at once) and searches (2 at once) each have one on `Deps`.
 */
export interface Slots {
  /** Takes a slot for `principalId`; false when it already has the maximum in progress. */
  tryTake(principalId: string): boolean;
  release(principalId: string): void;
  /** In progress for one principal, or for everyone. For tests and diagnostics. */
  inProgress(principalId?: string): number;
}

export function createSlots(max: number): Slots {
  const counts = new Map<string, number>();
  return {
    tryTake(principalId) {
      const n = counts.get(principalId) ?? 0;
      if (n >= max) return false;
      counts.set(principalId, n + 1);
      return true;
    },
    release(principalId) {
      const n = (counts.get(principalId) ?? 0) - 1;
      if (n > 0) counts.set(principalId, n);
      else counts.delete(principalId);
    },
    inProgress(principalId) {
      if (principalId !== undefined) return counts.get(principalId) ?? 0;
      let total = 0;
      for (const n of counts.values()) total += n;
      return total;
    },
  };
}

/**
 * Runs `work` holding one of `principalId`'s slots (429 `rate_limited` when none is free) and gives it
 * back exactly once, when `work` settles — whether it returns or throws. Nothing runs between taking the
 * slot and entering the `try`, so no path keeps it.
 */
export async function withSlot<T>(slots: Slots, principalId: string, work: () => Promise<T>): Promise<T> {
  if (!slots.tryTake(principalId)) throw new AppError(429, "rate_limited");
  try {
    return await work();
  } finally {
    slots.release(principalId);
  }
}
