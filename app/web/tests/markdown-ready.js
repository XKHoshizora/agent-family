// Imported first by the tests that show an Agent's text: the Markdown worker is stood in for by one on this thread
// (jsdom has no Worker; tests/markdown-worker.js), and the chunk that shows trees is loaded up front, so an Agent's
// text turns rich as soon as its answer arrives, as in a page that has loaded them, and nothing resolves outside act().
// (tests/markdown-chunk.test.jsx covers the time before the chunk has arrived, markdown-client.test.jsx the worker.)
import { loadMarkdown } from "../src/ui/AgentText.jsx";
import { useWorkers } from "./markdown-worker.js";

useWorkers();
await loadMarkdown();
