import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
const dataDir =
  process.env.E2E_DATA_DIR ||
  path.join(os.tmpdir(), `agent-family-e2e-${Date.now()}`);
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  retries: 0,
  reporter: "list",
  outputDir: path.join(os.tmpdir(), "agent-family-playwright-results"),
  use: {
    baseURL: "http://localhost:4318",
    channel:
      process.env.PLAYWRIGHT_CHANNEL ||
      (process.platform === "win32" ? "chrome" : undefined),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node --import tsx server/index.ts",
    url: "http://localhost:4318/api/health",
    reuseExistingServer: false,
    timeout: 20000,
    env: {
      DATA_DIR: dataDir,
      PORT: "4318",
      HOST: "127.0.0.1",
      APP_URL: "http://localhost:4318",
      CANAL_KEY_FILE: path.join(dataDir, "no-key-file.txt"),
      CANAL_API_KEY: "",
      NODE_ENV: "test",
    },
  },
});
