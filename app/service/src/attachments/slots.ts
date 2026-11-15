import { createSlots, type Slots } from "../slots.ts";

/** Uploads one principal may have in progress at once; one more is 429 `rate_limited`. */
export const MAX_CONCURRENT_UPLOADS = 3;

/**
 * Uploads in progress per principal, in this process (on `Deps.uploads`; the service runs as a single
 * instance). The upload route takes a slot per request and gives it back exactly once (`claimSlot`).
 */
export type UploadSlots = Slots;

export function createUploadSlots(max: number = MAX_CONCURRENT_UPLOADS): UploadSlots {
  return createSlots(max);
}
