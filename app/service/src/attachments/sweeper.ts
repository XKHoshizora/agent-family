import type { Db } from "../db.ts";
import type { BlobStore } from "./blob.ts";
import { abandonedAfterMs, sweepPendingBlobs } from "./pending.ts";
import { sweepOrphans } from "./store.ts";

/** An unsent upload is deleted once it is older than this (`attachments:sweep --older-than` defaults to it too). */
export const DEFAULT_UNSENT_AFTER_MINUTES = 60;

/** The first scheduled run comes this long after start-up, not at once (the server is still settling). */
export const INITIAL_SWEEP_DELAY_MS = 60_000;

export interface SweepCounts {
  /** Uploads no message carries, deleted. */
  unsent: number;
  /** Blobs no row came to reference, deleted. */
  abandoned: number;
}

export interface SweepLogger {
  error(details: Record<string, unknown>, msg: string): void;
}

/** The whole sweep, as the CLI runs it and the server schedules it: unsent uploads, then abandoned blobs. */
export async function runSweep(
  deps: { db: Db; blobs: BlobStore },
  config: { uploadTotalTimeoutMs: number },
  log: SweepLogger,
  olderThanMinutes: number = DEFAULT_UNSENT_AFTER_MINUTES,
): Promise<SweepCounts> {
  const unsent = await sweepOrphans(deps, olderThanMinutes, {
    error: ({ err, attachmentId }, msg) => log.error({ err, attachmentId }, msg),
  });
  // Also blobs no row came to reference: refused uploads whose delete failed, uploads cut off or
  // interrupted by a crash, replaced avatars. Only once they are past the upload deadline.
  const abandoned = await sweepPendingBlobs(deps, abandonedAfterMs(config), {
    error: ({ err, key }, msg) => log.error({ err, key }, msg),
  });
  return { unsent, abandoned };
}

export interface Sweeper {
  /** Cancels the timers and waits for a run in flight; no run starts afterwards. */
  stop(): Promise<void>;
}

/**
 * Runs `run` once after `initialDelayMs`, then every `intervalMinutes`. Runs never overlap (a tick that finds
 * the previous run still going is skipped); a failing run is logged at warn and the schedule goes on. One info
 * line per run that deleted something. Returns undefined, with no timer, when `intervalMinutes` is 0.
 */
export function startSweeper(opts: {
  run: () => Promise<SweepCounts>;
  intervalMinutes: number;
  initialDelayMs?: number;
  log: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
}): Sweeper | undefined {
  if (opts.intervalMinutes <= 0) return undefined;
  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = (async () => {
      try {
        const counts = await opts.run();
        if (counts.unsent > 0 || counts.abandoned > 0) {
          opts.log.info(
            { unsent: counts.unsent, abandoned: counts.abandoned },
            "attachment sweep: deleted unsent uploads and abandoned blobs",
          );
        }
      } catch (err) {
        opts.log.warn({ err }, "attachment sweep: run failed; trying again next interval");
      } finally {
        inFlight = undefined;
      }
    })();
  };

  let interval: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    tick();
    if (stopped) return;
    interval = setInterval(tick, opts.intervalMinutes * 60_000);
    interval.unref();
  }, opts.initialDelayMs ?? INITIAL_SWEEP_DELAY_MS);
  first.unref();

  return {
    async stop() {
      stopped = true;
      clearTimeout(first);
      if (interval) clearInterval(interval);
      await inFlight;
    },
  };
}
