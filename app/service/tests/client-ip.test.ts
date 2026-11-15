import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Which address the IP-keyed rate limits (registration, the sign-in and reset-request limiters) count:
 * by default the socket's; with CLIENT_IP_HEADER that header's single value; with TRUST_PROXY what Fastify
 * derives from X-Forwarded-For over that many (or those) trusted hops. Never a header a client made up.
 */

const { app } = useApp();

const BASE = { DATABASE_URL: "postgres://x", APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "x".repeat(32) };

/** The test app's wiring with production rate limits and `config` on top; shares the test pool. */
async function variant(config: Partial<Config>, run: (target: FastifyInstance) => Promise<void>): Promise<void> {
  const built = await buildApp({ config: { ...app.deps.config, rateLimitScale: 1, ...config }, db: app.deps.db });
  await built.ready();
  try {
    await run(built);
  } finally {
    await built.close();
  }
}

/** An empty registration (400 after the limiter counted it): 10 per minute per client address. */
const register = (target: FastifyInstance, remoteAddress: string, headers: Record<string, string> = {}) =>
  target.inject({ method: "POST", url: "/api/register", remoteAddress, headers, payload: {} }).then((r) => r.statusCode);

describe("client address configuration", () => {
  it("trusts nothing by default; TRUST_PROXY lists proxy addresses, never a bare true or a hop count", () => {
    expect(loadConfig(BASE)).toMatchObject({ trustProxy: false, clientIpHeader: undefined });
    for (const off of ["", "false", "0"]) expect([off, loadConfig({ ...BASE, TRUST_PROXY: off }).trustProxy]).toEqual([off, false]);
    expect(() => loadConfig({ ...BASE, TRUST_PROXY: "2" })).toThrow(/TRUST_PROXY=2: a hop count .*CLIENT_IP_HEADER/);
    expect(loadConfig({ ...BASE, TRUST_PROXY: "10.0.0.0/8, 127.0.0.1,::1,fd00::/8" }).trustProxy).toEqual([
      "10.0.0.0/8",
      "127.0.0.1",
      "::1",
      "fd00::/8",
    ]);
    expect(() => loadConfig({ ...BASE, TRUST_PROXY: "true" })).toThrow(/TRUST_PROXY=true .*CLIENT_IP_HEADER/);
    for (const bad of ["TRUE", "yes", "1.5", "-1", "10.0.0.0/33", "::1/129", "300.1.1.1", "10.0.0.1,", "loopback", "10.0.0.1/8x"]) {
      expect(() => loadConfig({ ...BASE, TRUST_PROXY: bad }), bad).toThrow(/TRUST_PROXY/);
    }
    expect(loadConfig({ ...BASE, CLIENT_IP_HEADER: "X-Real-IP" }).clientIpHeader).toBe("x-real-ip");
    expect(loadConfig({ ...BASE, CLIENT_IP_HEADER: "" }).clientIpHeader).toBeUndefined();
    for (const bad of ["x real ip", "x-real-ip:", "ü", "x-real-ip\n"]) {
      expect(() => loadConfig({ ...BASE, CLIENT_IP_HEADER: bad }), bad).toThrow(/CLIENT_IP_HEADER/);
    }
  });
});

describe("the address rate limits count", () => {
  it("by default is the socket's: forged X-Forwarded-For and X-Real-IP change nothing", async () => {
    await variant({}, async (target) => {
      for (let i = 0; i < 10; i++) {
        const forged = { "x-forwarded-for": `198.51.100.${i}`, "x-real-ip": `203.0.113.${i}` };
        expect(await register(target, "10.0.0.1", forged)).toBe(400);
      }
      expect(await register(target, "10.0.0.1", { "x-forwarded-for": "198.51.100.99", "x-real-ip": "203.0.113.99" })).toBe(429);
      expect(await register(target, "10.0.0.1")).toBe(429);
      expect(await register(target, "10.0.0.2")).toBe(400);
    });
  });

  it("with CLIENT_IP_HEADER is that header's single value; absent or not one address, the socket's", async () => {
    await variant({ clientIpHeader: "x-real-ip" }, async (target) => {
      // Everyone arrives through the same proxy (one socket address); the header tells them apart.
      for (let i = 0; i < 10; i++) expect(await register(target, "10.0.0.1", { "x-real-ip": "203.0.113.1" })).toBe(400);
      expect(await register(target, "10.0.0.1", { "x-real-ip": "203.0.113.1" })).toBe(429);
      // X-Forwarded-For is not consulted at all.
      expect(await register(target, "10.0.0.1", { "x-real-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.1" })).toBe(429);
      expect(await register(target, "10.0.0.1", { "x-real-ip": "203.0.113.2" })).toBe(400);
      expect(await register(target, "10.0.0.1", { "x-real-ip": " 2001:DB8::1 " })).toBe(400);

      // Missing, empty, not an address, or more than one: the socket's address, one shared budget.
      const unusable: Array<Record<string, string>> = [{}, { "x-real-ip": "" }, { "x-real-ip": "nonsense" }, { "x-real-ip": "203.0.113.1, 203.0.113.3" }, { "x-real-ip": "203.0.113.0/24" }];
      for (let i = 0; i < 10; i++) expect(await register(target, "10.0.0.9", unusable[i % unusable.length]!)).toBe(400);
      expect(await register(target, "10.0.0.9", {})).toBe(429);
      expect(await register(target, "10.0.0.9", { "x-real-ip": "203.0.113.3" })).toBe(400);
    });
  });

  it("with TRUST_PROXY is, through a listed proxy, the right-most X-Forwarded-For entry; a forged left-most one changes nothing", async () => {
    await variant({ trustProxy: ["10.0.0.1"] }, async (target) => {
      for (let i = 0; i < 10; i++) {
        expect(await register(target, "10.0.0.1", { "x-forwarded-for": `198.51.100.${i}, 203.0.113.5` })).toBe(400);
      }
      expect(await register(target, "10.0.0.1", { "x-forwarded-for": "203.0.113.5" })).toBe(429);
      expect(await register(target, "10.0.0.1", { "x-forwarded-for": "203.0.113.6" })).toBe(400);
      // A client connecting directly (not through the listed proxy) is its own address, whatever it claims.
      for (let i = 0; i < 10; i++) expect(await register(target, "10.0.0.2", { "x-forwarded-for": `203.0.113.${100 + i}` })).toBe(400);
      expect(await register(target, "10.0.0.2", { "x-forwarded-for": "203.0.113.200" })).toBe(429);
    });
  });

  it("is what the sign-in limiter in front of Better Auth counts too", async () => {
    await variant({ clientIpHeader: "x-real-ip" }, async (target) => {
      const a = await signUp(target, "ip_signin");
      const attempt = (ip: string) =>
        target.inject({
          method: "POST",
          url: "/api/auth/sign-in/email",
          remoteAddress: "10.0.0.1",
          headers: { "x-real-ip": ip },
          payload: { email: a.email, password: "not the password" },
        });
      for (let i = 0; i < 10; i++) expect((await attempt("203.0.113.7")).statusCode).toBe(401);
      expect((await attempt("203.0.113.7")).statusCode).toBe(429);
      expect((await attempt("203.0.113.8")).statusCode).toBe(401);
    });
  });
});
