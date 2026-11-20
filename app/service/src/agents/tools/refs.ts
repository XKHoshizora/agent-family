import type { MessageRef } from "../../messages/lookups.ts";

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

  /** The message `ref` names (as the model wrote it: spaces around it and its letter's case do not matter), or null. */
  messageOf(ref: string): MessageRef | null {
    return this.byMessageRef.get(normalised(ref)) ?? null;
  }

  /** The attachment `ref` names (as `messageOf` reads it), or null. */
  fileOf(ref: string): string | null {
    return this.byFileRef.get(normalised(ref)) ?? null;
  }
}

const normalised = (ref: string): string => ref.trim().toLowerCase();

/** A citation as a reply writes it: `〔m3〕`. */
const CITATION = /〔(m[1-9][0-9]{0,5})〕/g;

/**
 * A reply's text with its citations checked against `refs` (design rule 4): a `〔mN〕` whose number this run gave a message
 * stays in the text, and the message it names is kept by number (`cites`); one it never gave is taken out of the text.
 * Nothing else of the text changes. `cites` is empty when nothing was cited.
 */
export function citesIn(text: string, refs: RunRefs): { text: string; cites: Record<string, MessageRef> } {
  const cites: Record<string, MessageRef> = {};
  const kept = text.replace(CITATION, (whole, ref: string) => {
    const message = refs.messageOf(ref);
    if (message === null) return "";
    cites[ref] = message;
    return whole;
  });
  return { text: kept, cites };
}
