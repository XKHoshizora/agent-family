import { defineRailway, image, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const agentFamilyData = volume("agent-family-data", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 50000 });
  const agentFamilyMatrixPostgres = volume("agent-family-matrix-postgres", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 1000 });
  const agentFamilyMatrixData = volume("agent-family-matrix-data", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "asia-southeast1-eqsg3a", sizeMB: 1000 });
  const agentFamilyMatrixDb = service("agent-family-matrix-db", {
    source: image("postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536"),
    replicas: { "asia-southeast1-eqsg3a": 1 },
    volumeMounts: { "/var/lib/postgresql/data": agentFamilyMatrixPostgres },
    env: { PGDATA: preserve(), POSTGRES_DB: preserve(), POSTGRES_INITDB_ARGS: preserve(), POSTGRES_PASSWORD: preserve(), POSTGRES_USER: preserve() },
  });
  const agentFamilyWeb = service("agent-family-web", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/api/health",
    healthcheckTimeout: 90,
    replicas: { "asia-southeast1-eqsg3a": 1 },
    deploy: { restartPolicyMaxRetries: 5 },
    volumeMounts: { "/data": agentFamilyData },
    env: { APP_URL: preserve(), AUTH_SECRET: preserve(), CANAL_API_KEY: preserve(), CANAL_BASE_URL: preserve(), DAILY_MODEL_CALLS: preserve(), DATA_DIR: preserve(), ENCRYPTION_KEY: preserve(), HOST: preserve(), MATRIX_ELEMENT_URL: preserve(), MATRIX_HOMESERVER_URL: preserve(), MATRIX_REGISTRATION_SECRET: preserve(), MATRIX_SERVER_NAME: preserve(), MAX_OUTPUT_TOKENS: preserve(), NODE_ENV: preserve(), PORT: preserve(), SETUP_TOKEN: preserve() },
  });
  const agentFamilyElement = service("agent-family-element", {
    healthcheck: "/version",
    healthcheckTimeout: 90,
    replicas: { "asia-southeast1-eqsg3a": 1 },
  });
  const agentFamilySynapse = service("agent-family-synapse", {
    healthcheck: "/health",
    healthcheckTimeout: 180,
    replicas: { "asia-southeast1-eqsg3a": 1 },
    deploy: { restartPolicyMaxRetries: 3 },
    volumeMounts: { "/data": agentFamilyMatrixData },
    env: { PORT: preserve(), SYNAPSE_POSTGRES_DATABASE: preserve(), SYNAPSE_POSTGRES_HOST: preserve(), SYNAPSE_POSTGRES_PASSWORD: preserve(), SYNAPSE_POSTGRES_USER: preserve(), SYNAPSE_PUBLIC_BASEURL: preserve(), SYNAPSE_REGISTRATION_SHARED_SECRET: preserve(), SYNAPSE_REPORT_STATS: preserve(), SYNAPSE_SERVER_NAME: preserve() },
  });

  return project("Agent-Family", {
    resources: [agentFamilyMatrixDb, agentFamilyWeb, agentFamilyElement, agentFamilySynapse, agentFamilyData, agentFamilyMatrixPostgres, agentFamilyMatrixData],
  });
});
