import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { normaliseBaseUrl } from "./providers/guard.ts";

/** Which X-Forwarded-For hops Fastify trusts: none, or those that come from these addresses / ranges. */
export type TrustProxy = false | string[];

/** An address, or an address with a prefix length in range for its family (`10.0.0.0/8`, `fd00::/8`). */
function isAddressOrRange(entry: string): boolean {
  const [address = "", prefix, ...rest] = entry.split("/");
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^(0|[1-9][0-9]{0,2})$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * `TRUST_PROXY`: unset, empty, `false` or `0` trust nothing; otherwise a comma-separated list of the proxies'
 * addresses / CIDR ranges, so X-Forwarded-For is only read when the connection comes from one of them (Fastify
 * then takes the right-most entry not from a listed proxy). Refused, with a message saying why: a bare `true`
 * (Fastify would take the left-most X-Forwarded-For entry, which the client writes) and a hop count (it cannot
 * tell the proxy from a client that connects directly; Fastify 5 ignores it and trusts nothing).
 */
function parseTrustProxy(raw: string | undefined): TrustProxy | string {
  if (raw === undefined || raw === "false" || raw === "0") return false;
  const instead =
    "set CLIENT_IP_HEADER to the header your proxy sets (e.g. x-real-ip), or TRUST_PROXY to the proxies' addresses/CIDRs";
  if (raw === "true") return `TRUST_PROXY=true would trust a client-supplied X-Forwarded-For and is not accepted; ${instead}`;
  if (/^[0-9]+$/.test(raw)) return `TRUST_PROXY=${raw}: a hop count cannot tell the proxy from a direct client and is not accepted; ${instead}`;
  const entries = raw.split(",").map((s) => s.trim());
  const bad = entries.filter((e) => !isAddressOrRange(e));
  if (bad.length > 0) {
    return `TRUST_PROXY must be a comma-separated list of addresses/CIDRs (not ${JSON.stringify(bad.join(","))})`;
  }
  return entries;
}

export const PROTOCOLS = ["openai_chat", "openai_responses", "anthropic", "gemini"] as const;
export type Protocol = (typeof PROTOCOLS)[number];
export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
/** How readily an Agent answers unprompted (`agents.proactive_level`; the keys of `ProactiveConfig.base`). */
export const PROACTIVE_LEVELS = ["less", "normal", "more"] as const;
export type ProactiveLevel = (typeof PROACTIVE_LEVELS)[number];
/** The levels that think: every level but `none`. */
export type ThinkingLevel = Exclude<ReasoningLevel, "none">;
/**
 * Tokens of thinking a call at each level may use on top of its reply's own output limit (`REASONING_ALLOWANCE_TOKENS`;
 * how the sum is bounded: `outputLimit` in src/models/resolve.ts).
 */
export type ReasoningAllowance = Readonly<Record<ThinkingLevel, number>>;
export const DEFAULT_REASONING_ALLOWANCE: ReasoningAllowance = { low: 2000, medium: 6000, high: 12000, xhigh: 24000, max: 48000 };

/** The service's own secrets: a site model's `apiKeyEnv` may not name one (its value would be sent upstream as a key). */
export const SERVICE_SECRET_VARIABLES = ["DATABASE_URL", "AUTH_SECRET", "PROVIDER_KEY_SECRET", "S3_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID"] as const;

/** A model the site itself offers. `apiKeyEnv` names the environment variable holding the upstream key. */
export interface SiteModel {
  id: string;
  label: string;
  tier: "free" | "paid";
  protocol: Protocol;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  /** Micro-points per token. */
  inputMicroPerToken: number;
  outputMicroPerToken: number;
  maxOutputTokens: number;
  contextTokens: number;
  vision: boolean;
  pdf: boolean;
  reasoning: ReasoningLevel[];
  /**
   * Chat Completions only: the upstream thinks unless told not to, and takes the common switch for it (`thinking:
   * {type: "enabled" | "disabled"}`, src/models/gateway.ts). Absent: false, nothing of it is sent.
   */
  thinkingSwitch?: boolean;
}

/** What names the environment variable holding an upstream's key (`apiKeyEnv`). */
const keyVariable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const siteModelSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  tier: z.enum(["free", "paid"]),
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.url(),
  apiKeyEnv: keyVariable,
  model: z.string().min(1),
  inputMicroPerToken: z.number().int().min(0),
  outputMicroPerToken: z.number().int().min(0),
  maxOutputTokens: z.number().int().positive(),
  contextTokens: z.number().int().positive(),
  vision: z.boolean(),
  pdf: z.boolean(),
  reasoning: z.array(z.enum(REASONING_LEVELS)),
  thinkingSwitch: z.boolean().optional(),
});

/** The judgement model's configuration (`JUDGE`): where to ask, with which keys, and how long and how often. */
export interface JudgeConfig {
  model: string;
  /** One or two channels, tried in order; each `apiKeyEnv` names ANOTHER variable that holds its key. */
  channels: { url: string; apiKeyEnv: string }[];
  timeoutMs: number;
  /** Judgements the site makes a day, at most (counted by the proactive worker). */
  dailyLimit: number;
}

