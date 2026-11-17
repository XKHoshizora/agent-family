import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { PROTOCOLS, type Protocol } from "../config.ts";
import { notFound } from "../errors.ts";
import { perPrincipalLimit, type PrincipalLimit } from "../limits.ts";
import { uuidParam, userText } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { normaliseBaseUrl } from "./guard.ts";
import { toProviderCallError, type ProviderCallCode, type ProviderCallError } from "./probe.ts";
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

/** How many entries of a provider's model list a refresh looks at (and so at most returns as `listed`). */
export const MAX_LISTED_NAMES = 1_000;

// --- the routes ---------------------------------------------------------------------------------------------------

const empty = z.object({});
/** A route without fields takes no body, `{}` or `null`; anything else (an array, a string, text) is a 400. */
const noBody = empty.nullish();
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
 * `allowInsecureLocal` (tests only, `BuildOptions`) also lets a baseUrl be `http:`. `readLimit`: the budget
 * `GET /api/providers` shares with the owner's other reads of their Agents and replies.
 */
export function registerProviderRoutes(
  app: FastifyInstance,
  { allowInsecureLocal, readLimit }: { allowInsecureLocal: boolean; readLimit: PrincipalLimit },
): void {
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
      await readLimit(req, me.id);
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
    { schema: { params: idParams, querystring: empty, body: noBody, response: { 200: z.object({ ok: z.literal(true) }) } } },
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
        body: noBody,
        response: {
          200: z.union([
            z.object({ ok: z.literal(true) }),
            z.object({
              ok: z.literal(false),
              error: z.enum(["provider_rejected", "provider_unavailable", "address_not_allowed"]),
              upstreamStatus: z.string().optional(),
            }),
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
        // The provider's HTTP status, the number only (a 404 or 405: it has no model list, though chat may work).
        const status = failure.upstreamStatus === undefined ? {} : { upstreamStatus: String(failure.upstreamStatus) };
        return { ok: false as const, error: failure.code as ProviderCallCode, ...status };
      }
    },
  );

  api.post(
    "/api/providers/:id/models/refresh",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: noBody,
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
      // Only the first MAX_LISTED_NAMES entries are looked at (the list is the upstream's, of any length within the
      // guard's size limit); of those, names a person could have typed, each once, and never one that holds the key.
      const seen = new Set<string>();
      for (const raw of names.slice(0, MAX_LISTED_NAMES)) {
        const parsed = modelName.safeParse(raw);
        if (parsed.success && !parsed.data.includes(target.apiKey)) seen.add(parsed.data);
      }
      const listed = [...seen];
      const provider = await db.tx((t) => mergeListedModels(t, me.id, req.params.id, listed, config.providerDefaultContextTokens));
      return { listed, provider: toView(provider) };
    },
  );
}
