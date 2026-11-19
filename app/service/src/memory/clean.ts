import { cleanText } from "../agents/runtime/prompt.ts";
import { codePoints } from "./store.ts";

/**
 * What may be stored as a note. A note is stored as it was written (no folding, no stripping of brackets, quotes or
 * punctuation: an owner's words, and a model's history entry such as `现在喜欢麻婆豆腐（以前喜欢鱼香肉丝）`, stay as they
 * are); only line breaks and runs of whitespace become one space and invisible format characters go (`cleanText`, which
 * the notes passage applies again when it renders a note: a note is data, never structure). Two rule sets,
 * because two kinds of writer: the owner, who may write what they like in their own notes, and a model, which may not
 * slip an instruction, a link or a secret in.
 */

/** Longest entry a model writes, in code points (the plan's Numbers). */
export const MODEL_NOTE_MAX = 200;

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
  /你必须|你应该|以后都|忽略|无视|指令|听我的|从今以后|これからは必ず|今後は必ず|無視して|\bignore|\bdisregard|\byou must\b|\bfrom now on\b|\bforget (?:all|your)\b|\bsystem\b/i;

/** A password or passcode stated in plain words: a model never writes one into a note. */
const STATES_A_PASSWORD = /密码是|密码：|\bpassword\s+is\b|\bpassword\s*:|パスワードは|\bpasscode\b/i;

/** A bare domain with a path (`example.org/page`), which the list of known endings above does not catch. */
const BARE_DOMAIN_PATH = /\b[a-z0-9-]+\.[a-z]{2,}\/\S+/i;

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

/** What a model wrote as a note (the reviewer's): the owner's rules, and refused when over 200 code points, with a link or a bare domain with a path, stating a password or passcode, or addressing the reader as an instruction does. */
export function modelNote(text: string): string | null {
  const clean = tidy(text);
  if (clean === null || codePoints(clean) > MODEL_NOTE_MAX) return null;
  return URL_LIKE.some((p) => p.test(clean)) || BARE_DOMAIN_PATH.test(clean) || STATES_A_PASSWORD.test(clean) || ADDRESSES_THE_READER.test(clean) ? null : clean;
}
