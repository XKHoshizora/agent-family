import type { Queryable, Tx } from "../db.ts";

/**
 * The one measure of tokens (README "Metering", "Token estimates"). Every estimate the service makes of what a text costs
 * in tokens — what a reply's context may hold, what a call is settled on when its upstream reports no usage, the size of
 * memory's rooms and of its notes passage — is `weight`: ceil(utf-8 bytes / 3). A Chinese,
 * Japanese or Korean character is 3 bytes and weighs 1, a Latin letter weighs a third: close to how tokenisers split text
 * (a fact is about 10 code points in Chinese and 30 to 40 in English, at about the same tokens), with no table of scripts.
 * It is the one place to change when a real tokenizer replaces it (and the web's mirror of memory's measure,
 * app/web/src/data/memoryWeight.js, with it). Images and PDFs are not text: they keep their own constants (prices.ts).
 *
 * What one model really counts for a weight is its own (its tokenizer, how it wraps a turn): its ratio (`readRatio`),
 * learned from the input tokens upstreams report for replies (`learnRatio`, table `token_ratios`, by model and never by
 * owner: `ratioKey`). A context is planned at that ratio when it is above 1 (`planRatio`), and keeps `CONTEXT_HEADROOM` of
 * its room free; a call settled with no usage reported is charged its estimate corrected by it (`correctedEstimate`).
 * What admission holds is not an estimate but a bound, and no ratio is in it (`holdTokens`).
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

/** The longest end of `text`, whole characters only, that weighs at most `max` ("" when `max` is 0 or less). */
export function lastToWeight(text: string, max: number): string {
  if (weight(text) <= max) return text;
  const characters = Array.from(text);
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const next = bytes + encoder.encode(characters[start - 1]!).length;
    if (Math.ceil(next / 3) > max) break;
    bytes = next;
    start--;
  }
  return characters.slice(start).join("");
}

/** Tokens `text` is estimated at: its weight in tokens (`TOKENS_PER_WEIGHT`) times `ratio` (its model's: `readRatio`), rounded up. */
export function estimateTokens(text: string, ratio = 1): number {
  return Math.ceil(weight(text) * TOKENS_PER_WEIGHT * ratio);
}

/** The most weight whose estimate at `ratio` (`estimateTokens`) is at most `tokens`; 0 when none is. */
export function weightWithin(tokens: number, ratio: number): number {
  const perWeight = TOKENS_PER_WEIGHT * ratio;
  let w = Math.max(0, Math.floor(tokens / perWeight));
  // Floating point may put the product of the quotient a hair above `tokens`.
  while (w > 0 && Math.ceil(w * perWeight) > tokens) w--;
  return w;
}

/**
 * A call's input estimate as its model is expected to count it: of `estimate` (tokens at ratio 1), the `fixed` part —
 * images and PDFs at their constants — as it is, and the rest, text in weight, times the model's `ratio`, rounded up.
 * What a call is settled on when its upstream reports no usage; never what it is held at (`holdTokens`).
 */
export function correctedEstimate(estimate: number, fixed: number, ratio: number): number {
  return Math.ceil((estimate - fixed) * ratio) + fixed;
}

/**
 * Tokens admission holds for the text of a call (`texts`: its system text and every text it sends): their utf-8 bytes —
 * no tokenizer counts more than one token a byte — but never more than its model's context leaves beside the call's
 * output limit, more than which no request carries. An upper bound on what the text can cost, whatever the model's
 * ratio; images and PDFs are held at their constants on top (prices.ts). The one place a hold's input is worked out.
 */
export function holdTokens(texts: readonly string[], contextTokens: number, maxOutputTokens: number): number {
  const bytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  return Math.max(0, Math.min(bytes, contextTokens - maxOutputTokens));
}

// --- planning a context -------------------------------------------------------------------------------------------------

/**
 * Of the room a model's context leaves for the conversation (its context less its output limit and the system text), the
 * part a plan keeps free: what an estimate may fall short by. Applied once, where that room is worked out
 * (agents/runtime/context.ts `contextBudget`).
 */
export const CONTEXT_HEADROOM = 0.1;

/**
 * The ratio a context is planned at: the model's learned ratio when it is above 1, else 1 — a model that counts more
 * than its weight is sent less, and one that counts less is never sent more than weight says.
 */
export const planRatio = (ratio: number): number => Math.max(1, ratio);

/**
 * Tokens a provider adds around the tool definitions a call sends (Anthropic's tool-use system text is a few hundred;
 * the others' framing is less), which no estimate of the definitions themselves sees. A reply offered tools has them
 * reserved in its context plan beside its definitions' estimate (agents/port-impl.ts `begin`), and every call of it that
 * sends tools is held for them beside the definitions' bytes (`begin`, agents/runtime/worker.ts).
 */
export const TOOL_PREAMBLE_TOKENS = 400;

// --- the learned ratio --------------------------------------------------------------------------------------------------

/** A ratio is used once it has learned from this many replies; until then it is 1. */
export const MIN_SAMPLES = 5;
/**
 * The least and the most a ratio is (and a sample is taken as). One owner's crafted text can bring a shared ratio no lower
 * than 0.8 — a fifth off what calls settled with no usage reported are charged, measured from ratio 1 (from a model's
 * honest 1.25 it is 36 %) — and no higher than 2, where every owner's context on that model is planned at half its
 * weight. Real ratios measured on filler and on ordinary text (0.61–1.03, 0.9–1.03) are within it or held over.
 */
