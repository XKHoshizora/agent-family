import { expect } from "vitest";

/**
 * "Linear, not quadratic" tests without an absolute bound on milliseconds.
 *
 * `expectLinear` builds an input of size `n` and one `factor` times larger, times `run` on both, and asserts that the
 * larger takes less than `2 * factor` times as long as the smaller: a linear pass takes about `factor` times as long, a
 * quadratic one `factor ** 2` times (so use a `factor` of at least 4: that is 8 against 16). Nothing in it depends on how
 * fast the machine is:
 *  - one sample is `reps` calls in a row, with `reps` chosen so that a sample of the smaller size lasts at least
 *    `MIN_SAMPLE_MS` (a timer's grain, or one pause of the collector, cannot decide a sample that long);
 *  - the larger size runs the same `reps`, and each size is the fastest of `SAMPLES` samples (a busy machine only ever
 *    adds time, so the fastest is the one closest to the truth; both sizes are measured the same way, alternately, so a
 *    load that lasts is felt by both).
 * `run` should check its own result (`expect(...)`), so that a call that does less than it should cannot pass for fast.
 */
export const MIN_SAMPLE_MS = 20;
const SAMPLES = 7;
const MAX_REPS = 5_000;

const timed = (run: () => void, reps: number): number => {
  const started = performance.now();
  for (let i = 0; i < reps; i++) run();
  return performance.now() - started;
};

export function expectLinear<T>(options: { n: number; factor?: number; make: (n: number) => T; run: (input: T) => void }): { small: number; large: number; reps: number } {
  const { n, factor = 4, make, run } = options;
  expect(factor).toBeGreaterThanOrEqual(4);
  const [small, large] = [make(n), make(n * factor)];
  const [once, twice] = [() => run(small), () => run(large)];
  once(); // warm up (compilation), and the result is checked once
  twice();
  // How many calls make a sample of the smaller size last long enough.
  const probe = Math.max(timed(once, 1), 0.001);
  const reps = Math.min(MAX_REPS, Math.max(1, Math.ceil(MIN_SAMPLE_MS / probe)));
  let [fastSmall, fastLarge] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  for (let i = 0; i < SAMPLES; i++) {
    fastSmall = Math.min(fastSmall, timed(once, reps));
    fastLarge = Math.min(fastLarge, timed(twice, reps));
  }
  expect([`${factor} times the input`, fastLarge / fastSmall < 2 * factor], `large ${fastLarge.toFixed(1)} ms, small ${fastSmall.toFixed(1)} ms, ${reps} calls a sample`).toEqual([`${factor} times the input`, true]);
  return { small: fastSmall, large: fastLarge, reps };
}
