import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { db } from "./db";
import { config, encrypt, decrypt, now } from "./config";
import type { ModelOption, Agent } from "../shared/types";
export type ProviderKind = "compatible" | "openai" | "anthropic" | "google";
export function validateEndpoint(value: string) {
  const url = new URL(value);
  const hosts = new Set([
    "api.canalapi.com",
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    ...(process.env.PROVIDER_ALLOWED_HOSTS || "").split(",").filter(Boolean),
  ]);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !hosts.has(url.hostname) ||
    !["", "443"].includes(url.port)
  )
    throw new Error(
      "模型服务地址必须使用受信任的 HTTPS 域名。自建服务请由部署管理员加入允许列表。",
    );
  return url.toString().replace(/\/$/, "");
}
export function ensureDefaultProvider(workspaceId: string) {
  if (
    config.canalKey &&
    !db
      .prepare("SELECT 1 FROM providers WHERE workspace_id=? AND id=?")
      .get(workspaceId, "canal")
  )
    db.prepare("INSERT INTO providers VALUES(?,?,?,?,?,?,?)").run(
      "canal",
      workspaceId,
      "compatible",
      validateEndpoint(config.canalUrl),
      encrypt(config.canalKey),
      "[]",
      now(),
    );
}
export function familyFor(model: string) {
  return /claude/i.test(model)
    ? "Claude"
    : /gemini/i.test(model)
      ? "Gemini"
      : /gpt|o[134]-|chatgpt/i.test(model)
        ? "GPT"
        : "其他";
}
export function listProviders(workspaceId: string) {
  ensureDefaultProvider(workspaceId);
  return (
    db
      .prepare("SELECT * FROM providers WHERE workspace_id=?")
      .all(workspaceId) as any[]
  ).map((p) => ({
    id: p.id,
    kind: p.kind,
    baseUrl: p.base_url,
    configured: !!p.secret,
    models: JSON.parse(p.models) as string[],
    updatedAt: p.updated_at,
  }));
}
export function listModels(workspaceId: string): ModelOption[] {
  return listProviders(workspaceId).flatMap((p) =>
    p.models.map((model) => ({
      id: model,
      provider: p.id,
      label: model,
      family: familyFor(model),
    })),
  );
}
export function saveProvider(
  workspaceId: string,
  p: {
    id: string;
    kind: ProviderKind;
    baseUrl: string;
    apiKey?: string;
    models: string[];
  },
) {
  const old = db
    .prepare("SELECT * FROM providers WHERE workspace_id=? AND id=?")
    .get(workspaceId, p.id) as any;
  const secret = p.apiKey ? encrypt(p.apiKey) : old?.secret;
  if (!secret) throw new Error("请输入 API 密钥。");
  const url = validateEndpoint(p.baseUrl);
  db.prepare(
    "INSERT INTO providers VALUES(?,?,?,?,?,?,?) ON CONFLICT(id,workspace_id) DO UPDATE SET kind=excluded.kind,base_url=excluded.base_url,secret=excluded.secret,models=excluded.models,updated_at=excluded.updated_at",
  ).run(
    p.id,
    workspaceId,
    p.kind,
    url,
    secret,
    JSON.stringify([...new Set(p.models)]),
    now(),
  );
}
export async function refreshModels(workspaceId: string, providerId: string) {
  const p = db
    .prepare("SELECT * FROM providers WHERE workspace_id=? AND id=?")
    .get(workspaceId, providerId) as any;
  if (!p) throw new Error("模型服务不存在。");
  if (!["compatible", "openai"].includes(p.kind))
    throw new Error("此服务请手动填写模型名称。");
  const response = await fetch(`${validateEndpoint(p.base_url)}/models`, {
    headers: { Authorization: `Bearer ${decrypt(p.secret)}` },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      `模型列表读取失败（${response.status}），请检查密钥与服务地址。`,
    );
  const body = (await response.json()) as any;
  const models = (body.data || [])
    .map((m: any) => m.id)
    .filter(
      (m: any) =>
        typeof m === "string" &&
        m.length < 180 &&
        !/embedding|tts|whisper|dall-e|image|video|realtime|audio|rerank|moderation|speech|asr-|hailuo|voice|auto-review/i.test(
          m,
        ),
    )
    .slice(0, 500);
  if (!models.length) throw new Error("服务未返回可用的聊天模型。");
  db.prepare(
    "UPDATE providers SET models=?,updated_at=? WHERE workspace_id=? AND id=?",
  ).run(JSON.stringify(models), now(), workspaceId, providerId);
  return models as string[];
}
export function modelFor(workspaceId: string, agent: Agent) {
  const p = db
    .prepare("SELECT * FROM providers WHERE workspace_id=? AND id=?")
    .get(workspaceId, agent.provider) as any;
  if (!p || !JSON.parse(p.models).includes(agent.model))
    throw new Error(`请先为${agent.name}选择可用模型。`);
  const opts = {
    apiKey: decrypt(p.secret),
    baseURL: validateEndpoint(p.base_url),
    fetch: ((input: any, init: any) =>
      fetch(input, { ...init, redirect: "error" })) as typeof fetch,
  };
  if (p.kind === "anthropic") return createAnthropic(opts)(agent.model);
  if (p.kind === "google") return createGoogle(opts)(agent.model);
  if (p.kind === "openai") return createOpenAI(opts).chat(agent.model);
  return createOpenAICompatible({ ...opts, name: p.id }).chatModel(agent.model);
}
export function defaultAgentsWithModels(workspaceId: string, agents: Agent[]) {
  const models = listModels(workspaceId);
  return agents.map((agent) => {
    const family =
      agent.id === "gpt" ? "GPT" : agent.id === "claude" ? "Claude" : "Gemini";
    const candidates = models.filter((m) => m.family === family);
    const preferredIds =
      family === "GPT"
        ? ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-sol"]
        : family === "Claude"
          ? [
              "claude-haiku-5-5",
              "claude-sonnet-5-5",
              "claude-haiku-4-5-20251001",
            ]
          : ["gemini-3.5-flash", "gemini-3.1-flash", "gemini-2.5-flash"];
    const preferred =
      preferredIds
        .map((id) => candidates.find((m) => m.id === id))
        .find(Boolean) ||
      candidates.find((m) => /mini|haiku|flash|luna/i.test(m.id)) ||
      candidates[0];
    return preferred
      ? { ...agent, model: preferred.id, provider: preferred.provider }
      : { ...agent, enabled: false };
  });
}
