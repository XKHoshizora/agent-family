import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : v));

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.url(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  BLOB_DIR: z.string().min(1).default("./data/blobs"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  S3_ENDPOINT: optionalString,
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  REGISTRATION_MODE: z.enum(["invite", "open"]).default("invite"),
  /** Only `outbox` exists in this plan; real delivery is added later. */
  MAIL_MODE: z.enum(["outbox"]).default("outbox"),
  /** Honour X-Forwarded-For. Only enable behind a proxy you control: IP rate limits trust it. */
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
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
  /** A search's statements are cancelled after this long (503 busy). */
  SEARCH_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
});

export interface Config {
  databaseUrl: string;
  appOrigin: string;
  authSecret: string;
  blobDir: string;
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
  trustProxy: boolean;
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
  /** `statement_timeout` inside a search's transaction. */
  searchStatementTimeoutMs: number;
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
    trustProxy: e.TRUST_PROXY,
    attachmentQuotaBytes: e.ATTACHMENT_QUOTA_BYTES,
    uploadIdleTimeoutMs: e.UPLOAD_IDLE_TIMEOUT_MS,
    uploadTotalTimeoutMs: e.UPLOAD_TOTAL_TIMEOUT_MS,
    httpConnectionTimeoutMs: e.HTTP_CONNECTION_TIMEOUT_MS,
    httpRequestTimeoutMs,
    httpKeepAliveTimeoutMs: e.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    dbStatementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    searchStatementTimeoutMs: e.SEARCH_STATEMENT_TIMEOUT_MS,
  };
}
