// Stand-ins for the Markdown worker in tests (jsdom has no Worker). `InProcessWorker` answers as the real one does —
// `{ ready }` once made, then `{ id, ...renderToTree(text) }` through a structured clone — a turn later, on this thread
// (the pipeline itself is tested directly). Its clock stands still, so the pipeline's time budgets never change what a
// test sees on a loaded machine (their own tests drive them with a clock of their own). `SilentWorker` loads and never
// answers (the deadline's tests).
import { act } from "@testing-library/react";
import { renderToTree } from "../src/ui/markdownPipeline.js";
import { createMarkdownClient, setMarkdownClient } from "../src/ui/markdownClient.js";

const later = (fn) => Promise.resolve().then(fn);

export class InProcessWorker {
  constructor({ ready = true, options = { now: () => 0 } } = {}) {
    this.options = options;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = false;
    this.sent = [];
    if (ready) later(() => this.emit({ ready: true }));
  }

  emit(data) {
    if (!this.terminated) this.onmessage?.({ data: structuredClone(data) });
  }

  postMessage(data) {
    this.sent.push(data);
    later(() => {
      if (this.terminated) return;
      let answer;
      try {
        answer = renderToTree(data.text, this.options);
      } catch {
        answer = { plain: true, reason: "error" };
      }
      this.emit({ id: data.id, ...answer });
    });
  }

  terminate() {
    this.terminated = true;
  }
}

/** A worker that loads and is sent texts, and never answers one. */
export class SilentWorker extends InProcessWorker {
  postMessage(data) {
    this.sent.push(data);
  }
}

/**
 * Installs a page client whose workers are made by `make` (default: InProcessWorker); returns it with the workers it
 * made, newest last.
 */
export function useWorkers(make = () => new InProcessWorker(), options = {}) {
  const workers = [];
  const client = createMarkdownClient({
    createWorker: () => {
      const worker = make(workers.length);
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  setMarkdownClient(client);
  return { client, workers };
}

/** Lets the worker's answers arrive and React show them (real timers). */
export async function settle(turns = 12) {
  await act(async () => {
    for (let i = 0; i < turns; i += 1) await Promise.resolve();
  });
}
