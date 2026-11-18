/** An hour, in milliseconds. */
const HOUR_MS = 3_600_000;

/**
 * At most `cap` events per key (a group, a sender) within any hour, in this process's memory: the scheduler's caps on
 * judgements (scheduler.ts). Times are milliseconds (`Date.now()`). A key is remembered only while something of it lies
 * within the last hour — an event, or its being told it reached the cap — so what is kept never grows with every key
 * ever seen: keys are kept in the order they were last touched, and forgetting the ones untouched for an hour stops at
 * the first that was touched within it.
 */
export interface HourlyCap {
  /** Whether `key` had `cap` events within the hour before `now`. */
  full(key: string, now: number): boolean;
  /** One more event of `key`, at `now`. */
  count(key: string, now: number): void;
  /** Whether `key`'s reaching the cap is to be told now: not within the hour before `now` already. Remembers that it is. */
  tell(key: string, now: number): boolean;
  /** How many keys are remembered. */
  size(): number;
  clear(): void;
}

interface Entry {
  /** Its events within the last hour, oldest first. */
  times: number[];
  toldAt: number | null;
  touched: number;
}

export function createHourlyCap(cap: number): HourlyCap {
  const keys = new Map<string, Entry>();

  /** `key`'s entry with only its events of the hour before `now`; every key untouched for that hour forgotten first. */
  const current = (key: string, now: number): Entry | undefined => {
    for (const [k, entry] of keys) {
      if (entry.touched > now - HOUR_MS) break;
      keys.delete(k);
    }
    const entry = keys.get(key);
    while (entry && entry.times.length > 0 && entry.times[0]! <= now - HOUR_MS) entry.times.shift();
    return entry;
  };

  /** `key`'s entry touched at `now`: made if there was none, and moved to the end of the order. */
  const touched = (key: string, now: number): Entry => {
    const entry = current(key, now) ?? { times: [], toldAt: null, touched: now };
    entry.touched = now;
    keys.delete(key);
    keys.set(key, entry);
    return entry;
  };

  return {
    full: (key, now) => (current(key, now)?.times.length ?? 0) >= cap,
    count(key, now) {
      touched(key, now).times.push(now);
    },
    tell(key, now) {
      const toldAt = current(key, now)?.toldAt ?? null;
      if (toldAt !== null && toldAt > now - HOUR_MS) return false;
      touched(key, now).toldAt = now;
      return true;
    },
    size: () => keys.size,
    clear: () => keys.clear(),
  };
}
