// The Markdown worker: a dedicated module worker (same origin, built by Vite) that runs the whole pipeline for an
// Agent's text off the page's main thread (markdownPipeline.js) and answers with a plain tree. The main thread
// (markdownClient.js) sends one `{ id, text }` at a time, waits a short while for `{ id, tree, elements }` or
// `{ id, plain, reason }`, and ends this worker if the answer is late. `{ ready: true }` once it has loaded.
import { renderToTree } from "./markdownPipeline.js";

self.onmessage = (event) => {
  const { id, text } = event.data ?? {};
  if (!Number.isSafeInteger(id) || typeof text !== "string") return;
  let answer;
  try {
    answer = renderToTree(text);
  } catch {
    answer = { plain: true, reason: "error" };
  }
  self.postMessage({ id, ...answer });
};

self.postMessage({ ready: true });