const judgeSchema = z.strictObject({
  model: z.string().min(1).max(200),
  channels: z
    .array(
      z.strictObject({
        url: z.url(),
        apiKeyEnv: keyVariable,
      }),
    )
    .min(1)
    .max(2),
  timeoutMs: z.number().int().min(500).max(30_000).default(4000),
  dailyLimit: z.number().int().min(1).max(10_000_000).default(20_000),
});

/** What the proactive replies are tuned by (`PROACTIVE`); every number is a site setting with this default. */
export interface ProactiveConfig {
  debounceMs: number;
  transcriptMessages: number;
  transcriptChars: number;
  base: { less: number; normal: number; more: number };
  surchargeStep: number;
  surchargeMax: number;
  surchargeHalfLifeS: number;
  surchargeHalfMessages: number;
  quietBig: { at: number; raise: number; halfLifeS: number };
  quietSmall: { at: number; raise: number; halfLifeS: number };
  cap: number;
  fuse: { perSeconds: number; perHour: number };
  /** Judgements asked for within an hour, at most, about one group and about the messages of one sender (scheduler.ts). */
  perGroupHour: number;
  perSenderHour: number;
}

const probability = (fallback: number) => z.number().min(0).max(1).default(fallback);
const positive = (fallback: number, max: number) => z.number().int().min(1).max(max).default(fallback);
/** An object whose every field is defaulted: nothing (or `{}`) gives all the defaults, a partial one keeps the rest. */
const defaulted = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape).prefault({} as never);

// The defaults are those calibrated on the real judgement model (batch 2D): the right Agent's pick probability was at
// least 0.74 where a reply was expected, the top Agent's at most 0.70 where none was.
const proactiveSchema = z.strictObject({
  debounceMs: positive(3000, 60_000),
  transcriptMessages: positive(15, 100),
  transcriptChars: positive(300, 5000),
  base: defaulted({ less: probability(0.8), normal: probability(0.65), more: probability(0.5) }),
  surchargeStep: probability(0.1),
  surchargeMax: probability(0.25),
  surchargeHalfLifeS: positive(120, 86_400),
  surchargeHalfMessages: positive(4, 1000),
  quietBig: defaulted({ at: probability(0.8), raise: probability(0.33), halfLifeS: positive(3600, 604_800) }),
  quietSmall: defaulted({ at: probability(0.3), raise: probability(0.15), halfLifeS: positive(600, 604_800) }),
  cap: probability(0.98),
  fuse: defaulted({ perSeconds: positive(10, 3600), perHour: positive(30, 100_000) }),
  perGroupHour: positive(600, 100_000),
  perSenderHour: positive(300, 100_000),
});

/**
 * What an Agent's memory is tuned by (`MEMORY`); every number is a site setting with this default (the plan's Numbers;
 * tuned and recorded in the last tasks). Sizes are in weight (memory/weight.ts: ceil(utf-8 bytes / 3), about a token), times in milliseconds.
 */
