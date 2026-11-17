import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";

const base = {
  DATABASE_URL: "postgres://x/y",
  APP_ORIGIN: "http://localhost:5173",
  AUTH_SECRET: "x".repeat(32),
  PROVIDER_KEY_SECRET: "p".repeat(32),
};
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

describe("attachment and upload configuration", () => {
  test("defaults: 1 GiB a file, 20 GiB a person, 60 minutes in all, 45 s idle", () => {
    expect(loadConfig(base)).toMatchObject({
      attachmentMaxBytes: 1_073_741_824,
      attachmentQuotaBytes: 21_474_836_480,
      uploadTotalTimeoutMs: 3_600_000,
      uploadIdleTimeoutMs: 45_000,
    });
  });

  test("ATTACHMENT_MAX_BYTES: a whole number of bytes from 1 MiB to 5 GiB (empty: the default)", () => {
    const quota = { ATTACHMENT_QUOTA_BYTES: String(10 * GiB) };
    const max = (v: string) => loadConfig({ ...base, ...quota, ATTACHMENT_MAX_BYTES: v });
    expect(max(String(MiB)).attachmentMaxBytes).toBe(MiB);
    expect(max(String(5 * GiB)).attachmentMaxBytes).toBe(5 * GiB);
    expect(max("").attachmentMaxBytes).toBe(GiB);
    for (const bad of [String(MiB - 1), String(5 * GiB + 1), "0", "-1", "1.5", "lots"]) {
      expect(() => max(bad), bad).toThrow(/ATTACHMENT_MAX_BYTES/);
    }
  });

  test("a file may not be allowed to be bigger than the quota", () => {
    const refuse = { ...base, ATTACHMENT_MAX_BYTES: String(2 * GiB), ATTACHMENT_QUOTA_BYTES: String(2 * GiB - 1) };
    expect(() => loadConfig(refuse)).toThrow(/ATTACHMENT_MAX_BYTES.*ATTACHMENT_QUOTA_BYTES/);
    expect(loadConfig({ ...refuse, ATTACHMENT_QUOTA_BYTES: String(2 * GiB) }).attachmentMaxBytes).toBe(2 * GiB);
    // The default per-file size is above a small quota too.
    expect(() => loadConfig({ ...base, ATTACHMENT_QUOTA_BYTES: "4096" })).toThrow(/ATTACHMENT_QUOTA_BYTES/);
  });

  test("the hour-long default upload deadline leaves the server-wide request timeout above it", () => {
    expect(loadConfig(base).httpRequestTimeoutMs).toBe(3_660_000);
  });
});
