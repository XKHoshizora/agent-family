import type { Resolved } from "../models/resolve.ts";

/**
 * Cost maths of site models. Money is `bigint` micro-points; a price is micro-points per token. Estimates are
 * deliberately high: the most a call can cost is held against the owner's quota while it runs (admit.ts).
 */

/** Tokens counted for one image shown to a model. */
export const IMAGE_TOKENS = 1500;
/** Tokens counted per kilobyte (1 000 bytes) of a PDF shown to a model. */
export const PDF_TOKENS_PER_KB = 300;

/**
 * Tokens of `text` when nobody counted them: one per Unicode code point. High for Latin text (a token is usually
 * several letters), about right for Chinese: conservative on purpose.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** Tokens counted for a PDF of `bytes` bytes shown to a model: `PDF_TOKENS_PER_KB` per 1 000 bytes, rounded up. */
export function pdfTokens(bytes: number): number {
  return Math.ceil((bytes * PDF_TOKENS_PER_KB) / 1000);
}

/** A whole number of 0 or more that a JS number holds exactly: what every token or character count is. */
export const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** Throws, naming `what`, unless `n` is a count (`isCount`): a count we computed ourselves that is not one is a bug. */
export function assertCount(what: string, n: number): void {
  if (!isCount(n)) throw new Error(`${what} must be a whole number of 0 or more, not ${n}`);
}

/** A site model's price; a provider model has none and costs the site nothing. */
export type Price = NonNullable<Resolved["price"]>;

/** `input` and `output` tokens at `price`. */
export function costMicro(price: Price, input: number, output: number): bigint {
  return BigInt(input) * BigInt(price.inputMicroPerToken) + BigInt(output) * BigInt(price.outputMicroPerToken);
}

/**
 * The most one call can cost: the input estimate and the call's whole output limit — `resolved.call.maxOutputTokens`,
 * the number the gateway sends, thinking allowance included (src/models/resolve.ts `outputLimit`) — at its prices (0
 * for a provider model). What admission holds against the owner's quota while the call runs. The estimate must be a
 * count (`assertCount`), whatever the model.
 */
export function maxCostMicro(resolved: Pick<Resolved, "price" | "call">, inputTokensEstimate: number): bigint {
  assertCount("the input token estimate", inputTokensEstimate);
  return resolved.price ? costMicro(resolved.price, inputTokensEstimate, resolved.call.maxOutputTokens) : 0n;
}