export interface MemoryConfig {
  /** The id of the site model the background memory calls use; null: the cheapest free-tier site model (`memoryModel`). */
  model: string | null;
  /** The most the notes of a room hold: about the owner, the Agent's own, and what it heard. */
  roomOwner: number;
  roomSelf: number;
  roomHearsay: number;
  /** The longest an entry a model wrote is (an entry the owner wrote may fill its room). */
  modelEntryMax: number;
  /** A review runs after this much quiet in the Agent's own conversation, or after `maxReplies` replies since the last. */
  quietMs: number;
  maxReplies: number;
  /** A group review runs after this much quiet, at most `groupMaxWaitMs` after the first flagged message. */
  groupQuietMs: number;
  groupMaxWaitMs: number;
  /** A review shows at most this many messages, each cut to `reviewMessageWeight`, and may answer at most `reviewMaxOutputTokens`. */
  reviewMessages: number;
  reviewMessageWeight: number;
  reviewMaxOutputTokens: number;
  /** Thresholds of the judgements: out of the vault, the same note, hearsay worth flagging, the owner's own remark worth flagging. */
  shareAt: number;
  sameAt: number;
  hearsayAt: number;
  ownAt: number;
  /** At most this many flagged messages are reviewed together, each with `flaggedContext` messages of context. */
  flaggedMax: number;
  flaggedContext: number;
  /** At most this many hearsay calls (the owner's points) per Agent and group in a rolling hour. */
  hearsayPerHour: number;
  /**
   * Before a hearsay call the judgement model is asked whether the batch holds something new (below `hearsayNewAt`: no
   * call) and whether it looks like flooding or probing (`hearsayAbuseAt` or more: no call, and the speaker is not
   * listened to for `hearsayMuteMs`).
   */
  hearsayNewAt: number;
  hearsayAbuseAt: number;
  hearsayMuteMs: number;
  /**
   * What a flooding judgement does: "on" mutes a speaker who sent at least 3 of the batch's flagged messages and more than
   * half of them (and drops the batch as abuse); "observe" (default) mutes nobody and drops nothing, and logs when it would
   * have (`memory_mute_would`); "off" does not ask the abuse question at all.
   */
  hearsayMute: "off" | "observe" | "on";
  /**
   * Listening for memory (a judgement with no Agent to pick, only listeners) is skipped once the day's judgements have
   * reached this share of the judge's daily limit, so that it never uses up what unasked replies need.
   */
  listenShare: number;
  /**
   * 入梦: the sweep that looks for owners to consolidate comes every `dreamSweepMs`. An owner dreams after they have sent no
   * message anywhere for `dreamIdleMs`, with something new since their last dream, and not twice within `dreamEveryMs`.
   * A room left at `napAt` of its limit by a change is consolidated at once (a nap), at most once per `dreamEveryMs`.
   * A merge, a rewrite or a split of entries is applied when the judgement model is `faithfulAt` sure the result adds nothing the
   * entries did not say and loses nothing they did.
   */
  dreamSweepMs: number;
  dreamIdleMs: number;
  dreamEveryMs: number;
  napAt: number;
  faithfulAt: number;
  /**
   * The site's judgement model is asked at most this many times a site day on behalf of one owner's memory (sorting, the duplicate
   * test, the faithful check, the hearsay pre-check): past it that owner's memory checks are skipped as "no answer", so one heavy
   * owner can never use up what everyone else's checks need. The site's own daily limit stays as the last fuse.
   */
  judgePerOwnerDay: number;
  /** A room holds at most this many notes besides its size limit: an addition beyond it is dropped as a full room. */
  roomNotes: number;
  /**
   * The notes passage takes at most this share of the model's context (by the token estimate the context budget uses); over it
   * entries are left out (hearsay first, then the Agent's own notes, then those about the owner, the weakest and oldest first), so the
   * notes never crowd out the conversation.
   */
  passageShare: number;
  /**
   * What the site pays for one owner's memory calls on a site model each site day, in whole points (0: none, memory then works only
   * for owners who chose a model of their own provider). Its own allowance: never the owner's free allowance or balance.
   */
  freeDailyPoints: number;
}

/** `reviewMessageChars` was this setting's name before sizes were measured in weight: still read, when the new name is absent. */
const renamedReviewWeight = (v: unknown): unknown => {
  if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.hasOwn(v, "reviewMessageChars")) return v;
  const { reviewMessageChars, ...rest } = v as Record<string, unknown>;
  return Object.hasOwn(rest, "reviewMessageWeight") ? rest : { ...rest, reviewMessageWeight: reviewMessageChars };
};

const memorySchema = z.preprocess(renamedReviewWeight, z.strictObject({
  model: z.string().min(1).max(200).nullable().default(null),
  roomOwner: positive(2000, 100_000),
  roomSelf: positive(3000, 100_000),
  roomHearsay: positive(2000, 100_000),
  modelEntryMax: positive(200, 10_000),
  quietMs: positive(600_000, 86_400_000),
  maxReplies: positive(8, 1000),
  groupQuietMs: positive(120_000, 86_400_000),
  groupMaxWaitMs: positive(900_000, 86_400_000),
  reviewMessages: positive(40, 500),
  reviewMessageWeight: positive(500, 20_000),
  reviewMaxOutputTokens: positive(800, 100_000),
  shareAt: probability(0.6),
  sameAt: probability(0.8),
  hearsayAt: probability(0.65),
  ownAt: probability(0.6),
  flaggedMax: positive(20, 500),
  flaggedContext: z.number().int().min(0).max(50).default(3),
  hearsayPerHour: positive(4, 1000),
  hearsayNewAt: probability(0.7),
  hearsayAbuseAt: probability(0.6),
  hearsayMuteMs: positive(21_600_000, 31_536_000_000),
  hearsayMute: z.enum(["off", "observe", "on"]).default("observe"),
  listenShare: probability(0.5),
  dreamSweepMs: positive(900_000, 86_400_000),
  dreamIdleMs: positive(10_800_000, 604_800_000),
  dreamEveryMs: positive(72_000_000, 2_592_000_000),
  napAt: probability(0.8),
  faithfulAt: probability(0.6),
  judgePerOwnerDay: positive(300, 1_000_000),
  roomNotes: positive(150, 100_000),
  passageShare: z.number().gt(0).max(1).default(0.25),
  freeDailyPoints: z.number().int().min(0).max(1_000_000).default(20),
}));

const allowanceTokens = z.number().int().min(0).max(200_000);
/** `REASONING_ALLOWANCE_TOKENS`: an object of levels (`low`..`max`), each 0–200 000; a level left out keeps its default. */
const reasoningAllowanceSchema = z
  .strictObject({
    low: allowanceTokens.optional(),
    medium: allowanceTokens.optional(),
    high: allowanceTokens.optional(),
    xhigh: allowanceTokens.optional(),
    max: allowanceTokens.optional(),
  })
  .transform(
    (v): ReasoningAllowance => ({
      low: v.low ?? DEFAULT_REASONING_ALLOWANCE.low,
      medium: v.medium ?? DEFAULT_REASONING_ALLOWANCE.medium,
      high: v.high ?? DEFAULT_REASONING_ALLOWANCE.high,
      xhigh: v.xhigh ?? DEFAULT_REASONING_ALLOWANCE.xhigh,
      max: v.max ?? DEFAULT_REASONING_ALLOWANCE.max,
    }),
  );

