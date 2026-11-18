import type { Answer, Judge, Question } from "../../src/judge/client.ts";

/** What a scripted answer says: a number answers a `noul` question, an object of option → probability a `choice`. */
export type ScriptedAnswers = Record<string, number | Record<string, number>>;

/** What the script does with a call: answer, fail (the `Error` is thrown), or never answer until the signal aborts. */
export type JudgeScript = (state: string, questions: readonly Question[]) => ScriptedAnswers | Error | "hang";

/** The name an option of the pick is described with (`{name}：…`; `nobody` for nobody's). */
export const nameOf = (key: string, description: string): string => (key === "nobody" ? "nobody" : description.slice(0, description.indexOf("：")));

/**
 * A script answering by name: every option of the pick with `pick[name]`, 0 when it is not given — but `nobody`, unless
 * given, takes what is left of 1, so that the whole answer sums to 1 as the model's do — and each quiet question about
 * an Agent `quiet` names.
 */
export const byName =
  (pick: Record<string, number>, quiet: Record<string, number> = {}) =>
  (_state: string, questions: readonly Question[]): ScriptedAnswers => {
    const named = Object.values(pick).reduce((sum, p) => sum + p, 0);
    const out: ScriptedAnswers = {};
    for (const q of questions) {
      if (q.type === "choice") {
        out[q.key] = Object.fromEntries(
          Object.entries(q.options).map(([k, d]) => {
            const name = nameOf(k, d);
            return [k, pick[name] ?? (name === "nobody" ? Math.max(0, 1 - named) : 0)];
          }),
        );
      } else {
        const name = /「(.+?)」/.exec(q.instructions)![1]!;
        if (quiet[name] !== undefined) out[q.key] = quiet[name];
      }
    }
    return out;
  };

export interface ScriptedJudge extends Judge {
  /** Every call received, in order. */
  readonly calls: { state: string; questions: readonly Question[] }[];
  /** Sets what calls do from now on (default: no key answered). */
  answer(fn: JudgeScript): ScriptedJudge;
}

/**
 * A judgement model for rule tests, injected as `Deps.judge`. As the real client does, a key the script leaves out, or
 * answers with the wrong kind of value, or with nothing valid, is left out of the map.
 */
export function scriptedJudge(): ScriptedJudge {
  let script: JudgeScript = () => ({});
  const calls: ScriptedJudge["calls"] = [];
  const judge: ScriptedJudge = {
    calls,
    answer(fn) {
      script = fn;
      return judge;
    },
    async ask(state, questions, signal) {
      calls.push({ state, questions });
      signal?.throwIfAborted();
      if (questions.length === 0) return new Map();
      const result = script(state, questions);
      if (result === "hang") {
        await new Promise<never>((_, reject) => {
          const onAbort = () => reject(signal!.reason);
          if (signal) signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (result instanceof Error) throw result;
      const out = new Map<string, Answer>();
      for (const q of questions) {
        const given = (result as ScriptedAnswers)[q.key];
        if (q.type === "noul") {
          if (typeof given === "number" && Number.isFinite(given) && given >= 0 && given <= 1) out.set(q.key, { type: "noul", p: given });
        } else if (typeof given === "object" && given !== null) {
          const probabilities = new Map<string, number>();
          for (const name of Object.keys(q.options)) {
            const p = given[name];
            if (typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) probabilities.set(name, p);
          }
          if (probabilities.size > 0) out.set(q.key, { type: "choice", probabilities });
        }
      }
      return out;
    },
  };
  return judge;
}
