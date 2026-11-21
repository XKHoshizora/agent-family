import { CITES_MAX, type MessageRef } from "../../messages/lookups.ts";

/**
 * The numbers a reply's model is given for what its tools and its context show it (README "Agents and runs", Tools in a
 * reply): `m1`, `m2`… for messages a search handed it, `f1`, `f2`… for files (every attachment label of a reply offered
 * tools, and every file a search found). Never a conversation id, a seq or an attachment id: the model names a thing only
 * by a number this run gave it, and a number means nothing in any other run. One per reply run, in memory, held by the
 * port from `begin` until the run is finished or released (port-impl.ts). A number is minted once per thing, in the
 * order things are first shown.
 */
export class RunRefs {
  private readonly messages = new Map<string, string>();
  private readonly byMessageRef = new Map<string, MessageRef>();
  private readonly files = new Map<string, string>();
  private readonly byFileRef = new Map<string, string>();

  /** The number of message `seq` of `conversationId`: the one it was given, or the next `m`. */
  message(conversationId: string, seq: number): string {
    const key = `${conversationId}|${seq}`;
    let ref = this.messages.get(key);
    if (ref === undefined) {
      ref = `m${this.messages.size + 1}`;
      this.messages.set(key, ref);
      this.byMessageRef.set(ref, { conversationId, seq });
    }
    return ref;
  }

  /** The number of attachment `attachmentId`: the one it was given, or the next `f`. */
  file(attachmentId: string): string {
    let ref = this.files.get(attachmentId);
    if (ref === undefined) {
      ref = `f${this.files.size + 1}`;
      this.files.set(attachmentId, ref);
      this.byFileRef.set(ref, attachmentId);
    }
    return ref;
  }

  /** The message `ref` names (as the model wrote it: spaces in it and its letter's case do not matter), or null. */
  messageOf(ref: string): MessageRef | null {
    return this.byMessageRef.get(normalised(ref)) ?? null;
  }

  /** The attachment `ref` names (as `messageOf` reads it), or null. */
  fileOf(ref: string): string | null {
    return this.byFileRef.get(normalised(ref)) ?? null;
  }
}

const normalised = (ref: string): string => ref.replace(/\s+/g, "").toLowerCase();

/**
 * A citation as a reply may write it: `〔m3〕` for a message, `〔f2〕` for a file — also with spaces inside the brackets
 * or a capital letter (`〔 M3 〕`), read as the number they name (`messageOf`).
 */
const CITATION = /〔\s*([mMfF])\s*([1-9][0-9]{0,5})\s*〕/g;

/**
 * `text` without any citation in it (`〔m3〕`, `〔f2〕`, however written): what every text the model is shown and did
 * not write in its own run goes through (I-2: a number means something only in the run that gave it, so an earlier
 * reply's `〔m1〕` copied into this one would link whatever this run's `m1` is) — earlier messages and their quotes in
 * its context, the files it reads, what its searches and its memory show it — and an acknowledgement, which cites nothing.
 * Taken out until none is left: one built around another (`〔m〔m1〕1〕`) leaves no citation behind.
 */
export function withoutCitations(text: string): string {
  let out = text;
  for (let next = out.replace(CITATION, ""); next !== out; next = out.replace(CITATION, "")) out = next;
  return out;
}

/**
 * A reply's text with its citations checked against `refs` (design rule 4): a `〔mN〕` whose number this run gave a message
 * stays in the text (written as `〔mN〕`), and the message it names is kept by number (`cites`), the first `CITES_MAX`
 * numbers only; a `〔fN〕` whose number this run gave a file stays (written as `〔fN〕`; a file is not linked); any other —
 * a number this run never gave, or a message's past the first `CITES_MAX` — is taken out of the text. Nothing else of
 * the text changes. `cites` is empty when nothing was cited.
 */
export function citesIn(text: string, refs: RunRefs): { text: string; cites: Record<string, MessageRef> } {
  const cites: Record<string, MessageRef> = {};
  let kept = 0;
  const out = text.replace(CITATION, (_whole, letter: string, digits: string) => {
    const ref = `${letter.toLowerCase()}${digits}`;
    if (ref.startsWith("f")) return refs.fileOf(ref) === null ? "" : `〔${ref}〕`;
    if (cites[ref] !== undefined) return `〔${ref}〕`;
    const message = refs.messageOf(ref);
    if (message === null || kept >= CITES_MAX) return "";
    cites[ref] = message;
    kept++;
    return `〔${ref}〕`;
  });
  return { text: out, cites };
}