/**
 * The variable `apiKeyEnv` that `what` (a site model, a judgement channel) reads its upstream key from: it is sent
 * upstream as a key, so never one of the service's own secrets (compared ignoring case, as Windows does for variable
 * names); and it must be set. Start-up refuses otherwise, naming `what` and the variable.
 */
function checkKeyVariable(what: string, apiKeyEnv: string, env: Record<string, string | undefined>): void {
  if ((SERVICE_SECRET_VARIABLES as readonly string[]).includes(apiKeyEnv.toUpperCase())) {
    throw new Error(`Invalid configuration: ${what} names ${apiKeyEnv} as its apiKeyEnv, one of the service's own variables; put its key in a variable of its own`);
  }
  const key = env[apiKeyEnv];
  if (key === undefined || key === "") throw new Error(`Invalid configuration: ${what} needs the environment variable ${apiKeyEnv} (its apiKeyEnv), which is not set`);
}

/** Parses a JSON-valued variable; on failure adds one issue (the variable's name comes from the schema key). */
function jsonVariable<T extends z.ZodType>(schema: T, fallback: z.output<T>) {
  return optionalString.transform((v, ctx): z.output<T> => {
    if (v === undefined) return fallback;
    let json: unknown;
    try {
      json = JSON.parse(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be valid JSON" });
      return z.NEVER;
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      ctx.addIssue({ code: "custom", message: result.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join(", ") });
      return z.NEVER;
    }
    return result.data;
  });
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : v));

