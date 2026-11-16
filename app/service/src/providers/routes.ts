import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { PROTOCOLS, type Protocol } from "../config.ts";
import { AppError, notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { uuidParam, userText } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { normaliseBaseUrl } from "./guard.ts";
import {
  CONTEXT_TOKENS,
  MAX_MODELS,
  createProvider,
  deleteProvider,
  listProviders,
  loadProviderForCall,
  mergeListedModels,
  modelName,
  updateProvider,
  type ProviderModel,
  type ProviderRow,
} from "./store.ts";

// --- talking to a provider without the model gateway ---------------------------------------------------------------

/** What a call to a provider needs. */
export interface ProbeTarget {
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
}

/** The two calls the provider routes make upstream (`Deps.providerProbe`); the model gateway may stand in for it. */
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

// --- the routes ---------------------------------------------------------------------------------------------------

const empty = z.object({});
const idParams = z.object({ id: uuidParam });

const providerName = userText(1, 40, { singleLine: true });
/** An API key as pasted: trimmed, then 8–1000 printable ASCII characters without spaces (it goes into a header). */
const apiKey = z
  .string()
  .trim()
  .regex(/^[\x21-\x7e]{8,1000}$/);
const modelInput = z.strictObject({
  name: modelName,
  vision: z.boolean().optional(),
  pdf: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  contextTokens: z.number().int().min(CONTEXT_TOKENS.min).max(CONTEXT_TOKENS.max).optional(),
});
const modelList = z
  .array(modelInput)
  .max(MAX_MODELS)
  .refine((list) => new Set(list.map((m) => m.name)).size === list.length, "model names must be unique");

const modelView = z.object({ name: z.string(), vision: z.boolean(), pdf: z.boolean(), reasoning: z.boolean(), contextTokens: z.number() });
const providerView = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.string(),
  keyLast4: z.string(),
  models: z.array(modelView),
});

/** A provider as its owner sees it. */
const toView = (p: ProviderRow): z.infer<typeof providerView> => ({
  id: p.id,
  name: p.name,
  protocol: p.protocol,
  baseUrl: p.baseUrl,
  keyLast4: p.keyLast4,
  models: p.models.map((m) => ({ name: m.name, vision: m.vision, pdf: m.pdf, reasoning: m.reasoning, contextTokens: m.contextTokens })),
});

/**
 * Every route here is the owner's: anyone else's provider id, and an id that is no provider, get the same 404.
 * `allowInsecureLocal` (tests only, `BuildOptions`) also lets a baseUrl be `http:`.
 */
