import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { api } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

/** The pool has 10 connections; a request that cannot get one within DB_ACQUIRE_TIMEOUT_MS is 503 busy. */
const ACQUIRE_MS = 300;
const { app, db } = useApp({ env: { DB_ACQUIRE_TIMEOUT_MS: String(ACQUIRE_MS) } });

const BUSY = { status: 503, json: { error: "busy" } };

/** Takes every connection of the app's pool until the returned function gives them back. */
async function drainPool(): Promise<() => void> {
  const held = await Promise.all(Array.from({ length: 10 }, () => db.pool.connect()));
  return () => {
    for (const c of held) c.release();
  };
}

describe("waiting for a database connection (DB_ACQUIRE_TIMEOUT_MS)", () => {
  it("defaults to 10 s and must be a positive number of milliseconds", () => {
    const base = { DATABASE_URL: "postgres://x", APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "x".repeat(32) };
    expect(loadConfig(base).dbAcquireTimeoutMs).toBe(10_000);
    expect(loadConfig({ ...base, DB_ACQUIRE_TIMEOUT_MS: "250" }).dbAcquireTimeoutMs).toBe(250);
    for (const bad of ["0", "-1", "x"]) expect(() => loadConfig({ ...base, DB_ACQUIRE_TIMEOUT_MS: bad })).toThrow(/DB_ACQUIRE_TIMEOUT_MS/);
  });

  it("a request that gets no connection in time is 503 busy, and the next one is served once one is free", async () => {
    const release = await drainPool();
    try {
      const t0 = performance.now();
      expect(await api(app, null, "GET", "/api/health")).toEqual(BUSY);
      const waited = performance.now() - t0;
      expect(waited).toBeGreaterThanOrEqual(ACQUIRE_MS - 50);
      expect(waited).toBeLessThan(ACQUIRE_MS * 5);
    } finally {
      release();
    }
    expect(await api(app, null, "GET", "/api/health")).toEqual({ status: 200, json: { ok: true } });
  });
});
