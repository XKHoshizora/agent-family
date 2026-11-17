// The main thread's link to the Markdown worker (markdownWorker.js). The main thread never parses Markdown, typesets
// or highlights: it sends a text, waits a short while for the worker's tree, checks it (markdownTree.js), and keeps it.
//   - One dedicated module worker, made the first time it is needed and kept. Its answers are waited for at most
//     DEADLINE_MS from the moment the text is sent: a late answer ends the worker (a new one is made for the next text),
//     the text is shown plain, and it is remembered as slow (slowTexts.jsx) so that it is never sent again.
//   - One text at a time, the most needed first (the caller says how much); a text no one wants any more by the time
//     it would be sent is dropped. Texts asked for twice share one answer.
//   - Answers are kept by the text's digest (CACHE_ENTRIES of them, CACHE_ELEMENTS elements in all, oldest out first).
//   - No worker (none can be made, or it fails to load): every Agent text is shown plain, with no note. The main
//     thread never runs the pipeline itself.
import { digestOf, isSlowText, rememberSlowText } from "./slowTexts.jsx";
import { validateTree } from "./markdownTree.js";
import { MAX_CHARS } from "./markdownLimits.js";

/** How long an answer is waited for once its text has been sent, in milliseconds. */
export const DEADLINE_MS = 250;
/** How long a new worker may take to load before workers count as unavailable, in milliseconds. */
export const STARTUP_MS = 15000;
/** Workers that fail one after another (crash, not late) before workers count as unavailable. */
const FAILURES_MAX = 3;
export const CACHE_ENTRIES = 200;
export const CACHE_ELEMENTS = 60000;

/** What a text is shown as when no tree comes: plain, with the note (`complex`, `slow`) or without (`unavailable`, `error`). */
const COMPLEX = Object.freeze({ plain: true, reason: "complex" });
const SLOW = Object.freeze({ plain: true, reason: "slow" });
const UNAVAILABLE = Object.freeze({ plain: true, reason: "unavailable" });
const FAILED = Object.freeze({ plain: true, reason: "error" });
/** What a request no one wanted any more resolves to. */
export const DROPPED = Object.freeze({ dropped: true });
/** Whether a plain result is shown with the note "这条回复内容过于复杂，已按纯文本显示。". */
export const withNote = (result) => result?.plain === true && (result.reason === "complex" || result.reason === "slow");

const newWorker = () => new Worker(new URL("./markdownWorker.js", import.meta.url), { type: "module" });

/**
 * A client. `createWorker`, `deadlineMs`, `startupMs`: tests. `request(text, { wanted, priority, remember })` resolves
 * with `{ tree, elements, rendered }`, a plain result, or DROPPED; `peek(text)` is what is known now (or null).
 */
