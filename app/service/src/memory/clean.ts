import { cleanText } from "../agents/runtime/prompt.ts";
import { codePoints } from "./store.ts";

/**
 * What may be stored as a note. A note is stored as it was written (no folding, no stripping of brackets, quotes or
 * punctuation: an owner's words, and a model's history entry such as `现在喜欢麻婆豆腐（以前喜欢鱼香肉丝）`, stay as they
 * are); only line breaks and runs of whitespace become one space and invisible format characters go. Notes are data,
 * not instructions: every prompt path cleans them again when it renders them (`labelSafe`, `oneLine`). Two rule sets,
 * because two kinds of writer: the owner, who may write what they like in their own notes, and a model, which may not
 * slip an instruction, a link or a secret in.
 */

/** Longest entry a model writes, in code points (the plan's Numbers). */
export const MODEL_NOTE_MAX = 200;

const FORMAT_CHARACTERS = /\p{Cf}/gu;
const WHITESPACE_RUN = /\s+/g;
// What the database refuses and no one can read: control characters, and a surrogate with no partner (with `u` a proper
// pair is one astral character, so what is left in the surrogate range is lone).
const CONTROL_OR_LONE_SURROGATE = /\p{Cc}|[\ud800-\udfff]/gu;
const KEY_RUN = /[A-Za-z0-9_-]{20,}/g;
const KEY_PREFIX = /\b(?:sk-[\w-]|ghp_\w|AKIA\w)|-----BEGIN/;

/** A run of 20 or more key characters holding both a letter and a digit, or the start of a well-known secret. */
function keyLike(text: string): boolean {
  if (KEY_PREFIX.test(text)) return true;
  return (text.match(KEY_RUN) ?? []).some((run) => /[A-Za-z]/.test(run) && /\d/.test(run));
}

const URL_LIKE = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|cn|dev|app|co|me|ai|info|xyz|ly|gg|tv|edu|gov|jp|uk|de|fr|ru)\b/i,
];

/** Words that address whoever reads the note: what makes it an instruction rather than a fact. */
const ADDRESSES_THE_READER =
  /你必须|你应该|以后都|忽略|无视|指令|听我的|从今以后|これからは必ず|無視して|\bignore|\byou must\b|\bsystem\b/i;

export { cleanText };

/** The cleaned text; null when nothing is left or it looks like a key or secret. */
function tidy(text: string): string | null {
  const clean = cleanText(text);
  return clean === "" || keyLike(clean) ? null : clean;
}

/** What the owner typed as a note. No limit but the room's, and no rule about instructions or links. */
export function ownerNote(text: string): string | null {
  return tidy(text);
}

/** What a model wrote as a note (the reviewer's): the owner's rules, and refused when over 200 code points, with a link, or addressing the reader as an instruction does. */
export function modelNote(text: string): string | null {
  const clean = tidy(text);
  if (clean === null || codePoints(clean) > MODEL_NOTE_MAX) return null;
  return URL_LIKE.some((p) => p.test(clean)) || ADDRESSES_THE_READER.test(clean) ? null : clean;
}
