import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { db } from "./db";
import { config, allowedOrigins } from "./config";
export const auth = betterAuth({
  database: db,
  baseURL: config.origin,
  secret: config.authSecret,
  trustedOrigins: [...allowedOrigins],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
  },
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 12 },
  advanced: {
    cookiePrefix: "agent-family",
    useSecureCookies: config.origin.startsWith("https://"),
    ipAddress: { ipAddressHeaders: ["x-af-client-ip"] },
  },
  rateLimit: { enabled: true, window: 60, max: 30 },
});
export async function migrateAuth() {
  const migration = await getMigrations(auth.options);
  await migration.runMigrations();
}
export function requestHeaders(
  headers: Record<string, string | string[] | undefined>,
  remoteIp?: string,
) {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "x-af-client-ip") continue;
    if (value !== undefined)
      result.set(key, Array.isArray(value) ? value.join(",") : value);
  }
  if (remoteIp) result.set("x-af-client-ip", remoteIp);
  return result;
}
