// A requestAnimationFrame heartbeat measured in the page (as in markdown.spec.mjs): the longest gap between two frames
// tells whether the page's main thread was held up.
import { test } from "@playwright/test";

/** Starts a heartbeat in the page: the longest gap between two frames is kept. */
export async function startHeartbeat(page) {
  await page.evaluate(() => {
    const beat = { max: 0, last: performance.now(), frames: 0 };
    window.__heartbeat = beat;
    const tick = (now) => {
      beat.max = Math.max(beat.max, now - beat.last);
      beat.last = now;
      beat.frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** The heartbeat so far (also kept in the test's annotations, for the record). */
export async function heartbeat(page, label) {
  const beat = await page.evaluate(() => ({ max: Math.round(window.__heartbeat.max), frames: window.__heartbeat.frames }));
  test.info().annotations.push({ type: "heartbeat", description: `${label}: longest frame gap ${beat.max} ms over ${beat.frames} frames` });
  return beat;
}
