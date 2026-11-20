/**
 * The one measure of memory. Every limit in memory bounds two things: what a reply costs and how much of the model's context
 * the notes take; both are token quantities, and code points are not (one fact is about 10 code points in Chinese and 30 to
 * 40 in English, at about the same tokens). `weight(text) = ceil(utf-8 bytes / 3)`: a CJK character, a kana, a hangul
 * syllable is 3 bytes and weighs 1, a Latin letter weighs a third. It is the service's one measure of tokens, and lives in
 * metering/tokens.ts (where every other estimate is made too); memory keeps its names here: callers in memory use `weight`,
 * `weightOf` and `cutToWeight` and nothing else counts memory text.
 */

export { cutToWeight, TOKENS_PER_WEIGHT, weight, weightOf } from "../metering/tokens.ts";
