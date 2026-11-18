import type { Protocol } from "../config.ts";
import { AppError } from "../errors.ts";
import { DETAIL_BODY_BYTES, readHead, upstreamDetail, type UpstreamDetail } from "./upstream-detail.ts";

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

/**
 * A failed call to a provider: a code for the owner and, for the log only, the upstream's HTTP status. `detail` is what
 * the upstream said (upstream-detail.ts: bounded, cleaned, never a piece of the key), for the provider's owner on
 * `/test` and `/models/list` only: it is held in a private field, so no log line, error body or serialised copy of the
 * error ever carries it.
 */
export class ProviderCallError extends AppError {
  readonly #detail: UpstreamDetail | undefined;

  constructor(
    code: ProviderCallCode,
    readonly upstreamStatus?: number,
    detail?: UpstreamDetail,
  ) {
    super(code === "address_not_allowed" ? 400 : 502, code);
    this.#detail = detail;
  }

  /** What the upstream said, for its owner's `/test` and `/models/list` answers only (never logged). */
  get detail(): UpstreamDetail | undefined {
    return this.#detail;
  }
}

/** Any failure as a `ProviderCallError`: the guard's refusal keeps its code, anything else is `provider_unavailable`. */
export function toProviderCallError(err: unknown): ProviderCallError {
  if (err instanceof ProviderCallError) return err;
  if (err instanceof AppError && err.code === "address_not_allowed") return new ProviderCallError("address_not_allowed");
  return new ProviderCallError("provider_unavailable");
}

/** Whether an upstream's HTTP status says it refused the key (401, 403): `provider_rejected`, the judgement's `auth`. */
export const keyRefused = (status: number): boolean => status === 401 || status === 403;

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
 * the guard's refusal → `address_not_allowed`. Of a failed answer, the first `DETAIL_BODY_BYTES` are read for the
 * error's `detail` (`upstreamDetail`: bounded, cleaned, dropped when it holds a piece of the key) and nothing else kept;
 * of a good one, only the parsed names.
 */
export function createProviderProbe(fetch: typeof globalThis.fetch): ProviderProbe {
  /** The failure for an upstream answer of `status` whose body was `body`. */
  const failed = (p: ProbeTarget, status: number, body: string | null) =>
    new ProviderCallError(keyRefused(status) ? "provider_rejected" : "provider_unavailable", status, upstreamDetail(status, body, p.apiKey));

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
    if (res.status !== 200) throw failed(p, res.status, await readHead(res));
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new ProviderCallError("provider_unavailable", res.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw failed(p, res.status, text.slice(0, DETAIL_BODY_BYTES));
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
