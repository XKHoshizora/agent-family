import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";

const base = {
  DATABASE_URL: "postgres://x/y",
  APP_ORIGIN: "http://localhost:5173",
  AUTH_SECRET: "x".repeat(32),
  PROVIDER_KEY_SECRET: "p".repeat(32),
};

const model = {
  id: "fast",
  label: "Fast",
  tier: "free",
  protocol: "openai_chat",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "TEST_UPSTREAM_KEY",
  model: "fast-1",
  inputMicroPerToken: 1,
  outputMicroPerToken: 3,
  maxOutputTokens: 2048,
  contextTokens: 32000,
  vision: false,
  pdf: false,
  reasoning: ["low", "high"],
};

const withModels = (models: unknown, extra: Record<string, string> = { TEST_UPSTREAM_KEY: "upstream-key-value" }) => ({
  ...base,
  ...extra,
  SITE_MODELS: typeof models === "string" ? models : JSON.stringify(models),
});

describe("agent and metering configuration", () => {
  test("defaults", () => {
    expect(loadConfig(base)).toMatchObject({
      providerKeySecret: "p".repeat(32),
      siteModels: [],
      freeDailyMicro: 200_000_000n,
      siteTimezone: "Asia/Shanghai",
      agentTiers: { free: 20 },
      agentMaxConcurrentRuns: 2,
      agentRunsPerMinute: 20,
      agentRunTimeoutMs: 120_000,
      providerDefaultContextTokens: 16_000,
      providerDefaultMaxOutputTokens: 2048,
    });
  });

  test("PROVIDER_KEY_SECRET is required and at least 32 characters", () => {
    const { PROVIDER_KEY_SECRET: _omit, ...without } = base;
    expect(() => loadConfig(without)).toThrow(/PROVIDER_KEY_SECRET/);
    expect(() => loadConfig({ ...base, PROVIDER_KEY_SECRET: "" })).toThrow(/PROVIDER_KEY_SECRET/);
    expect(() => loadConfig({ ...base, PROVIDER_KEY_SECRET: "p".repeat(31) })).toThrow(/PROVIDER_KEY_SECRET/);
    expect(loadConfig({ ...base, PROVIDER_KEY_SECRET: "p".repeat(32) }).providerKeySecret).toHaveLength(32);
  });

  test("SITE_MODELS: a valid list is parsed, the key variable is only named", () => {
    const config = loadConfig(withModels([model]));
    expect(config.siteModels).toEqual([model]);
    expect(JSON.stringify(config.siteModels)).not.toContain("upstream-key-value");
    expect(loadConfig({ ...base, SITE_MODELS: "" }).siteModels).toEqual([]);
  });

  test("SITE_MODELS: malformed input stops loadConfig with a message naming the variable", () => {
    const bad: [string, unknown][] = [
      ["not json", "{not json"],
      ["not an array", { id: "x" }],
      ["unknown protocol", [{ ...model, protocol: "carrier_pigeon" }]],
      ["negative input price", [{ ...model, inputMicroPerToken: -1 }]],
      ["negative output price", [{ ...model, outputMicroPerToken: -1 }]],
      ["fractional price", [{ ...model, inputMicroPerToken: 0.5 }]],
      ["unknown tier", [{ ...model, tier: "gold" }]],
      ["unknown reasoning level", [{ ...model, reasoning: ["ludicrous"] }]],
      ["missing field", [{ ...model, model: undefined }]],
      ["bad base url", [{ ...model, baseUrl: "not a url" }]],
      ["duplicate ids", [model, model]],
      ["context no larger than the output limit", [{ ...model, contextTokens: 2048 }]],
      ["context smaller than the output limit", [{ ...model, contextTokens: 1000 }]],
    ];
    for (const [name, value] of bad) {
      expect(() => loadConfig(withModels(value)), name).toThrow(/SITE_MODELS/);
    }
  });

  test("SITE_MODELS: a model's context must be larger than its output limit, or nothing is left for the conversation", () => {
    expect(() => loadConfig(withModels([{ ...model, contextTokens: 2048 }]))).toThrow(/SITE_MODELS: model "fast" has contextTokens 2048, not more than its maxOutputTokens 2048/);
    expect(loadConfig(withModels([{ ...model, contextTokens: 2049 }])).siteModels[0]!.contextTokens).toBe(2049);
  });

  test("SITE_MODELS: an apiKeyEnv that is unset (or empty) fails start-up naming it", () => {
    expect(() => loadConfig(withModels([model], {}))).toThrow(/SITE_MODELS.*TEST_UPSTREAM_KEY/);
    expect(() => loadConfig(withModels([model], { TEST_UPSTREAM_KEY: "" }))).toThrow(/TEST_UPSTREAM_KEY/);
  });

  test("AGENT_TIERS must contain free and hold whole non-negative limits", () => {
    expect(loadConfig({ ...base, AGENT_TIERS: '{"free":5,"pro":100}' }).agentTiers).toEqual({ free: 5, pro: 100 });
    for (const bad of ['{"pro":100}', "[]", "nope", '{"free":-1}', '{"free":1.5}', '{"free":"3"}']) {
      expect(() => loadConfig({ ...base, AGENT_TIERS: bad }), bad).toThrow(/AGENT_TIERS/);
    }
  });

  test("FREE_DAILY_POINTS is given in points and kept in micro-points", () => {
    expect(loadConfig({ ...base, FREE_DAILY_POINTS: "50" }).freeDailyMicro).toBe(50_000_000n);
    expect(loadConfig({ ...base, FREE_DAILY_POINTS: "0" }).freeDailyMicro).toBe(0n);
    for (const bad of ["-1", "1.5", "lots"]) expect(() => loadConfig({ ...base, FREE_DAILY_POINTS: bad }), bad).toThrow(/FREE_DAILY_POINTS/);
  });

  test("SITE_TIMEZONE must be an IANA zone", () => {
    expect(loadConfig({ ...base, SITE_TIMEZONE: "Europe/Berlin" }).siteTimezone).toBe("Europe/Berlin");
    expect(() => loadConfig({ ...base, SITE_TIMEZONE: "Mars/Olympus" })).toThrow(/SITE_TIMEZONE/);
  });
});
