import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ quiet: true });
export const root = process.cwd();
export const dataDir = path.resolve(
  process.env.DATA_DIR || path.join(root, "data"),
);
fs.mkdirSync(dataDir, { recursive: true });
const secretFile = path.join(dataDir, ".secrets.json");
let secrets: { auth: string; encryption: string; setup: string };
if (fs.existsSync(secretFile))
  secrets = JSON.parse(fs.readFileSync(secretFile, "utf8"));
else {
  secrets = {
    auth: crypto.randomBytes(48).toString("base64url"),
    encryption: crypto.randomBytes(32).toString("hex"),
    setup: crypto.randomBytes(24).toString("base64url"),
  };
  try {
    fs.writeFileSync(secretFile, JSON.stringify(secrets), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    secrets = JSON.parse(fs.readFileSync(secretFile, "utf8"));
  }
}
const keyPath =
  process.env.CANAL_KEY_FILE || path.join(root, "CanalAPI-Key.txt");
const localKey = fs.existsSync(keyPath)
  ? dotenv.parse(fs.readFileSync(keyPath))
  : {};
export const config = {
  port: Number(process.env.PORT || 4317),
  host: process.env.HOST || "127.0.0.1",
  origin: new URL(process.env.APP_URL || "http://localhost:4317").origin,
  authSecret: process.env.AUTH_SECRET || secrets.auth,
  encryptionKey: process.env.ENCRYPTION_KEY || secrets.encryption,
  setupToken: process.env.SETUP_TOKEN || secrets.setup,
  canalKey: process.env.CANAL_API_KEY || localKey.CANAL_API_KEY || "",
  canalUrl:
    process.env.CANAL_BASE_URL ||
    localKey.BASE_URL ||
    "https://api.canalapi.com/v1",
  dailyCalls: Number(process.env.DAILY_MODEL_CALLS || 300),
  dailyLineCalls: Number(process.env.DAILY_LINE_MODEL_CALLS || 40),
  maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 1600),
  minimaxMaxOutputTokens: Number(process.env.MINIMAX_MAX_OUTPUT_TOKENS || 8192),
  testMode: process.env.TEST_MODE === "true",
};
if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey))
  throw new Error("ENCRYPTION_KEY must be exactly 64 hexadecimal characters.");
if (
  !Number.isInteger(config.minimaxMaxOutputTokens) ||
  config.minimaxMaxOutputTokens < 128 ||
  config.minimaxMaxOutputTokens > 32000
)
  throw new Error(
    "MINIMAX_MAX_OUTPUT_TOKENS must be an integer between 128 and 32000.",
  );
if (config.authSecret.length < 32)
  throw new Error("AUTH_SECRET must contain at least 32 characters.");
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  throw new Error("PORT must be a valid TCP port.");
if (
  !Number.isInteger(config.dailyCalls) ||
  config.dailyCalls < 1 ||
  config.dailyCalls > 100000
)
  throw new Error("DAILY_MODEL_CALLS must be an integer between 1 and 100000.");
if (
  !Number.isInteger(config.maxOutputTokens) ||
  config.maxOutputTokens < 128 ||
  config.maxOutputTokens > 32000
)
  throw new Error(
    "MAX_OUTPUT_TOKENS must be an integer between 128 and 32000.",
  );
if (
  !Number.isInteger(config.dailyLineCalls) ||
  config.dailyLineCalls < 1 ||
  config.dailyLineCalls > 100000
)
  throw new Error(
    "DAILY_LINE_MODEL_CALLS must be an integer between 1 and 100000.",
  );
export const allowedOrigins = new Set([
  config.origin,
  ...(process.env.NODE_ENV !== "production"
    ? [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:4317",
      ]
    : []),
]);
export function encrypt(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(config.encryptionKey, "hex"),
    iv,
  );
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    body.toString("hex"),
  ].join(".");
}
export function decrypt(value: string) {
  const [iv, tag, body] = value.split(".");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.encryptionKey, "hex"),
    Buffer.from(iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
export function id() {
  return crypto.randomUUID();
}
export function now() {
  return new Date().toISOString();
}
