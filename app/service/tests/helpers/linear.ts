import { expect } from "vitest";

/**
 * "Linear, not quadratic" tests without an absolute bound on milliseconds.
 *
 * `expectLinear` builds an input of size `n` and one `factor` times larger, times `run` on both, and asserts that the
 * larger takes less than `2 * factor` times as long as the smaller: a linear pass takes about `factor` times as long, a
 * quadratic one `factor ** 2` times (so use a `factor` of at least 4: that is 8 against 16). Nothing in it depends on how
 * fast the machine is:
 *  - one sample is `reps` calls in a row, with `reps` chosen so that a sample of the smaller size lasts at least
 *    `MIN_SAMPLE_MS` (ten times a timer's grain: neither it nor one pause of the collector decides a sample that long);
 *  - the larger size runs the same `reps`; each size counts by its fastest sample (a busy machine only ever adds time, so
 *    the fastest is the one closest to the truth), the two are sampled in turn (a load that lasts is felt by both), and
 *    more pairs are taken, up to `MAX_PAIRS`, while the two are not yet in proportion.
 * A busy machine makes the measurement longer, not wrong: a test that uses it asks for a timeout of its own that leaves
 * room for that (`LOADED_TIMEOUT_MS`).
 * `run` should check its own result (throw when it is wrong; `expect` costs time in the samples), so that a call that does less than it should cannot pass for fast.
 */
export const MIN_SAMPLE_MS = 10;
const MIN_PAIRS = 3;
const MAX_PAIRS = 25;
/** For the `it(…, { timeout })` of a test that calls `expectLinear` several times: a loaded machine takes several times longer to measure. */
export const LOADED_TIMEOUT_MS = 60_000;
const MAX_REPS = 5_000;
const MAX_N = 50_000_000;

const timed = (run: () => void, reps: number): number => {
  const started = performance.now();
  for (let i = 0; i < reps; i++) run();
  return performance.now() - started;
};

export function expectLinear<T>(options: { n: number; factor?: number; make: (n: number) => T; run: (input: T) => void }): { small: number; large: number; reps: number; n: number } {
  const { factor = 4, make, run } = options;
  let n = options.n;
  expect(factor).toBeGreaterThanOrEqual(4);
  // A call too quick to measure (a sample of MAX_REPS calls still under MIN_SAMPLE_MS) is made longer by growing the input,
  // never judged as it is: sub-millisecond samples decide nothing.
  let probe = 0;
  let [small, large] = [make(n), make(n * factor)];
  for (;;) {
    const once = () => run(small);
    once(); // warm up (compilation), and the result is checked once
    run(large);
    probe = Math.max(timed(once, 1), 0.001);
    if (probe * MAX_REPS >= MIN_SAMPLE_MS || n >= MAX_N) break;
    n *= 4;
    [small, large] = [make(n), make(n * factor)];
  }
  const [once, twice] = [() => run(small), () => run(large)];
  const reps = Math.min(MAX_REPS, Math.max(1, Math.ceil(MIN_SAMPLE_MS / probe)));
  let [fastSmall, fastLarge] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  // Pairs of samples, until the fastest of each size (so far) are in proportion, but at least `MIN_PAIRS` of them: noise only
  // ever adds time, so a busy machine takes more pairs, not a different answer (the fastest of each size, not the median,
  // because noise is one-sided: a median of a loaded machine is a measurement of the load), and a pass gone quadratic
  // (16 times, not 4) stays above the bound in every pair until `MAX_PAIRS` end it.
  for (let pair = 0; pair < MAX_PAIRS; pair++) {
    fastSmall = Math.min(fastSmall, timed(once, reps));
    fastLarge = Math.min(fastLarge, timed(twice, reps));
    if (pair + 1 >= MIN_PAIRS && fastLarge / fastSmall < 2 * factor) break;
  }
  expect(fastSmall, "the smaller input is still too quick to measure: give `expectLinear` a larger `n`").toBeGreaterThanOrEqual(MIN_SAMPLE_MS / 4);
  expect([`${factor} times the input`, fastLarge / fastSmall < 2 * factor], `large ${fastLarge.toFixed(1)} ms, small ${fastSmall.toFixed(1)} ms, ${reps} calls a sample, n ${n}`).toEqual([`${factor} times the input`, true]);
  return { small: fastSmall, large: fastLarge, reps, n };
}
