import { describe, expect, test } from "vitest";
import { draftDeadlineMs, loadConfig } from "../src/config.ts";

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
      providerMaxConcurrentCalls: 64,
      agentMaxRunsInFlight: 8,
      agentChainLimit: 30,
      agentGroupContextTokens: 12_000,
    });
  });

  test("the protective limits are configuration, each a whole number within its range (empty: the default)", () => {
    expect(
      loadConfig({
        ...base,
        AGENT_MAX_CONCURRENT_RUNS: "5",
        AGENT_RUNS_PER_MINUTE: "60",
        AGENT_RUN_TIMEOUT_MS: "30000",
        PROVIDER_DEFAULT_CONTEXT_TOKENS: "32000",
        PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS: "4096",
        PROVIDER_MAX_CONCURRENT_CALLS: "128",
      }),
    ).toMatchObject({
      agentMaxConcurrentRuns: 5,
      agentRunsPerMinute: 60,
      agentRunTimeoutMs: 30_000,
      providerDefaultContextTokens: 32_000,
      providerDefaultMaxOutputTokens: 4096,
      providerMaxConcurrentCalls: 128,
    });
    const ranges: Array<[name: string, field: string, accepted: Array<[string, number]>, refused: string[]]> = [
      ["AGENT_MAX_CONCURRENT_RUNS", "agentMaxConcurrentRuns", [["1", 1], ["100", 100], ["", 2]], ["0", "101", "-1", "1.5", "two", "1e2"]],
      ["AGENT_RUNS_PER_MINUTE", "agentRunsPerMinute", [["1", 1], ["10000", 10_000], ["", 20]], ["0", "10001", "-5", "2.5", "lots"]],
      ["AGENT_RUN_TIMEOUT_MS", "agentRunTimeoutMs", [["1000", 1000], ["3600000", 3_600_000], ["", 120_000]], ["999", "3600001", "0", "60s"]],
      ["PROVIDER_DEFAULT_CONTEXT_TOKENS", "providerDefaultContextTokens", [["2049", 2049], ["2000000", 2_000_000], ["", 16_000]], ["999", "2000001", "16k"]],
      ["PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS", "providerDefaultMaxOutputTokens", [["1", 1], ["15999", 15_999], ["", 2048]], ["0", "-1", "1.5"]],
      ["PROVIDER_MAX_CONCURRENT_CALLS", "providerMaxConcurrentCalls", [["1", 1], ["1000", 1000], ["", 64]], ["0", "1001", "many"]],
      ["AGENT_MAX_RUNS_IN_FLIGHT", "agentMaxRunsInFlight", [["1", 1], ["64", 64], ["", 8]], ["0", "65", "-1", "1.5", "many"]],
      ["AGENT_CHAIN_LIMIT", "agentChainLimit", [["2", 2], ["500", 500], ["", 30]], ["0", "1", "501", "-3", "2.5", "thirty"]],
      ["AGENT_GROUP_CONTEXT_TOKENS", "agentGroupContextTokens", [["2000", 2000], ["200000", 200_000], ["", 12_000]], ["0", "1999", "200001", "-1", "1.5", "12k"]],
    ];
    for (const [name, field, accepted, refused] of ranges) {
      for (const [value, parsed] of accepted) expect([name, value, (loadConfig({ ...base, [name]: value }) as any)[field]]).toEqual([name, value, parsed]);
      for (const value of refused) expect(() => loadConfig({ ...base, [name]: value }), `${name}=${value}`).toThrow(new RegExp(name));
    }
  });

  test("the default context of a provider model must be larger than the default output limit, or nothing is left for the conversation", () => {
    expect(() => loadConfig({ ...base, PROVIDER_DEFAULT_CONTEXT_TOKENS: "4096", PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS: "4096" })).toThrow(
      /PROVIDER_DEFAULT_CONTEXT_TOKENS.*PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS/,
    );
    expect(() => loadConfig({ ...base, PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS: "16000" })).toThrow(/PROVIDER_DEFAULT_CONTEXT_TOKENS/);
    expect(loadConfig({ ...base, PROVIDER_DEFAULT_CONTEXT_TOKENS: "4097", PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS: "4096" })).toMatchObject({
      providerDefaultContextTokens: 4097,
      providerDefaultMaxOutputTokens: 4096,
    });
  });

  test("a persona draft must answer before the connection's idle timeout: HTTP_CONNECTION_TIMEOUT_MS less 10 s must leave 10 s", () => {
    // (The connection timeout must also exceed the upload idle deadline, lowered here so only this rule can refuse.)
    const short = { ...base, UPLOAD_IDLE_TIMEOUT_MS: "1000" };
    expect(() => loadConfig({ ...short, HTTP_CONNECTION_TIMEOUT_MS: "19999" })).toThrow(/HTTP_CONNECTION_TIMEOUT_MS/);
    expect(() => loadConfig({ ...short, HTTP_CONNECTION_TIMEOUT_MS: "5000" })).toThrow(/persona draft/);
    const config = loadConfig({ ...short, HTTP_CONNECTION_TIMEOUT_MS: "20000" });
    expect(draftDeadlineMs(config)).toBe(10_000);
    expect(draftDeadlineMs(loadConfig(base))).toBe(110_000); // the defaults: 120 s connection, 120 s runs
    expect(draftDeadlineMs(loadConfig({ ...base, AGENT_RUN_TIMEOUT_MS: "30000" }))).toBe(30_000);
    expect(draftDeadlineMs(loadConfig({ ...base, AGENT_RUN_TIMEOUT_MS: "1000" }))).toBe(1_000);
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

  test("SITE_MODELS: a baseUrl follows a provider's rule (https, no credentials, query or fragment), normalised; else start-up fails naming the model", () => {
    for (const baseUrl of [
      "http://api.example.test/v1",
      "https://user:pw@api.example.test/v1",
      "https://@api.example.test/v1",
      "https://api.example.test/v1?key=x",
      "https://api.example.test/v1?",
      "https://api.example.test/v1#frag",
      "https://exa_mple.test/v1",
      "ftp://api.example.test/v1",
    ]) {
      expect(() => loadConfig(withModels([{ ...model, baseUrl }])), baseUrl).toThrow(/SITE_MODELS: model "fast".*baseUrl/);
    }
    expect(loadConfig(withModels([{ ...model, baseUrl: "https://API.Example.test:443/v1/" }])).siteModels[0]!.baseUrl).toBe("https://api.example.test/v1");
    expect(loadConfig(withModels([{ ...model, baseUrl: "https://203.0.113.9:8443/openai/v1" }])).siteModels[0]!.baseUrl).toBe("https://203.0.113.9:8443/openai/v1");
  });

  test("SITE_MODELS: a model's context must be larger than its output limit, or nothing is left for the conversation", () => {
    expect(() => loadConfig(withModels([{ ...model, contextTokens: 2048 }]))).toThrow(/SITE_MODELS: model "fast" has contextTokens 2048, not more than its maxOutputTokens 2048/);
    expect(loadConfig(withModels([{ ...model, contextTokens: 2049 }])).siteModels[0]!.contextTokens).toBe(2049);
  });

  test("SITE_MODELS: an apiKeyEnv that is unset (or empty) fails start-up naming it", () => {
    expect(() => loadConfig(withModels([model], {}))).toThrow(/SITE_MODELS.*TEST_UPSTREAM_KEY/);
    expect(() => loadConfig(withModels([model], { TEST_UPSTREAM_KEY: "" }))).toThrow(/TEST_UPSTREAM_KEY/);
  });

  test("SITE_MODELS: an apiKeyEnv may not name one of the service's own variables: start-up fails naming the model", () => {
    const s3 = { S3_ENDPOINT: "https://s3.example.test", S3_REGION: "r", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "access-id", S3_SECRET_ACCESS_KEY: "s3-secret" };
    expect(loadConfig(withModels([model], { TEST_UPSTREAM_KEY: "upstream-key-value", ...s3 })).siteModels).toHaveLength(1);
    for (const own of ["DATABASE_URL", "AUTH_SECRET", "PROVIDER_KEY_SECRET", "S3_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID", "auth_secret"]) {
      // Each of them is set (base, s3, and the lower-case name too), so only the rule can refuse it.
      expect(() => loadConfig(withModels([{ ...model, apiKeyEnv: own }], { ...s3, auth_secret: "a-lower-case-variable" })), own).toThrow(
        new RegExp(`SITE_MODELS: model "fast".*${own}`),
      );
    }
  });

  test("SITE_MODELS: two models may share one apiKeyEnv (two models of one upstream account)", () => {
    const config = loadConfig(withModels([model, { ...model, id: "slow", label: "Slow", model: "slow-1" }]));
    expect(config.siteModels.map((m) => [m.id, m.apiKeyEnv])).toEqual([
      ["fast", "TEST_UPSTREAM_KEY"],
      ["slow", "TEST_UPSTREAM_KEY"],
    ]);
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
