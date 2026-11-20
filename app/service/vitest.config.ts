import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-setup.ts"],
    // Files share one real Postgres database that is truncated between tests.
    fileParallelism: false,
    testTimeout: 15_000,
    // A truncate between tests (tests/helpers/harness.ts) can take tens of seconds on a machine that other test runs share.
    hookTimeout: 120_000,
  },
});
