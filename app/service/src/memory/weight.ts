/**
 * The one measure of memory. Every limit in memory bounds two things: what a reply costs and how much of the model's context
 * the notes take; both are token quantities, and code points are not (one fact is about 10 code points in Chinese and 30 to
 * 40 in English, at about the same tokens). `weight(text) = ceil(utf-8 bytes / 3)`: a CJK character, a kana, a hangul
 * syllable is 3 bytes and weighs 1, a Latin letter weighs a third. It follows how tokenisers split text closely enough for a
 * limit and needs no table of scripts. It is the one place to change when a real tokenizer replaces it: callers use `weight`,
 * `weightOf` and `cutToWeight` and nothing else counts memory text.
 */

const encoder = new TextEncoder();

/** What `text` weighs: ceil(utf-8 bytes / 3); 0 for "" (whitespace has its byte weight: callers clean text first). */
export const weight = (text: string): number => Math.ceil(encoder.encode(text).length / 3);

/** What `notes` weigh together: each note's text rounded up on its own, so a room's `used` is the sum of its notes' weights. */
export const weightOf = (notes: ReadonlyArray<{ text: string }>): number => notes.reduce((sum, n) => sum + weight(n.text), 0);

/** One weight is one token of the model's context: the one conversion between this measure and a context budget. */
export const TOKENS_PER_WEIGHT = 1;

/** The longest start of `text`, whole characters only, that weighs at most `max`. */
export function cutToWeight(text: string, max: number): string {
  if (weight(text) <= max) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const next = bytes + encoder.encode(ch).length;
    if (Math.ceil(next / 3) > max) break;
    bytes = next;
    end += ch.length;
  }
  return text.slice(0, end);
}