export function registerProviderRoutes(app: FastifyInstance, { allowInsecureLocal }: { allowInsecureLocal: boolean }): void {
  const { db, config, providerProbe } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const secret = config.providerKeySecret;

  // Create, edit and delete share one budget; the two routes that call the provider share another.
  const writeLimit = perPrincipalLimit(app, 20);
  const callLimit = perPrincipalLimit(app, 10);

  const baseUrl = z
    .string()
    .max(1000)
    .transform((raw, ctx) => {
      const normalised = normaliseBaseUrl(raw, allowInsecureLocal);
      if (normalised === null) {
        ctx.addIssue({ code: "custom", message: "not an https URL a provider can have" });
        return z.NEVER;
      }
      return normalised;
    });
  /** Models as given, with the conservative defaults filled in. */
  const withDefaults = (list: z.infer<typeof modelList>): ProviderModel[] =>
    list.map((m) => ({
      name: m.name,
      vision: m.vision ?? false,
      pdf: m.pdf ?? false,
      reasoning: m.reasoning ?? false,
      contextTokens: m.contextTokens ?? config.providerDefaultContextTokens,
    }));

  /** Logs a failed provider call with what may be logged: never the key, the upstream's body or its headers. */
  const logFailure = (log: FastifyBaseLogger, providerId: string, protocol: Protocol, err: ProviderCallError) =>
    log.info({ providerId, protocol, error: err.code, upstreamStatus: err.upstreamStatus }, "provider call failed");

  api.post(
    "/api/providers",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.strictObject({ name: providerName, protocol: z.enum(PROTOCOLS), baseUrl, apiKey, models: modelList.optional() }),
        response: { 201: providerView },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const b = req.body;
      const created = await db.tx((t) =>
        createProvider(t, me.id, { name: b.name, protocol: b.protocol, baseUrl: b.baseUrl, apiKey: b.apiKey, models: withDefaults(b.models ?? []) }, secret),
      );
      return reply.code(201).send(toView(created));
    },
  );

  api.get(
    "/api/providers",
    { schema: { params: empty, querystring: empty, response: { 200: z.object({ providers: z.array(providerView) }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      return { providers: (await listProviders(db, me.id)).map(toView) };
    },
  );

  api.patch(
    "/api/providers/:id",
    {
      schema: {
        params: idParams,
        querystring: empty,
        // Strict: the protocol never changes, so naming it (or anything else) is a 400.
        body: z.strictObject({ name: providerName.optional(), baseUrl: baseUrl.optional(), apiKey: apiKey.optional(), models: modelList.optional() }),
        response: { 200: providerView },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const b = req.body;
      const updated = await db.tx((t) =>
        updateProvider(
          t,
          me.id,
          req.params.id,
          {
            ...(b.name === undefined ? {} : { name: b.name }),
            ...(b.baseUrl === undefined ? {} : { baseUrl: b.baseUrl }),
            ...(b.apiKey === undefined ? {} : { apiKey: b.apiKey }),
            ...(b.models === undefined ? {} : { models: withDefaults(b.models) }),
          },
          secret,
        ),
      );
      return toView(updated);
    },
  );

  api.delete(
    "/api/providers/:id",
    { schema: { params: idParams, querystring: empty, response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      await db.tx((t) => deleteProvider(t, me.id, req.params.id));
      return { ok: true as const };
    },
  );

  api.post(
    "/api/providers/:id/test",
    {
      schema: {
        params: idParams,
        querystring: empty,
        response: {
          200: z.union([
            z.object({ ok: z.literal(true) }),
            z.object({ ok: z.literal(false), error: z.enum(["provider_rejected", "provider_unavailable", "address_not_allowed"]) }),
          ]),
        },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await callLimit(req, me.id);
      const target = await loadProviderForCall(db, me.id, req.params.id, secret);
      if (!target) throw notFound();
      try {
        await providerProbe.test(target);
        return { ok: true as const };
      } catch (err) {
        const failure = toProviderCallError(err);
        logFailure(req.log, req.params.id, target.protocol, failure);
        return { ok: false as const, error: failure.code as ProviderCallCode };
      }
    },
  );

  api.post(
    "/api/providers/:id/models/refresh",
    {
      schema: {
        params: idParams,
        querystring: empty,
        response: { 200: z.object({ listed: z.array(z.string()), provider: providerView }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await callLimit(req, me.id);
      const target = await loadProviderForCall(db, me.id, req.params.id, secret);
      if (!target) throw notFound();
      let names: string[];
      try {
        names = await providerProbe.listModels(target);
      } catch (err) {
        const failure = toProviderCallError(err);
        logFailure(req.log, req.params.id, target.protocol, failure);
        throw failure;
      }
      // Only names a person could have typed, each once, and never one that holds the key (an upstream that echoes it).
      const listed: string[] = [];
      for (const raw of names) {
        const parsed = modelName.safeParse(raw);
        if (parsed.success && !listed.includes(parsed.data) && !parsed.data.includes(target.apiKey)) listed.push(parsed.data);
      }
      const provider = await db.tx((t) => mergeListedModels(t, me.id, req.params.id, listed, config.providerDefaultContextTokens));
      return { listed, provider: toView(provider) };
    },
  );
}
