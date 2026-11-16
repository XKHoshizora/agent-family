import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";

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

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : v));

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.url(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  BLOB_DIR: z.string().min(1).default("./data/blobs"),
  /** Directory with the built web client (index.html and /assets); unset: the service serves no web files. */
  WEB_DIST: optionalString,
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
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
  /** Total attachment bytes one principal may store (sent or not). */
  ATTACHMENT_QUOTA_BYTES: z.coerce.number().int().positive().default(2 * 1024 ** 3),
  /** An upload whose client sends no body bytes for this long is cut off. */
  UPLOAD_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /** An upload still receiving its body after this long is cut off. */
  UPLOAD_TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60_000),
  /** Server-wide: a connection with no traffic for this long is closed (WebSockets are exempt). */
  HTTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Server-wide backstop for receiving a whole request; default: the upload deadline plus a minute. */
  HTTP_REQUEST_TIMEOUT_MS: optionalString.transform((v) => (v === undefined ? undefined : Number(v))).pipe(
    z.number().int().positive().optional(),
  ),
  /** Server-wide: an idle kept-alive connection is closed after this long. */
  HTTP_KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(72_000),
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
  blobDir: string;
  /** Absolute path of the built web client to serve, or undefined to serve none. */
  webDist: string | undefined;
  port: number;
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
  attachmentQuotaBytes: number;
  /** Per-upload deadlines: no body bytes for `uploadIdleTimeoutMs`, or still receiving after `uploadTotalTimeoutMs`. */
  uploadIdleTimeoutMs: number;
  uploadTotalTimeoutMs: number;
  /** Fastify's `connectionTimeout` (socket idle), `requestTimeout` and `keepAliveTimeout`. */
  httpConnectionTimeoutMs: number;
  httpRequestTimeoutMs: number;
  httpKeepAliveTimeoutMs: number;
  /** `statement_timeout` of every pool connection (migrations use their own connection). */
  dbStatementTimeoutMs: number;
  /** How long a pool user waits for a connection (pg's `connectionTimeoutMillis`). */
  dbAcquireTimeoutMs: number;
  /** `statement_timeout` inside a search's transaction. */
  searchStatementTimeoutMs: number;
  /** Minutes between the in-process attachment sweeps; 0: none (run `attachments:sweep` by hand). */
  sweepIntervalMinutes: number;
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
  // The per-upload deadlines govern uploads: the server-wide timeouts must never cut one off first.
  const httpRequestTimeoutMs = e.HTTP_REQUEST_TIMEOUT_MS ?? e.UPLOAD_TOTAL_TIMEOUT_MS + 60_000;
  if (e.HTTP_CONNECTION_TIMEOUT_MS <= e.UPLOAD_IDLE_TIMEOUT_MS) {
    throw new Error("Invalid configuration: HTTP_CONNECTION_TIMEOUT_MS must be greater than UPLOAD_IDLE_TIMEOUT_MS");
  }
  if (httpRequestTimeoutMs <= e.UPLOAD_TOTAL_TIMEOUT_MS) {
    throw new Error("Invalid configuration: HTTP_REQUEST_TIMEOUT_MS must be greater than UPLOAD_TOTAL_TIMEOUT_MS");
  }
  return {
    databaseUrl: e.DATABASE_URL,
    appOrigin: e.APP_ORIGIN,
    authSecret: e.AUTH_SECRET,
    blobDir: e.BLOB_DIR,
    webDist: e.WEB_DIST === undefined ? undefined : path.resolve(e.WEB_DIST),
    port: e.PORT,
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
    attachmentQuotaBytes: e.ATTACHMENT_QUOTA_BYTES,
    uploadIdleTimeoutMs: e.UPLOAD_IDLE_TIMEOUT_MS,
    uploadTotalTimeoutMs: e.UPLOAD_TOTAL_TIMEOUT_MS,
    httpConnectionTimeoutMs: e.HTTP_CONNECTION_TIMEOUT_MS,
    httpRequestTimeoutMs,
    httpKeepAliveTimeoutMs: e.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    dbStatementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    dbAcquireTimeoutMs: e.DB_ACQUIRE_TIMEOUT_MS,
    searchStatementTimeoutMs: e.SEARCH_STATEMENT_TIMEOUT_MS,
    sweepIntervalMinutes: e.SWEEP_INTERVAL_MINUTES,
  };
}
