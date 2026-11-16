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

/** A site model's price; a provider model has none and costs the site nothing. */
export type Price = NonNullable<Resolved["price"]>;

/** `input` and `output` tokens at `price`. */
export function costMicro(price: Price, input: number, output: number): bigint {
  return BigInt(input) * BigInt(price.inputMicroPerToken) + BigInt(output) * BigInt(price.outputMicroPerToken);
}

/**
 * The most one call can cost: the input estimate and the model's whole output limit, at its prices (0 for a
 * provider model). What admission holds against the owner's quota while the call runs.
 */
export function maxCostMicro(resolved: Pick<Resolved, "price" | "call">, inputTokensEstimate: number): bigint {
  return resolved.price ? costMicro(resolved.price, inputTokensEstimate, resolved.call.maxOutputTokens) : 0n;
}
