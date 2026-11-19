import { modelNote } from "./clean.ts";
import type { NoteKind } from "./store.ts";

/**
 * What a review may change, as the model's answer says it: a small list of operations on numbered notes. Nothing of
 * the answer is trusted: `parseOps` is pure and total (it never throws), keeps only operations of exactly the known
 * shapes naming a ref it was given, runs every text through `modelNote`, and drops what it does not understand.
 */

export type Op =
  | { op: "add"; kind: NoteKind; text: string }
  | { op: "replace"; ref: string; text: string }
  | { op: "remove"; ref: string }
  | { op: "lock"; ref: string }
  | { op: "unlock"; ref: string };

/** The most operations of one answer that are looked at; the rest are dropped. */
export const MAX_OPS = 8;

const FENCE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i;

/** The parsed JSON of the whole answer, or of the first fenced block in it; undefined when neither is JSON. */
function parseAnswer(answer: string): unknown {
  const attempt = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const whole = attempt(answer.trim());
  if (whole !== undefined) return whole;
  const fenced = FENCE.exec(answer);
  return fenced ? attempt(fenced[1]!.trim()) : undefined;
}

/** What two texts must differ in to be different: lower case, no whitespace, no punctuation. */
export const sameKey = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");

const hasExactly = (o: Record<string, unknown>, keys: string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};

function one(raw: unknown, refs: ReadonlySet<string>): Op | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const ref = typeof o.ref === "string" && refs.has(o.ref) ? o.ref : null;
  switch (o.op) {
    case "add": {
      if (!hasExactly(o, ["op", "kind", "text"]) || (o.kind !== "owner" && o.kind !== "self") || typeof o.text !== "string") return null;
      const text = modelNote(o.text);
      return text === null ? null : { op: "add", kind: o.kind, text };
    }
    case "replace": {
      if (!hasExactly(o, ["op", "ref", "text"]) || ref === null || typeof o.text !== "string") return null;
      const text = modelNote(o.text);
      return text === null ? null : { op: "replace", ref, text };
    }
    case "remove":
    case "lock":
    case "unlock":
      return hasExactly(o, ["op", "ref"]) && ref !== null ? { op: o.op, ref } : null;
    default:
      return null;
  }
}

/**
 * The operations of a review's answer: one JSON object `{"ops":[…]}`, bare or in a fenced block (text around a fenced
 * block is ignored); anything else answers `[]`. Of the first `MAX_OPS` entries, an entry with an unknown key, an unknown
 * `ref` (one not in `refs`), the wrong shape, or a text `modelNote` refuses is dropped. An `add` whose text equals one of
 * `existing`, or the text of an earlier `add` or `replace` of this answer, once case, whitespace and punctuation are
 * ignored, is dropped as well.
 */
export function parseOps(answer: string, refs: ReadonlySet<string>, existing: ReadonlyArray<string> = []): Op[] {
  try {
    const parsed = parseAnswer(answer);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    const list = (parsed as { ops?: unknown }).ops;
    if (!Array.isArray(list)) return [];
    const seen = new Set(existing.map(sameKey));
    const ops: Op[] = [];
    for (const raw of list.slice(0, MAX_OPS)) {
      const op = one(raw, refs);
      if (op === null) continue;
      if (op.op === "add" || op.op === "replace") {
        const key = sameKey(op.text);
        if (op.op === "add" && (key === "" || seen.has(key))) continue;
        seen.add(key);
      }
      ops.push(op);
    }
    return ops;
  } catch {
    return [];
  }
}
