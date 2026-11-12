import { defineRailway, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const agentFamilyData = volume("agent-family-data", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "asia-southeast1-eqsg3a",
    sizeMB: 50000,
  });
  const agentFamilyWeb = service("agent-family-web", {
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    },
    healthcheck: "/api/health",
    healthcheckTimeout: 90,
    replicas: { "asia-southeast1-eqsg3a": 1 },
    deploy: { restartPolicyMaxRetries: 5 },
    volumeMounts: { "/data": agentFamilyData },
    env: {
      APP_URL: preserve(),
      AUTH_SECRET: preserve(),
      CANAL_API_KEY: preserve(),
      CANAL_BASE_URL: preserve(),
      DAILY_MODEL_CALLS: preserve(),
      DATA_DIR: preserve(),
      ENCRYPTION_KEY: preserve(),
      HOST: preserve(),
      MAX_OUTPUT_TOKENS: preserve(),
      NODE_ENV: preserve(),
      PORT: preserve(),
      SETUP_TOKEN: preserve(),
    },
  });

  return project("Agent-Family", {
    resources: [agentFamilyWeb, agentFamilyData],
  });
});
