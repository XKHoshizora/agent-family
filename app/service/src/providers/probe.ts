import type { Protocol } from "../config.ts";
import { AppError } from "../errors.ts";

/**
 * Talking to a provider without generating anything: the connection test and the model list. Used by the provider
 * routes (`Deps.providerProbe`) and by the model gateway's `listModels`.
 */

/** What a call to a provider needs. */
export interface ProbeTarget {
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
}

/** The two calls the provider routes make upstream (`Deps.providerProbe`). */
export interface ProviderProbe {
  /** Resolves when the provider accepts the key; otherwise throws a `ProviderCallError`. */
  test(p: ProbeTarget): Promise<void>;
  /** The model names the provider's list endpoint gives; throws a `ProviderCallError`. */
  listModels(p: ProbeTarget): Promise<string[]>;
}

export type ProviderCallCode = "provider_rejected" | "provider_unavailable" | "address_not_allowed";

/** A failed call to a provider: a code for the owner and, for the log only, the upstream's HTTP status. */
export class ProviderCallError extends AppError {
  constructor(
    code: ProviderCallCode,
    readonly upstreamStatus?: number,
  ) {
    super(code === "address_not_allowed" ? 400 : 502, code);
  }
}

/** Any failure as a `ProviderCallError`: the guard's refusal keeps its code, anything else is `provider_unavailable`. */
export function toProviderCallError(err: unknown): ProviderCallError {
  if (err instanceof ProviderCallError) return err;
  if (err instanceof AppError && err.code === "address_not_allowed") return new ProviderCallError("address_not_allowed");
  return new ProviderCallError("provider_unavailable");
}

/** The guard a probe goes through (`guardedFetch` options): a model list is small, and an upstream that stalls is given up on. */
export const PROBE_GUARD = { maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 15_000 } as const;

/** Every probe request ends within this long, whatever the upstream does. */
const PROBE_DEADLINE_MS = 30_000;
const ANTHROPIC_VERSION = "2023-06-01";

/** The protocol's way of presenting the key. */
function keyHeaders(p: ProbeTarget): Record<string, string> {
  if (p.protocol === "anthropic") return { "x-api-key": p.apiKey, "anthropic-version": ANTHROPIC_VERSION };
  if (p.protocol === "gemini") return { "x-goog-api-key": p.apiKey };
  return { authorization: `Bearer ${p.apiKey}` };
}

/** The names in a model list: `data[].id` (OpenAI, Anthropic) or `models[].name` without `models/` (Gemini). */
function namesIn(protocol: Protocol, json: unknown): unknown[] {
  const field = protocol === "gemini" ? "models" : "data";
  const list = (json as Record<string, unknown> | null)?.[field];
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const value = (entry as Record<string, unknown> | null)?.[protocol === "gemini" ? "name" : "id"];
    return protocol === "gemini" && typeof value === "string" ? value.replace(/^models\//, "") : value;
  });
}

/**
 * The default probe: one authenticated `GET {baseUrl}/models` in the protocol's own headers, through `fetch`
 * (always a `guardedFetch`). 401/403 → `provider_rejected`; anything but a 200 with JSON → `provider_unavailable`;
 * the guard's refusal → `address_not_allowed`. Nothing of the answer but the parsed names is kept.
 */
export function createProviderProbe(fetch: typeof globalThis.fetch): ProviderProbe {
  async function listing(p: ProbeTarget): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${p.baseUrl}/models`, {
        method: "GET",
        headers: { accept: "application/json", ...keyHeaders(p) },
        signal: AbortSignal.timeout(PROBE_DEADLINE_MS),
      });
    } catch (err) {
      throw toProviderCallError(err);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderCallError(res.status === 401 || res.status === 403 ? "provider_rejected" : "provider_unavailable", res.status);
    }
    try {
      return JSON.parse(await res.text());
    } catch {
      throw new ProviderCallError("provider_unavailable", res.status);
    }
  }
  return {
    async test(p) {
      await listing(p);
    },
    async listModels(p) {
      return namesIn(p.protocol, await listing(p)).filter((n): n is string => typeof n === "string");
    },
  };
}