/** A whole number from `min` to `max` written in decimal digits; unset or empty: `fallback`. */
const wholeNumber = (fallback: number, min: number, max: number) => {
  const message = `must be a whole number from ${min} to ${max}`;
  return optionalString
    .transform((v) => (v === undefined ? String(fallback) : v))
    .pipe(z.string().regex(/^[0-9]{1,10}$/, message))
    .transform(Number)
    .pipe(z.number().min(min, message).max(max, message));
};

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.url(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  /** Encrypts providers' API keys at rest. Required: the service does not start without it. */
  PROVIDER_KEY_SECRET: z.string().min(32, "PROVIDER_KEY_SECRET must be at least 32 characters"),
  /** JSON array of the models the site offers (see SiteModel); default none. */
  SITE_MODELS: jsonVariable(z.array(siteModelSchema), []),
  /** The free daily allowance of site-model use, in whole points. */
  FREE_DAILY_POINTS: optionalString
    .transform((v) => (v === undefined ? "200" : v))
    .pipe(z.string().regex(/^[0-9]{1,12}$/, "FREE_DAILY_POINTS must be a whole number of points (0 or more)"))
    .transform((v) => BigInt(v) * 1_000_000n),
  /** The time zone whose midnight starts a new free-allowance day. */
  SITE_TIMEZONE: optionalString
    .transform((v) => (v === undefined ? "Asia/Shanghai" : v))
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "SITE_TIMEZONE must be an IANA time zone name such as Asia/Shanghai"),
  /** JSON object: how many Agents each account tier may own. Must contain `free`. */
  AGENT_TIERS: jsonVariable(
    z.record(z.string().min(1), z.number().int().min(0)).refine((t) => Object.hasOwn(t, "free"), "must contain a \"free\" tier"),
    { free: 20 } as Record<string, number>,
  ),
  /** Replies one owner may have running at once; further ones wait queued. */
  AGENT_MAX_CONCURRENT_RUNS: wholeNumber(4, 1, 100),
  /** Of those, how many may be ones someone else called for (every lane but `own`); the rest of the places are the owner's own. */
  AGENT_MAX_CONCURRENT_OTHERS_RUNS: wholeNumber(3, 1, 100),
  /** Replies one owner may start per minute that they called for themselves (counted from the stored runs; not scaled by RATE_LIMIT_SCALE). */
  AGENT_RUNS_PER_MINUTE: wholeNumber(20, 1, 10_000),
  /** Replies one owner's Agents may start per minute that someone else called for, all of them together (counted apart from the owner's own). */
  AGENT_OTHERS_RUNS_PER_MINUTE: wholeNumber(20, 1, 10_000),
  /** Replies one person, themselves or through their Agents, may call for per minute on other people's Agents. */
  AGENT_CALLER_RUNS_PER_MINUTE: wholeNumber(5, 1, 10_000),
  /** A reply still running after this long is ended (and so is the reading of its attachments). */
  AGENT_RUN_TIMEOUT_MS: wholeNumber(120_000, 1_000, 3_600_000),
  /** A provider model's context window when its owner does not give one, in tokens. */
  PROVIDER_DEFAULT_CONTEXT_TOKENS: wholeNumber(16_000, 1_000, 2_000_000),
  /** The output limit every call to a provider model gets, in tokens. */
  PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS: wholeNumber(2048, 1, 1_000_000),
  /** JSON object: the thinking allowance of each level, added to a call's output limit at that level. */
  REASONING_ALLOWANCE_TOKENS: jsonVariable(reasoningAllowanceSchema, DEFAULT_REASONING_ALLOWANCE),
  /** Calls to providers and site models in flight at once in the whole service (src/providers/guard.ts). */
  PROVIDER_MAX_CONCURRENT_CALLS: wholeNumber(64, 1, 1000),
  /** Replies the worker runs at once in the whole service (each holds its attachments in memory and an outbound call). */
  AGENT_MAX_RUNS_IN_FLIGHT: wholeNumber(16, 1, 64),
  /** After this many messages in a row from Agents in a group (notices aside), an Agent's message calls no other Agent. */
  AGENT_CHAIN_LIMIT: wholeNumber(30, 2, 500),
  /** Tokens of a group's history one reply there may show its model at most (the system text comes on top). */
  AGENT_GROUP_CONTEXT_TOKENS: wholeNumber(12_000, 2_000, 200_000),
  /** JSON object configuring the judgement model (see JudgeConfig); unset or empty: none, and no Agent replies unprompted. */
  JUDGE: jsonVariable(judgeSchema.nullable(), null),
  /** JSON object of the proactive-reply tunings (see ProactiveConfig); every field optional, unset or empty: all defaults. */
  PROACTIVE: jsonVariable(proactiveSchema, proactiveSchema.parse({})),
  /** JSON object of an Agent's memory tunings (see MemoryConfig); every field optional, unset or empty: all defaults. */
  MEMORY: jsonVariable(memorySchema, memorySchema.parse({})),
  BLOB_DIR: z.string().min(1).default("./data/blobs"),
  /** Directory with the built web client (index.html and /assets); unset: the service serves no web files. */
  WEB_DIST: optionalString,
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** The address the server binds: an IPv4/IPv6 address or `localhost`. Default `0.0.0.0` (every interface). */
  HOST: optionalString
    .transform((v) => (v === undefined ? "0.0.0.0" : v))
    .pipe(z.string().refine((v) => isIP(v) !== 0 || v === "localhost", "HOST must be an IP address or localhost")),
  S3_ENDPOINT: optionalString,
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  REGISTRATION_MODE: z.enum(["invite", "open"]).default("invite"),
  /** Only `outbox` exists in this plan; real delivery is added later. */
  MAIL_MODE: z.enum(["outbox"]).default("outbox"),
  /** A header your proxy sets to the client's address, replacing any client value (Railway: `x-real-ip`). */
  CLIENT_IP_HEADER: optionalString.pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "CLIENT_IP_HEADER must be a header name")
      .transform((v) => v.toLowerCase())
      .optional(),
  ),
  /** The proxies whose X-Forwarded-For is read: their addresses / CIDR ranges. Default: none. */
  TRUST_PROXY: optionalString.transform((v, ctx) => {
    const parsed = parseTrustProxy(v);
    if (typeof parsed === "string") {
      ctx.addIssue({ code: "custom", message: parsed });
      return z.NEVER;
    }
    return parsed;
  }),
  /** Multiplier applied to every rate limit; tests raise it. */
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  /** Largest file one upload may carry, in bytes (1 MiB to 5 GiB; never more than the quota: checked below). */
  ATTACHMENT_MAX_BYTES: wholeNumber(1024 ** 3, 1024 ** 2, 5 * 1024 ** 3),
  /** Total attachment bytes one principal may store (sent or not). */
  ATTACHMENT_QUOTA_BYTES: z.coerce.number().int().positive().default(20 * 1024 ** 3),
  /** An upload whose client sends no body bytes for this long is cut off. */
  UPLOAD_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /** An upload still receiving its body after this long is cut off. */
  UPLOAD_TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(60 * 60_000),
  /** Server-wide: a connection with no traffic for this long is closed (WebSockets are exempt). */
  HTTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Server-wide backstop for receiving a whole request; default: the upload deadline plus a minute. */
  HTTP_REQUEST_TIMEOUT_MS: optionalString.transform((v) => (v === undefined ? undefined : Number(v))).pipe(
    z.number().int().positive().optional(),
  ),
  /** Server-wide: an idle kept-alive connection is closed after this long. */
  HTTP_KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(72_000),
  /** A request must have arrived whole this long after its head, else its connection is closed (uploads let in excepted). */
  HTTP_BODY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Postgres cancels any statement on the app's pool that runs longer than this (503 busy). */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** A request that gets no pool connection within this long is answered 503 busy. */
  DB_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** How often the server sweeps unsent uploads and abandoned blobs, in minutes; 0 turns it off; at most 1440 (a longer delay overflows Node's timers). */
  SWEEP_INTERVAL_MINUTES: optionalString
    .transform((v) => (v === undefined ? "15" : v))
    .pipe(z.string().regex(/^[0-9]{1,4}$/, "SWEEP_INTERVAL_MINUTES must be a whole number of minutes from 0 to 1440"))
    .transform(Number)
    .pipe(z.number().max(1440, "SWEEP_INTERVAL_MINUTES must be at most 1440 (one day)")),
  /** A search's statements are cancelled after this long (503 busy). */
  SEARCH_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
});