export const MIN_RATIO = 0.8;
export const MAX_RATIO = 2;
/** How much one sample moves a ratio: new = old × (1 − this) + sample × this (a first sample moves it from 1). */
export const SAMPLE_WEIGHT = 0.1;
/** An estimate smaller than this teaches nothing: what wraps a turn (a few tokens) would be too much of it. */
export const MIN_LEARNED_ESTIMATE = 200;
/** How long learning waits, each time, for the ratio's row when another settlement holds it; past that, the sample is skipped. */
export const LEARN_LOCK_WAIT_MS = 100;

const clampRatio = (r: number): number => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
const isWhole = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** Where learning says that a sample was skipped; settlement passes its own. */
export interface RatioLog {
  warn(details: Record<string, unknown>, msg: string): void;
}

/** How every ratio key of the provider row `providerId` starts. */
const providerPrefix = (providerId: string): string => `provider:${providerId}:`;

/**
 * What a model's ratio is kept under: `site:<id>` for a site model, shared by every owner's calls of it;
 * `provider:<provider row id>:<model name>` for a model of an owner's provider — that provider row's own (its usage is
 * whatever the owner's endpoint reports, so it teaches no one else), and never the owner's id, a key or an address.
 * Throws for a provider model resolved without its row's id (`resolveModel` always gives it): a bug.
 */
export function ratioKey(resolved: { source: "site" | "provider"; name: string; providerId?: string }): string {
  if (resolved.source === "site") return `site:${resolved.name}`;
  if (resolved.providerId === undefined) throw new Error("ratioKey: a provider model was resolved without its provider's id");
  return `${providerPrefix(resolved.providerId)}${resolved.name}`;
}

/** Deletes every ratio of the provider row `providerId`, in the caller's transaction (the provider's deletion: providers/store.ts). */
export async function forgetProviderRatios(q: Queryable, providerId: string): Promise<void> {
  await q.query("delete from token_ratios where left(key, char_length($1)) = $1", [providerPrefix(providerId)]);
}

/**
 * Runs `fn` in a savepoint of `q`'s transaction, so that what fails in it is rolled back to there and the transaction
 * stays usable; rethrows.
 */
async function inSavepoint<T>(q: Tx, fn: () => Promise<T>): Promise<T> {
  await q.query("savepoint token_ratio");
  try {
    const out = await fn();
    await q.query("release savepoint token_ratio");
    return out;
  } catch (err) {
    await q.query("rollback to savepoint token_ratio");
    throw err;
  }
}

/**
 * The ratio of `key` (`ratioKey`), in `q`'s transaction: 1 when it is unknown or has learned from fewer than `MIN_SAMPLES`
 * replies, else as learned, held to [`MIN_RATIO`, `MAX_RATIO`]. Never throws: a read that fails is 1 (in a savepoint, so the
 * caller's transaction goes on). A plain read of one row: it waits on no lock.
 */
export async function readRatio(q: Tx, key: string): Promise<number> {
  try {
    const { rows } = await inSavepoint(q, () => q.query<{ ratio: number; samples: number }>("select ratio, samples from token_ratios where key = $1", [key]));
    const row = rows[0];
    if (!row || !(row.samples >= MIN_SAMPLES) || !Number.isFinite(row.ratio)) return 1;
    return clampRatio(row.ratio);
  } catch {
    return 1;
  }
}

/**
 * Learns, in `q`'s transaction (settlement's), from one reply whose input was estimated at `estimatedInput` (at ratio 1,
 * text only) and reported as `reportedInput` tokens: the sample `reported / estimated`, held to [`MIN_RATIO`, `MAX_RATIO`],
 * moves the ratio of `key` by `SAMPLE_WEIGHT` (from 1 when it has none), and counts one more sample. Nothing is learned from
 * an estimate that is not a whole number of at least `MIN_LEARNED_ESTIMATE` or a reported count that is not a whole number
 * above 0. Never throws and never holds a settlement up: it is done in a savepoint, waits at most `LEARN_LOCK_WAIT_MS` per
 * wait for the row (another settlement of the same model may hold it until it commits), and when anything fails the sample is
 * skipped, the transaction goes on, and `log` is told the database's error code — nothing of any text.
 */
export async function learnRatio(q: Tx, key: string, estimatedInput: number, reportedInput: number, log?: RatioLog): Promise<void> {
  if (!isWhole(estimatedInput) || estimatedInput < MIN_LEARNED_ESTIMATE) return;
  if (!isWhole(reportedInput) || reportedInput === 0) return;
  const sample = clampRatio(reportedInput / estimatedInput);
  try {
    await inSavepoint(q, async () => {
      const previous = await q.query<{ wait: string }>("select current_setting('lock_timeout') as wait");
      await q.query("select set_config('lock_timeout', $1, true)", [`${LEARN_LOCK_WAIT_MS}ms`]);
      await q.query(
        `insert into token_ratios as r (key, ratio, samples, updated_at)
         values ($1, least($4::float8, greatest($3::float8, (1 - $5::float8) + $5::float8 * $2::float8)), 1, now())
         on conflict (key) do update
           set ratio = least($4::float8, greatest($3::float8, r.ratio * (1 - $5::float8) + $5::float8 * $2::float8)),
               samples = r.samples + (r.samples < 2147483647)::int,
               updated_at = now()`,
        [key, sample, MIN_RATIO, MAX_RATIO, SAMPLE_WEIGHT],
      );
      // `set_config(…, true)` lasts to the end of the transaction once the savepoint is released: the caller's wait back.
      await q.query("select set_config('lock_timeout', $1, true)", [previous.rows[0]!.wait]);
    });
  } catch (err) {
    const code = typeof (err as { code?: unknown } | null)?.code === "string" ? (err as { code: string }).code : "unknown";
    try {
      log?.warn({ code }, "token ratio: a reply's sample could not be learned and was skipped");
    } catch {
      // A log that fails changes nothing here.
    }
  }
}
