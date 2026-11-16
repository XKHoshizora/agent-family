import type { AgentRow } from "../agents/store.ts";
import { REASONING_LEVELS, type Config, type ReasoningLevel } from "../config.ts";
import type { Queryable } from "../db.ts";
import { loadProviderForCall } from "../providers/store.ts";
import type { ModelCall } from "./gateway.ts";

/** An Agent's model, ready to call: where and how, what it can take, and (site models) what it costs. */
export interface Resolved {
  source: "site" | "provider";
  /** What usage records (and `GET /api/usage`) call the model: a site model's id, a provider model's name. */
  name: string;
  /** Everything of a `ModelCall` that comes from the model, the key in plaintext included: hand it to the gateway only. */
  call: Omit<ModelCall, "system" | "messages" | "signal" | "reasoning">;
  contextTokens: number;
  vision: boolean;
  pdf: boolean;
  /** The levels the model takes, `none` always among them; the call is sent `none` for any other. */
  reasoningAllowed: readonly ReasoningLevel[];
  /** Site models only. */
  price?: { inputMicroPerToken: number; outputMicroPerToken: number };
  tier?: "free" | "paid";
}

/**
 * The Agent's model (or, for a persona draft, the model its owner chose) as something to call, or null when there is
 * none to call: no model chosen, a site model that is
 * no longer configured or whose key variable is unset, a provider that is not (or no longer) the owner's, or a model
 * no longer on its list. A site model's upstream key is read from `process.env[apiKeyEnv]` now (configuration never
 * holds it); a provider's key is opened from the database (`loadProviderForCall`, which throws `KeyUnreadableError`
 * when `PROVIDER_KEY_SECRET` changed). Site and provider models share everything after this.
 */
export async function resolveModel(
  q: Queryable,
  config: Pick<Config, "siteModels" | "providerKeySecret" | "providerDefaultMaxOutputTokens">,
  agent: Pick<AgentRow, "model" | "ownerId">,
): Promise<Resolved | null> {
  const choice = agent.model;
  if (choice === null) return null;

  if (choice.source === "site") {
    const site = config.siteModels.find((m) => m.id === choice.id);
    const apiKey = site ? process.env[site.apiKeyEnv] : undefined;
    if (!site || apiKey === undefined || apiKey === "") return null;
    return {
      source: "site",
      name: site.id,
      call: { protocol: site.protocol, baseUrl: site.baseUrl, apiKey, model: site.model, maxOutputTokens: site.maxOutputTokens },
      contextTokens: site.contextTokens,
      vision: site.vision,
      pdf: site.pdf,
      reasoningAllowed: REASONING_LEVELS.filter((level) => level === "none" || site.reasoning.includes(level)),
      price: { inputMicroPerToken: site.inputMicroPerToken, outputMicroPerToken: site.outputMicroPerToken },
      tier: site.tier,
    };
  }

  const provider = await loadProviderForCall(q, agent.ownerId, choice.providerId, config.providerKeySecret);
  const listed = provider?.models.find((m) => m.name === choice.model);
  if (!provider || !listed) return null;
  return {
    source: "provider",
    name: listed.name,
    call: { protocol: provider.protocol, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: listed.name, maxOutputTokens: config.providerDefaultMaxOutputTokens },
    contextTokens: listed.contextTokens,
    vision: listed.vision,
    pdf: listed.pdf,
    reasoningAllowed: listed.reasoning ? [...REASONING_LEVELS] : ["none"],
  };
}
