/** Uploads one principal may have in progress at once; one more is 429 `rate_limited`. */
export const MAX_CONCURRENT_UPLOADS = 3;

/**
 * Uploads in progress per principal, in this process (on `Deps.uploads`; the service runs as a single
 * instance). The upload route takes a slot per request and gives it back exactly once.
 */
export interface UploadSlots {
  /** Takes a slot for `principalId`; false when it already has the maximum in progress. */
  tryTake(principalId: string): boolean;
  release(principalId: string): void;
  /** Uploads in progress for one principal, or for everyone. For tests and diagnostics. */
  inProgress(principalId?: string): number;
}

export function createUploadSlots(max: number = MAX_CONCURRENT_UPLOADS): UploadSlots {
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
