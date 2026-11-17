// Imported first by the tests that show an Agent's text: the Markdown renderer (its own chunk in the app) is loaded up
// front, so an Agent's text is rendered at once, as in a page that has loaded it, and nothing resolves outside act().
// (tests/markdown-chunk.test.jsx covers the time before it has arrived.)
//
// A loaded test machine must not change what a test sees rendered, so the renderer's time limits are off here; the
// tests of the time limits switch them on (`useTimeLimits`) and drive them with a clock of their own.
import { afterEach, beforeEach } from "vitest";
import { loadMarkdown } from "../src/pages/AgentChatBits.jsx";
import { LIMITS } from "../src/ui/Markdown.jsx";

await loadMarkdown();

const TIME_KEYS = ["katexBudgetMs", "katexSlowMs", "highlightBudgetMs", "highlightSlowMs", "passMs"];
/** The renderer's time limits as the app has them. */
export const TIME_LIMITS = Object.freeze(Object.fromEntries(TIME_KEYS.map((key) => [key, LIMITS[key]])));
const off = () => {
  for (const key of TIME_KEYS) LIMITS[key] = Infinity;
};
off();

/** In the calling describe block, the time limits are the app's. */
export function useTimeLimits() {
  beforeEach(() => Object.assign(LIMITS, TIME_LIMITS));
  afterEach(off);
}
