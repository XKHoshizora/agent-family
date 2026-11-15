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
  };
}
