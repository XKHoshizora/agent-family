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
  | { op: "unlock"; ref: string }
  /** The owner mentioned this existing note again: one stronger, seen now (no change is recorded, nobody is told). */
  | { op: "seen"; ref: string };

/** The most operations of one answer that are looked at (a `seen` is no operation on a note: it is capped apart); the rest are dropped. */
export const MAX_OPS = 8;

/** The most `seen` entries of one answer that are looked at. */
export const MAX_SEEN = 20;

/** The entries of an answer's list that are looked at: the first `MAX_OPS` that are not a `seen`, and the first `MAX_SEEN` that are, in order. */
export function lookedAt(list: ReadonlyArray<unknown>): unknown[] {
  let ops = 0;
  let seen = 0;
  const kept: unknown[] = [];
  for (const raw of list) {
    const isSeen = typeof raw === "object" && raw !== null && (raw as { op?: unknown }).op === "seen";
    if (isSeen ? seen >= MAX_SEEN : ops >= MAX_OPS) continue;
    if (isSeen) seen++;
    else ops++;
    kept.push(raw);
  }
  return kept;
}

const FENCE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i;

/** The parsed JSON of the whole answer, or of the first fenced block in it; undefined when neither is JSON. */
export function parseAnswer(answer: string): unknown {
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
    case "seen":
      return hasExactly(o, ["op", "ref"]) && ref !== null ? { op: o.op, ref } : null;
    default:
      return null;
  }
}

/**
 * Whether the answer held an in-place op (`replace`) of the known shape naming a note it was shown whose text `modelNote` refuses (the
 * entries `lookedAt` keeps): `parseOps` drops it, and since the in-place ops of an answer stand or fall together (a merge is a replace
 * plus a remove) the caller drops the others too. Pure and total.
 */
export function refusedInPlace(answer: string, refs: ReadonlySet<string>): boolean {
  try {
    const parsed = parseAnswer(answer);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const list = (parsed as { ops?: unknown }).ops;
    if (!Array.isArray(list)) return false;
    return lookedAt(list).some((raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
      const o = raw as Record<string, unknown>;
      return o.op === "replace" && hasExactly(o, ["op", "ref", "text"]) && typeof o.ref === "string" && refs.has(o.ref) && typeof o.text === "string" && modelNote(o.text) === null;
    });
  } catch {
    return false;
  }
}

/**
 * The operations of a review's answer: one JSON object `{"ops":[…]}`, bare or in a fenced block (text around a fenced
 * block is ignored); anything else answers `[]`. Of the first `MAX_OPS` entries (and the first `MAX_SEEN` `seen` ones, counted apart), an entry with an unknown key, an unknown
 * `ref` (one not in `refs`), the wrong shape, or a text `modelNote` refuses is dropped. An `add` whose text equals one of
 * `existing`, or the text of an earlier `add` or `replace` of this answer, once case, whitespace and punctuation are
 * ignored, is dropped as well. A `seen` of a note already `seen` in this answer is dropped.
 */
export function parseOps(answer: string, refs: ReadonlySet<string>, existing: ReadonlyArray<string> = []): Op[] {
  try {
    const parsed = parseAnswer(answer);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    const list = (parsed as { ops?: unknown }).ops;
    if (!Array.isArray(list)) return [];
    const seen = new Set(existing.map(sameKey));
    const mentioned = new Set<string>();
    const ops: Op[] = [];
    for (const raw of lookedAt(list)) {
      const op = one(raw, refs);
      if (op === null) continue;
      // Once per note per review.
      if (op.op === "seen") {
        if (mentioned.has(op.ref)) continue;
        mentioned.add(op.ref);
      }
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
