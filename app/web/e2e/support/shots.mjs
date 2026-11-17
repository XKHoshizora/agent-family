// Screenshots for the acceptance record (docs/acceptance/batch2a/shots/), taken only when E2E_SHOTS=1 (an ordinary run
// leaves the repository as it was). Every shot is of this run's own seeded people and Agents: generated names, fake keys.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { WEB_DIR } from "./env.mjs";

const DIR = path.resolve(WEB_DIR, "..", "..", "docs", "acceptance", "batch2a", "shots");
const SIZES = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

/** Whether this run takes the shots. */
export const shooting = process.env.E2E_SHOTS === "1";

/**
 * `<name>-desktop.png` (1440×900) and `<name>-mobile.png` (390×844) of the page as it is. `mobile()` puts the page in
 * the state the phone shot shows (e.g. back to a list), after the desktop one; `show` is scrolled into view in each.
 * The viewport is restored afterwards.
 */
export async function capture(page, name, { mobile, show } = {}) {
  if (!shooting) return;
  mkdirSync(DIR, { recursive: true });
  const before = page.viewportSize();
  // What was just shown is marked read only after it has been on screen for a moment (READ_DELAY_MS in ChatView):
  // the shot waits for that, as a person would, so it does not show a moment-old unread count.
  await page.waitForTimeout(900);
  try {
    for (const [label, size] of SIZES) {
      await page.setViewportSize(size);
      if (label === "mobile" && mobile) await mobile();
      if (show) await show.scrollIntoViewIfNeeded();
      // A conversation shown at its newest message (a narrower page makes its list taller).
      if (!show) {
        await page.evaluate(() => {
          for (const list of document.querySelectorAll('[data-testid="message-list"]')) list.scrollTop = list.scrollHeight;
        });
      }
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(DIR, `${name}-${label}.png`), animations: "disabled", caret: "hide" });
    }
  } finally {
    if (before) await page.setViewportSize(before);
  }
}