export interface Config {
  databaseUrl: string;
  appOrigin: string;
  authSecret: string;
  /** Encrypts providers' API keys at rest (src/providers/crypto.ts only). */
  providerKeySecret: string;
  /** The models the site offers. Their upstream keys are read from the variables named by `apiKeyEnv`. */
  siteModels: SiteModel[];
  /** Free daily allowance of site-model use, in micro-points. */
  freeDailyMicro: bigint;
  /** IANA name of the time zone whose midnight ends a free-allowance day. */
  siteTimezone: string;
  /** Agents an account may own, by tier; always has `free`. */
  agentTiers: Record<string, number>;
  /** Replies one owner may have running at once; further ones wait queued. */
  agentMaxConcurrentRuns: number;
  /** Of those, how many may be replies anyone else called for (every lane but `own`; src/agents/port-impl.ts `claimNext`). */
  agentMaxConcurrentOthersRuns: number;
  /** Replies one owner may start per minute in their own lane: those they called for themselves (src/agents/runs.ts `Lane`). */
  agentRunsPerMinute: number;
  /** Replies one owner's Agents may start per minute that anyone else called for (every lane but `own`), counted together. */
  agentOthersRunsPerMinute: number;
  /**
   * Replies one person may call for per minute on other people's Agents, themselves or through an Agent's message they are
   * behind (src/agents/runs.ts `behindAgentMessage`).
   */
  agentCallerRunsPerMinute: number;
  /** A reply still running after this long is ended; also the most the reading of its attachments may take. */
  agentRunTimeoutMs: number;
  /** For a provider model that does not say: its context window and its maximum output, in tokens. */
  providerDefaultContextTokens: number;
  providerDefaultMaxOutputTokens: number;
  /**
   * Tokens of thinking a call at each level but `none` may use on top of its reply's output limit; what the call is
   * sent and held for (src/models/resolve.ts `outputLimit`).
   */
  reasoningAllowanceTokens: ReasoningAllowance;
  /** Calls through the address guard (to providers and site models) in flight at once in the whole service. */
  providerMaxConcurrentCalls: number;
  /** Replies the worker runs at once in the whole service (src/agents/runtime/worker.ts). */
  agentMaxRunsInFlight: number;
  /**
   * When the group's last this many messages that are not notices were all sent by Agents, an Agent's message calls no
   * other Agent until a person writes (src/agents/runs.ts `triggerFromAgent`).
   */
  agentChainLimit: number;
  /**
   * The most a reply in a group may show its model of the group's history, in tokens by the service's estimate, when
   * the model's context would hold more (src/agents/context.ts `loadContext`); the system text is not counted in it.
   */
  agentGroupContextTokens: number;
  /** The judgement model that decides whether an Agent replies unprompted; null: not configured, nobody does. */
  judge: JudgeConfig | null;
  /** The proactive replies' tunings. */
  proactive: ProactiveConfig;
  /** The memory tunings. */
  memory: MemoryConfig;
  blobDir: string;
  /** Absolute path of the built web client to serve, or undefined to serve none. */
  webDist: string | undefined;
  port: number;
  /** The address `server.ts` listens on. */
  host: string;
  s3?: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  registrationMode: "invite" | "open";
  mailMode: "outbox";
  rateLimitScale: number;
  /** Lower-case header name holding the client's address (src/limits.ts `clientIp`); unset: not consulted. */
  clientIpHeader: string | undefined;
  /** Fastify's `trustProxy`: which X-Forwarded-For hops `req.ip` may look through. */
  trustProxy: TrustProxy;
  /** Largest file one upload may carry (inclusive). */
  attachmentMaxBytes: number;
  attachmentQuotaBytes: number;
  /** Per-upload deadlines: no body bytes for `uploadIdleTimeoutMs`, or still receiving after `uploadTotalTimeoutMs`. */
  uploadIdleTimeoutMs: number;
  uploadTotalTimeoutMs: number;
  /** Fastify's `connectionTimeout` (socket idle), `requestTimeout` and `keepAliveTimeout`. */
  httpConnectionTimeoutMs: number;
  httpRequestTimeoutMs: number;
  httpKeepAliveTimeoutMs: number;
  /** How long a request may take to arrive whole, counted from its head, unless it is an upload let in (src/body-deadline.ts). */
  httpBodyTimeoutMs: number;
  /** `statement_timeout` of every pool connection (migrations use their own connection). */
  dbStatementTimeoutMs: number;
  /** How long a pool user waits for a connection (pg's `connectionTimeoutMillis`). */
  dbAcquireTimeoutMs: number;
  /** `statement_timeout` inside a search's transaction. */
  searchStatementTimeoutMs: number;
  /** Minutes between the in-process attachment sweeps; 0: none (run `attachments:sweep` by hand). */
  sweepIntervalMinutes: number;
}

