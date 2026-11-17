// Imported first by the tests that show an Agent's text: the Markdown renderer (its own chunk in the app) is loaded up
// front, so an Agent's text is rendered at once, as in a page that has loaded it, and nothing resolves outside act().
// (tests/markdown-chunk.test.jsx covers the time before it has arrived.)
import { loadMarkdown } from "../src/pages/AgentChatBits.jsx";

await loadMarkdown();
