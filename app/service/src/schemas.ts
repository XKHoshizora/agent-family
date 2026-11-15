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

/** Format characters: bidi overrides and isolates, zero-width spaces and joiners, the BOM… (as in file names). */
const FORMAT_CHARS = /\p{Cf}/gu;

/**
 * A person's display name, on registration and `PATCH /api/me` alike: format characters removed (they could
 * reorder or hide what others see), then trimmed; 1–40 characters (code points); one line — no control
 * characters, no line or paragraph separators; no lone surrogates.
 */
export const displayName = z
  .string()
  .transform((s) => s.replace(FORMAT_CHARS, ""))
  .pipe(userText(1, 40, { singleLine: true }).refine((s) => !/[\p{Zl}\p{Zp}]/u.test(s), "one line"));