export function createMarkdownClient({ createWorker = newWorker, deadlineMs = DEADLINE_MS, startupMs = STARTUP_MS } = {}) {
  /** The worker: `{ worker, ready, startTimer }`, or null (none yet, or ended). */
  let live = null;
  let unavailable = false;
  let failures = 0;
  /** Texts waiting, by digest: `{ text, digest, waiters: [{ resolve, wanted, priority, remember }] }`. */
  const queue = new Map();
  /** The text sent and not answered yet: `{ job, id, timer }`. */
  let inFlight = null;
  let nextId = 1;
  const cache = new Map();
  let cachedElements = 0;

  function keep(digest, result) {
    const old = cache.get(digest);
    if (old) {
      cachedElements -= old.elements ?? 0;
      cache.delete(digest);
    }
    cache.set(digest, result);
    cachedElements += result.elements ?? 0;
    while (cache.size > CACHE_ENTRIES || cachedElements > CACHE_ELEMENTS) {
      const [oldest, value] = cache.entries().next().value;
      cache.delete(oldest);
      cachedElements -= value.elements ?? 0;
    }
  }

  function known(text, digest) {
    if (unavailable) return UNAVAILABLE;
    if (typeof text !== "string" || text.length > MAX_CHARS) return COMPLEX;
    const hit = cache.get(digest);
    if (hit) {
      cache.delete(digest);
      cache.set(digest, hit);
      return hit;
    }
    return isSlowText(text) ? SLOW : null;
  }

  function settle(job, result) {
    for (const waiter of job.waiters) waiter.resolve(result);
  }

  function endWorker() {
    if (!live) return;
    clearTimeout(live.startTimer);
    live.worker.onmessage = null;
    live.worker.onerror = null;
    live.worker.onmessageerror = null;
    try {
      live.worker.terminate();
    } catch {
      /* already gone */
    }
    live = null;
  }

  function becomeUnavailable() {
    unavailable = true;
    endWorker();
    if (inFlight) {
      clearTimeout(inFlight.timer);
      settle(inFlight.job, UNAVAILABLE);
      inFlight = null;
    }
    for (const job of queue.values()) settle(job, UNAVAILABLE);
    queue.clear();
  }

  /** The worker crashed or sent something unreadable: this text is plain; after FAILURES_MAX in a row, no workers. */
  function failed(entry) {
    if (live !== entry) return;
    const loaded = entry.ready;
    endWorker();
    failures += 1;
    if (!loaded || failures >= FAILURES_MAX) {
      becomeUnavailable();
      return;
    }
    if (inFlight) {
      clearTimeout(inFlight.timer);
      settle(inFlight.job, FAILED);
      inFlight = null;
    }
    pump();
  }

  function workerNow() {
    if (live) return live;
    let worker;
    try {
      worker = createWorker();
    } catch {
      becomeUnavailable();
      return null;
    }
    const entry = { worker, ready: false, startTimer: null };
    entry.startTimer = setTimeout(() => {
      if (live === entry && !entry.ready) {
        endWorker();
        becomeUnavailable();
      }
    }, startupMs);
    worker.onmessage = (event) => answered(entry, event.data);
    worker.onerror = (event) => {
      event?.preventDefault?.();
      failed(entry);
    };
    worker.onmessageerror = () => failed(entry);
    live = entry;
    return entry;
  }

  function answered(entry, data) {
    if (live !== entry) return;
    if (data?.ready === true) {
      entry.ready = true;
      clearTimeout(entry.startTimer);
      pump();
      return;
    }
    if (!inFlight || data?.id !== inFlight.id) return;
    clearTimeout(inFlight.timer);
    const { job } = inFlight;
    inFlight = null;
    failures = 0;
    let result;
    if (data.plain === true) {
      result = data.reason === "complex" ? COMPLEX : FAILED;
    } else {
      const checked = validateTree(data.tree);
      result = checked.ok ? Object.freeze({ tree: data.tree, elements: checked.elements, rendered: checked.rendered }) : COMPLEX;
    }
    if (result !== FAILED) keep(job.digest, result);
    settle(job, result);
    pump();
  }

  function late(id) {
    if (!inFlight || inFlight.id !== id) return;
    const { job } = inFlight;
    inFlight = null;
    endWorker();
    if (job.waiters.some((waiter) => waiter.remember)) {
      rememberSlowText(job.text);
      keep(job.digest, SLOW);
    }
    settle(job, SLOW);
    pump();
  }

  /** Sends the most needed text still wanted, when the worker is free and ready. */
  function pump() {
    if (unavailable || inFlight) return;
    for (const [digest, job] of queue) {
      job.waiters = job.waiters.filter((waiter) => {
        if (waiter.wanted()) return true;
        waiter.resolve(DROPPED);
        return false;
      });
      if (job.waiters.length === 0) queue.delete(digest);
    }
    if (queue.size === 0) return;
    const entry = workerNow();
    if (!entry || !entry.ready) return;
    let next = null;
    let best = Infinity;
    for (const job of queue.values()) {
      for (const waiter of job.waiters) {
        let p;
        try {
          p = Number(waiter.priority());
        } catch {
          p = 0;
        }
        if (Number.isNaN(p)) p = 0;
        if (next === null || p < best) {
          next = job;
          best = p;
        }
      }
    }
    queue.delete(next.digest);
    const id = nextId;
    nextId += 1;
    inFlight = { job: next, id, timer: setTimeout(() => late(id), deadlineMs) };
    try {
      entry.worker.postMessage({ id, text: next.text });
    } catch {
      failed(entry);
    }
  }

  return {
    /** What is known about this text now: a kept answer, plain (too long, slow before, no workers), or null. */
    peek(text) {
      return known(text, typeof text === "string" ? digestOf(text) : "");
    },
    /**
     * Asks for the text's tree. `wanted()`: still needed (checked before it is sent); `priority()`: lower is sooner;
     * `remember`: a late answer marks this text as slow (false for the pieces of a reply being written).
     */
    request(text, { wanted = () => true, priority = () => 0, remember = true } = {}) {
      const digest = typeof text === "string" ? digestOf(text) : "";
      const now = known(text, digest);
      if (now) return Promise.resolve(now);
      return new Promise((resolve) => {
        const waiter = { resolve, wanted, priority, remember };
        if (inFlight?.job.digest === digest) {
          inFlight.job.waiters.push(waiter);
          return;
        }
        const job = queue.get(digest) ?? { text, digest, waiters: [] };
        job.waiters.push(waiter);
        queue.set(digest, job);
        pump();
      });
    },
    /** Whether Agent texts can be rendered at all here (false once workers have failed). */
    get available() {
      return !unavailable;
    },
  };
}

let shared = null;
/** The page's client (made on first use). */
export function markdownClient() {
  shared ??= createMarkdownClient();
  return shared;
}
/** Replaces the page's client (tests: a worker of their own). */
export function setMarkdownClient(client) {
  shared = client;
}
