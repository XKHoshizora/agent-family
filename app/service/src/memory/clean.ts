import { labelSafe, oneLine } from "../agents/runtime/prompt.ts";

/**
 * What may be stored as a note. Notes are data, not instructions: every note is put on one line and cleaned as a label
 * is (`labelSafe`: folded, without brackets, bars and invisible format characters) before the prompt shows it. Two
 * rule sets, because two kinds of writer: the owner, who may write what they like in their own notes, and a model,
 * which may not slip an instruction, a link or a secret in.
 */

/** Longest entry a model writes, in code points (the plan's Numbers). */
export const MODEL_NOTE_MAX = 200;

const FORMAT_CHARACTER = /\p{Cf}/u;
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

/**
 * The cleaned text, or null when it is empty, key-like, or held an invisible format character (which could hide
 * anything). Also says whether cleaning dropped anything but a line break: a bracket, a bar.
 */
function cleaned(text: string): { text: string; dropped: boolean } | null {
  const folded = text.normalize("NFKC");
  if (FORMAT_CHARACTER.test(folded)) return null;
  const clean = labelSafe(text);
  if (clean === "" || keyLike(clean)) return null;
  return { text: clean, dropped: oneLine(folded) !== clean };
}

/**
 * What the owner typed as a note: on one line, cleaned as a label is, trimmed. Null when empty, key-like, or it held
 * format characters. No limit but the room's, and no rule about instructions or links.
 */
export function ownerNote(text: string): string | null {
  return cleaned(text)?.text ?? null;
}

/**
 * What a model wrote as a note (the reviewer's, later tasks): the owner's rules, and refused when cleaning had to drop
 * more than whitespace, over 200 code points, with a link, or addressing the reader as an instruction does.
 */
export function modelNote(text: string): string | null {
  const c = cleaned(text);
  if (c === null || c.dropped) return null;
  if ([...c.text].length > MODEL_NOTE_MAX) return null;
  if (URL_LIKE.some((p) => p.test(c.text)) || ADDRESSES_THE_READER.test(c.text)) return null;
  return c.text;
}