/** How long before the server closes an idle connection a persona draft must have answered on it. */
export const DRAFT_SOCKET_MARGIN_MS = 10_000;
/** The least a persona draft is given; a connection timeout that leaves less fails start-up. */
export const MIN_DRAFT_DEADLINE_MS = 10_000;

/**
 * How long a persona draft's model call may take (`POST /api/agents/draft-persona`): `agentRunTimeoutMs`, but always
 * `DRAFT_SOCKET_MARGIN_MS` below the server's connection idle timeout — the request waits for the model with nothing
 * on the wire, and the server would close its connection before it could answer.
 */
export function draftDeadlineMs(config: Pick<Config, "agentRunTimeoutMs" | "httpConnectionTimeoutMs">): number {
  return Math.min(config.agentRunTimeoutMs, config.httpConnectionTimeoutMs - DRAFT_SOCKET_MARGIN_MS);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const s3Fields = [e.S3_ENDPOINT, e.S3_REGION, e.S3_BUCKET, e.S3_ACCESS_KEY_ID, e.S3_SECRET_ACCESS_KEY];
  const anyS3 = s3Fields.some((v) => v !== undefined);
  if (anyS3 && s3Fields.some((v) => v === undefined)) {
    throw new Error(
      "Invalid configuration: S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together",
    );
  }
  if (e.AGENT_MAX_CONCURRENT_OTHERS_RUNS > e.AGENT_MAX_CONCURRENT_RUNS) {
    throw new Error(
      `Invalid configuration: AGENT_MAX_CONCURRENT_OTHERS_RUNS (${e.AGENT_MAX_CONCURRENT_OTHERS_RUNS}) is more than AGENT_MAX_CONCURRENT_RUNS (${e.AGENT_MAX_CONCURRENT_RUNS})`,
    );
  }
  for (const m of e.SITE_MODELS) {
    // A provider's base URL rule (src/providers/guard.ts): https, no credentials, a plain host name or address; and
    // nothing after the path, which a provider's would silently lose. Stored as a provider's is (lower-case host, no
    // default port, no trailing slash). Whether its address may be called is decided at every call, as for providers.
    const normalised = /[?#]/.test(m.baseUrl) ? null : normaliseBaseUrl(m.baseUrl, false);
    if (normalised === null) {
      throw new Error(
        `Invalid configuration: SITE_MODELS: model "${m.id}" has a baseUrl that is not an https URL a provider could have (no credentials, query or fragment)`,
      );
    }
    m.baseUrl = normalised;
    if (m.contextTokens <= m.maxOutputTokens) {
      throw new Error(
        `Invalid configuration: SITE_MODELS: model "${m.id}" has contextTokens ${m.contextTokens}, not more than its maxOutputTokens ${m.maxOutputTokens}: nothing would be left for the conversation`,
      );
    }
  }
  for (const m of e.SITE_MODELS) checkKeyVariable(`SITE_MODELS: model "${m.id}"`, m.apiKeyEnv, env);
  for (const channel of e.JUDGE?.channels ?? []) {
    // A site model's address rule. The URL is the endpoint itself, not a base URL: kept exactly as given, its path too.
    if (/[?#]/.test(channel.url) || normaliseBaseUrl(channel.url, false) === null) {
      throw new Error("Invalid configuration: JUDGE: a channel has a url that is not an https URL (no credentials, query or fragment)");
    }
    checkKeyVariable("JUDGE: a channel", channel.apiKeyEnv, env);
  }
  const duplicate = e.SITE_MODELS.find((m, i) => e.SITE_MODELS.findIndex((o) => o.id === m.id) !== i);
  if (duplicate) throw new Error(`Invalid configuration: SITE_MODELS: id "${duplicate.id}" appears more than once`);
  if (e.PROVIDER_DEFAULT_CONTEXT_TOKENS <= e.PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS) {
    throw new Error(
      `Invalid configuration: PROVIDER_DEFAULT_CONTEXT_TOKENS (${e.PROVIDER_DEFAULT_CONTEXT_TOKENS}) must be more than PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS (${e.PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS}): nothing would be left for the conversation`,
    );
  }
  if (e.ATTACHMENT_MAX_BYTES > e.ATTACHMENT_QUOTA_BYTES) {
    throw new Error(
      `Invalid configuration: ATTACHMENT_MAX_BYTES (${e.ATTACHMENT_MAX_BYTES}) must not exceed ATTACHMENT_QUOTA_BYTES (${e.ATTACHMENT_QUOTA_BYTES}): no file could be stored`,
    );
  }
  // The per-upload deadlines govern uploads: the server-wide timeouts must never cut one off first.
  const httpRequestTimeoutMs = e.HTTP_REQUEST_TIMEOUT_MS ?? e.UPLOAD_TOTAL_TIMEOUT_MS + 60_000;
  if (e.HTTP_CONNECTION_TIMEOUT_MS <= e.UPLOAD_IDLE_TIMEOUT_MS) {
    throw new Error("Invalid configuration: HTTP_CONNECTION_TIMEOUT_MS must be greater than UPLOAD_IDLE_TIMEOUT_MS");
  }
  if (httpRequestTimeoutMs <= e.UPLOAD_TOTAL_TIMEOUT_MS) {
    throw new Error("Invalid configuration: HTTP_REQUEST_TIMEOUT_MS must be greater than UPLOAD_TOTAL_TIMEOUT_MS");
  }
  // A persona draft answers its request only when the model has: it must do so before the idle connection is closed.
  if (e.HTTP_CONNECTION_TIMEOUT_MS - DRAFT_SOCKET_MARGIN_MS < MIN_DRAFT_DEADLINE_MS) {
    throw new Error(
      `Invalid configuration: HTTP_CONNECTION_TIMEOUT_MS (${e.HTTP_CONNECTION_TIMEOUT_MS}) must be at least ${DRAFT_SOCKET_MARGIN_MS + MIN_DRAFT_DEADLINE_MS}: a persona draft must answer ${DRAFT_SOCKET_MARGIN_MS / 1000} s before the connection's idle timeout, which would leave it less than ${MIN_DRAFT_DEADLINE_MS / 1000} s`,
    );
  }
  return {
    databaseUrl: e.DATABASE_URL,
    appOrigin: e.APP_ORIGIN,
    authSecret: e.AUTH_SECRET,
    providerKeySecret: e.PROVIDER_KEY_SECRET,
    siteModels: e.SITE_MODELS,
    freeDailyMicro: e.FREE_DAILY_POINTS,
    siteTimezone: e.SITE_TIMEZONE,
    agentTiers: e.AGENT_TIERS,
    agentMaxConcurrentRuns: e.AGENT_MAX_CONCURRENT_RUNS,
    agentMaxConcurrentOthersRuns: e.AGENT_MAX_CONCURRENT_OTHERS_RUNS,
    agentRunsPerMinute: e.AGENT_RUNS_PER_MINUTE,
    agentOthersRunsPerMinute: e.AGENT_OTHERS_RUNS_PER_MINUTE,
    agentCallerRunsPerMinute: e.AGENT_CALLER_RUNS_PER_MINUTE,
    agentRunTimeoutMs: e.AGENT_RUN_TIMEOUT_MS,
    providerDefaultContextTokens: e.PROVIDER_DEFAULT_CONTEXT_TOKENS,
    providerDefaultMaxOutputTokens: e.PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS,
    reasoningAllowanceTokens: e.REASONING_ALLOWANCE_TOKENS,
    providerMaxConcurrentCalls: e.PROVIDER_MAX_CONCURRENT_CALLS,
    agentMaxRunsInFlight: e.AGENT_MAX_RUNS_IN_FLIGHT,
    agentChainLimit: e.AGENT_CHAIN_LIMIT,
    agentGroupContextTokens: e.AGENT_GROUP_CONTEXT_TOKENS,
    judge: e.JUDGE,
    proactive: e.PROACTIVE,
    memory: e.MEMORY,
    blobDir: e.BLOB_DIR,
    webDist: e.WEB_DIST === undefined ? undefined : path.resolve(e.WEB_DIST),
    port: e.PORT,
    host: e.HOST,
    ...(anyS3
      ? {
          s3: {
            endpoint: e.S3_ENDPOINT!,
            region: e.S3_REGION!,
            bucket: e.S3_BUCKET!,
            accessKeyId: e.S3_ACCESS_KEY_ID!,
            secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
          },
        }
      : {}),
    registrationMode: e.REGISTRATION_MODE,
    mailMode: e.MAIL_MODE,
    rateLimitScale: e.RATE_LIMIT_SCALE,
    clientIpHeader: e.CLIENT_IP_HEADER,
    trustProxy: e.TRUST_PROXY,
    attachmentMaxBytes: e.ATTACHMENT_MAX_BYTES,
    attachmentQuotaBytes: e.ATTACHMENT_QUOTA_BYTES,
    uploadIdleTimeoutMs: e.UPLOAD_IDLE_TIMEOUT_MS,
    uploadTotalTimeoutMs: e.UPLOAD_TOTAL_TIMEOUT_MS,
    httpConnectionTimeoutMs: e.HTTP_CONNECTION_TIMEOUT_MS,
    httpRequestTimeoutMs,
    httpKeepAliveTimeoutMs: e.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    httpBodyTimeoutMs: e.HTTP_BODY_TIMEOUT_MS,
    dbStatementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    dbAcquireTimeoutMs: e.DB_ACQUIRE_TIMEOUT_MS,
    searchStatementTimeoutMs: e.SEARCH_STATEMENT_TIMEOUT_MS,
    sweepIntervalMinutes: e.SWEEP_INTERVAL_MINUTES,
  };
}
