import { cleanText } from "../agents/runtime/prompt.ts";
import { weight } from "./weight.ts";

/**
 * What may be stored as a note. A note is stored as it was written (no folding, no stripping of brackets, quotes or
 * punctuation: an owner's words, and a model's history entry such as `现在喜欢麻婆豆腐（以前喜欢鱼香肉丝）`, stay as they
 * are); only line breaks and runs of whitespace become one space and invisible format characters go (`cleanText`, which
 * the notes passage applies again when it renders a note: a note is data, never structure). Two rule sets,
 * because two kinds of writer: the owner, who may write what they like in their own notes, and a model, which may not
 * slip an instruction, a link or a secret in.
 */

/**
 * Longest entry a model writes, in weight (`MEMORY.modelEntryMax`, at most 200: the database guard on hearsay holds 600 characters, which is
 * 200 weight of the shortest kind; weight.ts): 200 Chinese characters, about 600 English letters. The service sets it from its configuration
 * when it is built (`setModelEntryMax`); `modelNote` is a pure function of its text and this one number.
 */
let modelEntryMaxNow = 200;
export const setModelEntryMax = (max: number): void => void (modelEntryMaxNow = max);
export const modelEntryMax = (): number => modelEntryMaxNow;

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
const ADDRESSES_THE_READER = /你必须|你应该|忽略|无视|指令|听我的|無視して|\bignore|\bdisregard|\byou must\b|\bforget (?:all|your)\b|\bsystem\b/i;

/**
 * A password or passcode stated with its value: a model never writes one into a note. Whatever follows `password is`, `password was`,
 * `password's` (either apostrophe), `密码是` / `密码就是` / `密码为`, `密码：` or `密码＝` counts as a value, with one exception: where it is kept (`is stored in`,
 * `is kept with`, `is managed by`…), and only when nothing after it says `:` or `=` (`stored in plain text: hunter2` is a value). A bare
 * mention of having or forgetting one is no secret.
 */
const STATES_A_PASSWORD = /密[码碼]\s*(?:就是|也是|还是|還是|都是|是|为|為)\s*\S|密[码碼]\s*[:：=＝]\s*\S|\b(?:password|passcode)\s*(?:is(?!\s+(?:stored|kept|saved|managed)\s+(?:in|with|by)\b[^:：=]*$)|[:=])\s*\S|\b(?:password|passcode)\s+was\s+\S|\b(?:password|passcode)[’']s\s+\S|パスワードは\s*\S*[0-9A-Za-z]{3,}/i;

/**
 * A bare domain with a path (`example.org/page`), which the list of known endings above does not catch: a dot-separated host of at least two
 * labels whose last is 2 to 6 letters, then `/` and a path of 3 characters or more; not where that last label is a file ending (`node.js/docs`, `package.json/scripts`).
 */
const BARE_DOMAIN_PATH = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?!(?:js|ts|py|md|go|rs|json|yml|yaml|toml|lock|css|html)\b)[a-z]{2,6}\/\S{3,}/i;

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

/** What a model wrote as a note (the reviewer's): the owner's rules, and refused when over `modelEntryMax` (200) weight, with a link or a bare domain with a path, stating a password or passcode, or addressing the reader as an instruction does. */
export function modelNote(text: string): string | null {
  const clean = tidy(text);
  if (clean === null || weight(clean) > modelEntryMaxNow) return null;
  return URL_LIKE.some((p) => p.test(clean)) || BARE_DOMAIN_PATH.test(clean) || STATES_A_PASSWORD.test(clean) || ADDRESSES_THE_READER.test(clean) ? null : clean;
}

/** A mark that ends a sentence, of which one is taken off the end of every part of a joined note but its last. */
const SENTENCE_END = /[。．.！!？?；;]$/u;
/** Writing that joins with the full-width `；`: Chinese characters and kana. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Notes joined into one in their own words (a review's merge, memory/pipeline.ts): `texts` in the order given (oldest first), each
 * trimmed, a text that repeats an earlier one exactly (after trimming) once, one sentence-final mark (`。．.！!？?；;`) taken off the end of
 * every part but the last, joined by `；` when the notebook's language (`lang`, `accounts.memory_language`) is Chinese or Japanese and by
 * `; ` otherwise — with no language set (automatic), by `；` when the texts are written in Chinese characters or kana. Nothing is
 * reworded. Pure.
 */
export function joinNotes(texts: readonly string[], lang: string | null): string {
  const parts: string[] = [];
  for (const text of texts) {
    const trimmed = text.trim();
    if (trimmed !== "" && !parts.includes(trimmed)) parts.push(trimmed);
  }
  const cjk = lang === null ? CJK.test(parts.join("")) : lang === "ja" || lang.startsWith("zh");
  return parts.map((p, i) => (i < parts.length - 1 ? p.replace(SENTENCE_END, "") : p)).join(cjk ? "；" : "; ");
}

/**
 * A joined note as it may be stored: the owner's rules (it is made of notes already stored, so nothing in it is the model's) and no more
 * than `modelEntryMax` weight, the longest entry anything but the owner writes; null when it cannot be written so.
 */
export function joinedNote(text: string): string | null {
  const clean = tidy(text);
  return clean !== null && clean === text && weight(clean) <= modelEntryMaxNow ? clean : null;
}
