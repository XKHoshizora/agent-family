import type { Config } from "../config.ts";
import { guardedFetch } from "../providers/guard.ts";
import { createSlots } from "../slots.ts";

/**
 * The judgement model: a small upstream that answers typed questions about a piece of text with probabilities. The
 * request is `POST <url>` with `{ model, state, questions }` and the answer `{ answers }` (see `Question`). Nothing
 * here logs, and no error carries the key, the path, the state, a question or an answer.
 */

/** A question about the state: a yes/no probability (`noul`), or a probability for each of a few named options. */
export type Question =
  | { key: string; type: "noul"; instructions: string }
  | { key: string; type: "choice"; instructions: string; options: Readonly<Record<string, string>> };

/** What a question was answered. A probability is always a finite number in [0, 1]. */
export type Answer = { type: "noul"; p: number } | { type: "choice"; probabilities: ReadonlyMap<string, number> };

/** No channel gave an answer (any reason: the upstream, the network, the time, a key not set). */
export class JudgeError extends Error {
  constructor(message = "the judgement model gave no answer") {
    super(message);
    this.name = "JudgeError";
  }
}

export interface Judge {
  /**
   * Asks `questions` about `state` in one call. A key whose answer is missing or malformed is left out of the map (the
   * caller reads that as "no answer"). Rejects with a `JudgeError` when every channel failed, and with the signal's
   * reason when `signal` aborts.
   */
  ask(state: string, questions: readonly Question[], signal?: AbortSignal): Promise<Map<string, Answer>>;
}

/** The most options one choice question is sent with; one with more is not sent (`askable`). */
export const MAX_CHOICE_OPTIONS = 254;
/** An answer is a few numbers; this is plenty. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Calls in flight at once, for the judgement alone. */
const MAX_CALLS = 32;

const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether `q` can be sent at all: a choice needs 1 to `MAX_CHOICE_OPTIONS` options, each with a name. */
function askable(q: Question): boolean {
  if (q.type === "noul") return true;
  const names = Object.keys(q.options);
  return names.length > 0 && names.length <= MAX_CHOICE_OPTIONS && names.every((n) => n !== "");
}

function bodyOf(model: string, state: string, questions: readonly Question[]): string {
  const sent: Record<string, unknown> = {};
  for (const q of questions) {
    sent[q.key] =
      q.type === "noul"
        ? { type: "noul", instructions: q.instructions }
        : { type: "choice", instructions: q.instructions, criteria: q.options };
  }
  return JSON.stringify({ model, state, questions: sent });
}

/** The answers of a good response; null when the body is not `{ "answers": { … } }`. */
function parse(text: string, questions: readonly Question[]): Map<string, Answer> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json) || !isRecord(json.answers)) return null;
  const answers = json.answers;
  const out = new Map<string, Answer>();
  for (const q of questions) {
    const a = Object.hasOwn(answers, q.key) ? answers[q.key] : undefined;
    if (!isRecord(a)) continue;
    if (q.type === "noul") {
      if (isProbability(a.noul)) out.set(q.key, { type: "noul", p: a.noul });
      continue;
    }
    if (!isRecord(a.probabilities)) continue;
    const probabilities = new Map<string, number>();
    for (const name of Object.keys(q.options)) {
      const p = Object.hasOwn(a.probabilities, name) ? a.probabilities[name] : undefined;
      if (isProbability(p)) probabilities.set(name, p);
    }
    if (probabilities.size > 0) out.set(q.key, { type: "choice", probabilities });
  }
  return out;
}

export function createJudge(
  config: NonNullable<Config["judge"]>,
  opts: { allowInsecureLocal?: boolean; env?: NodeJS.ProcessEnv } = {},
): Judge {
  const env = opts.env ?? process.env;
  const fetch = guardedFetch({
    maxResponseBytes: MAX_RESPONSE_BYTES,
    timeoutMs: config.timeoutMs,
    calls: createSlots(MAX_CALLS),
    ...(opts.allowInsecureLocal === true ? { allowInsecureLocal: true } : {}),
  });

  /** One attempt at one channel: the answers, or null for any failure. */
  async function attempt(channel: { url: string; apiKeyEnv: string }, body: string, questions: readonly Question[], signal?: AbortSignal) {
    // The key is read now, as a site model's is, and never kept.
    const key = env[channel.apiKeyEnv];
    if (key === undefined || key === "") return null;
    const bound = AbortSignal.timeout(config.timeoutMs);
    try {
      const res = await fetch(channel.url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json; charset=utf-8" },
        body,
        signal: signal ? AbortSignal.any([signal, bound]) : bound,
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      return parse(await res.text(), questions);
    } catch {
      return null;
    }
  }

  return {
    async ask(state, questions, signal) {
      signal?.throwIfAborted();
      const sendable = questions.filter(askable);
      if (sendable.length === 0) return new Map();
      const body = bodyOf(config.model, state, sendable);
      for (const channel of config.channels) {
        const answers = await attempt(channel, body, sendable, signal);
        // The caller gave up: that is its abort, not a channel's failure, and no other channel is tried.
        signal?.throwIfAborted();
        if (answers !== null) return answers;
      }
      throw new JudgeError();
    },
  };
}
