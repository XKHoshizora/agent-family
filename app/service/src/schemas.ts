import { z } from "zod";

/** A UUID in canonical (lower-case) form: Postgres returns lower-case, so everything compared in JS must be too. */
export const uuidParam = z.uuid().transform((s) => s.toLowerCase());

/**
 * A decimal integer in [1, max] given as a string (path or query): no sign, leading zero, fraction,
 * exponent or whitespace, and never beyond Number.MAX_SAFE_INTEGER.
 */
export const positiveIntString = (max: number = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

/** The same bounds for a JSON number. */
export const positiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Counts Unicode code points, so an emoji is one character. */
export function characters(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Trimmed user text of `min`–`max` characters. Lone surrogates and NUL are always refused (Postgres jsonb
 * cannot store them); `singleLine` text also refuses every other control character, line breaks included.
 */
export function userText(min: number, max: number, { singleLine = false }: { singleLine?: boolean } = {}) {
  return z
    .string()
    .trim()
    .refine((s) => !LONE_SURROGATE.test(s), "lone surrogate")
    .refine((s) => (singleLine ? !/\p{Cc}/u.test(s) : !s.includes("\u0000")), "control character")
    .refine((s) => {
      const n = characters(s);
      return n >= min && n <= max;
    }, `must be ${min}-${max} characters`);
}

/**
 * Format characters (`\p{Cf}`: bidi overrides and isolates, zero-width spaces, the BOM, the soft hyphen…)
 * except the ones that carry meaning: the zero-width non-joiner and joiner (U+200C, U+200D: emoji sequences
 * such as 👩‍💻, Persian and Indic text) and the emoji tag characters (U+E0020–U+E007F: subdivision flags).
 */
const STRIPPED_FORMAT_CHARS = /(?![\u200C\u200D\u{E0020}-\u{E007F}])\p{Cf}/gu;

/** Something visible: anything but joiners and tag characters, which only modify what is next to them. */
const HAS_BASE_CHARACTER = /[^\u200C\u200D\u{E0020}-\u{E007F}]/u;

/**
 * A name others see: format characters removed except U+200C, U+200D and the tag characters (the rest could
 * reorder or hide what others see), then trimmed; 1–`max` characters (code points), not made of joiners alone;
 * one line — no control characters, no line or paragraph separators; no lone surrogates.
 */
function visibleName(max: number) {
  return z
    .string()
    .transform((s) => s.replace(STRIPPED_FORMAT_CHARS, ""))
    .pipe(
      userText(1, max, { singleLine: true })
        .refine((s) => !/[\p{Zl}\p{Zp}]/u.test(s), "one line")
        .refine((s) => HAS_BASE_CHARACTER.test(s), "nothing but joiners"),
    );
}

/** A person's display name, on registration and `PATCH /api/me` alike: `visibleName`, 1–40. */
export const displayName = visibleName(40);

/** A group's title, on creation and renaming: the display-name rule (`visibleName`), 1–60. */
export const groupTitle = visibleName(60);

/**
 * Bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069): in a message they reorder what others see
 * ("safe\u202Eelif.exe" shows as "safeexe.file"), so they are removed. They have no use in plain chat text.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Message text or a caption: stored as sent except that bidi overrides and isolates are removed, then
 * `userText(min, max)` (trimmed; line breaks allowed; no NUL or lone surrogates; length counted after removal).
 */
export function messageText(min: number, max: number) {
  return z
    .string()
    .transform((s) => s.replace(BIDI_CONTROLS, ""))
    .pipe(userText(min, max));
}

/** A search term: what `messageText` would store of it (so it matches stored text), one line, 1–100 characters. */
export const searchTerm = z
  .string()
  .transform((s) => s.replace(BIDI_CONTROLS, ""))
  .pipe(userText(1, 100, { singleLine: true }));

/** Whether text shows anything: a character that is neither white space nor a format character (`\p{Cf}`). */
export function hasVisibleText(s: string): boolean {
  return /[^\s\p{Cf}]/u.test(s);
}
