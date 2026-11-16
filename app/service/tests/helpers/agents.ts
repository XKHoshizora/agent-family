import type { FastifyInstance } from "fastify";
import { api, type Actor, type ApiResult } from "./actors.ts";

/** The 1x1 PNG the avatar tests upload. */
export const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.from("00000001000000010806000000", "hex"),
  Buffer.from("1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex"),
]);

/** Environment every agents test file passes to `useApp`: two site models and a tier with 25 Agents. */
export const SITE_ENV = {
  UPSTREAM_TEST_KEY: "not-a-real-key",
  AGENT_TIERS: JSON.stringify({ free: 20, plus: 25 }),
  SITE_MODELS: JSON.stringify([
    {
      id: "fast",
      label: "Fast",
      tier: "free",
      protocol: "openai_chat",
      baseUrl: "https://api.example.test/v1",
      apiKeyEnv: "UPSTREAM_TEST_KEY",
      model: "fast-1",
      inputMicroPerToken: 1,
      outputMicroPerToken: 2,
      maxOutputTokens: 4096,
      contextTokens: 100000,
      vision: false,
      pdf: false,
      reasoning: [],
    },
    {
      id: "thinker",
      label: "Thinker",
      tier: "paid",
      protocol: "anthropic",
      baseUrl: "https://api.example.test/v1",
      apiKeyEnv: "UPSTREAM_TEST_KEY",
      model: "think-1",
      inputMicroPerToken: 3,
      outputMicroPerToken: 6,
      maxOutputTokens: 8192,
      contextTokens: 200000,
      vision: true,
      pdf: true,
      reasoning: ["low", "medium"],
    },
  ]),
} as const;

let counter = 0;

/** `POST /api/agents` with a fresh handle unless `over` names one. */
export function createAgent(app: FastifyInstance, owner: Actor, over: Record<string, unknown> = {}): Promise<ApiResult> {
  const n = ++counter;
  return api(app, owner, "POST", "/api/agents", { handle: `bot_${n}_${Date.now() % 100000}`, name: `Bot ${n}`, ...over });
}

/** The same, expecting 201; returns the Agent. */
export async function mustCreateAgent(app: FastifyInstance, owner: Actor, over: Record<string, unknown> = {}) {
  const res = await createAgent(app, owner, over);
  if (res.status !== 201) throw new Error(`createAgent: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}
