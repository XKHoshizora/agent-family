import { describe, expect, test } from "vitest";
import { SERVICE_SECRET_VARIABLES, loadConfig } from "../src/config.ts";

const base = {
  DATABASE_URL: "postgres://x/y",
  APP_ORIGIN: "http://localhost:5173",
  AUTH_SECRET: "x".repeat(32),
  PROVIDER_KEY_SECRET: "p".repeat(32),
};
const KEY = "re_test_key_that_must_never_be_printed";

describe("mail configuration", () => {
  test("outbox is the default and needs nothing else", () => {
    const c = loadConfig(base);
    expect(c.mailMode).toBe("outbox");
    expect(c.mail).toBeUndefined();
  });

  test("resend needs RESEND_API_KEY and MAIL_FROM, and start-up names the one that is missing", () => {
    const resend = { ...base, MAIL_MODE: "resend" };
    expect(() => loadConfig(resend)).toThrow(/RESEND_API_KEY/);
    expect(() => loadConfig({ ...resend, RESEND_API_KEY: KEY })).toThrow(/MAIL_FROM/);
    expect(() => loadConfig({ ...resend, MAIL_FROM: "A <a@mail.example>" })).toThrow(/RESEND_API_KEY/);
    expect(() => loadConfig({ ...resend, RESEND_API_KEY: "", MAIL_FROM: "A <a@mail.example>" })).toThrow(/RESEND_API_KEY/);
  });

  test("resend with both: the key, the sender and the optional reply-to are read", () => {
    const c = loadConfig({ ...base, MAIL_MODE: "resend", RESEND_API_KEY: KEY, MAIL_FROM: "Haiyo <no-reply@mail.example>", MAIL_REPLY_TO: "help@mail.example" });
    expect(c.mailMode).toBe("resend");
    expect(c.mail).toEqual({ apiKey: KEY, from: "Haiyo <no-reply@mail.example>", replyTo: "help@mail.example" });
    expect(loadConfig({ ...base, MAIL_MODE: "resend", RESEND_API_KEY: KEY, MAIL_FROM: "a@mail.example" }).mail?.replyTo).toBeUndefined();
  });

  test("outbox ignores the resend variables; an unknown mode is refused", () => {
    expect(loadConfig({ ...base, RESEND_API_KEY: KEY, MAIL_FROM: "a@mail.example" }).mail).toBeUndefined();
    expect(() => loadConfig({ ...base, MAIL_MODE: "smtp" })).toThrow(/MAIL_MODE/);
  });

  test("a sender or reply-to that could carry another header is refused, and no message prints the key", () => {
    const resend = { ...base, MAIL_MODE: "resend", RESEND_API_KEY: KEY };
    expect(() => loadConfig({ ...resend, MAIL_FROM: "a@mail.example\r\nBcc: x@y.example" })).toThrow(/MAIL_FROM/);
    expect(() => loadConfig({ ...resend, MAIL_FROM: "a@mail.example", MAIL_REPLY_TO: "x@y.example\nBcc: z@y.example" })).toThrow(/MAIL_REPLY_TO/);
    for (const env of [{ ...resend, MAIL_FROM: undefined }, { ...resend, MAIL_FROM: "a@mail.example\n" }]) {
      try {
        loadConfig(env);
      } catch (err) {
        expect(String(err)).not.toContain(KEY);
      }
    }
  });

  test("RESEND_API_KEY is one of the service's own secrets (tests/config-agents.test.ts: no site model may name it as its key)", () => {
    expect(SERVICE_SECRET_VARIABLES).toContain("RESEND_API_KEY");
  });
});
