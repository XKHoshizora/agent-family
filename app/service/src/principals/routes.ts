import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { isMissingBlob, newBlobKey } from "../attachments/blob.ts";
import { sniff } from "../attachments/sniff.ts";
import { AppError } from "../errors.ts";
import { requirePrincipal } from "../session.ts";
import { defaultAvatarSvg } from "./avatar.ts";
import { findAvatarSubject, findByHandle, swapAvatarKey, updateDisplayName } from "./store.ts";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SNIFF_BYTES = 4100;

const displayName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((s) => !/\p{Cc}/u.test(s), "no control characters");

const publicPrincipal = z.object({ id: z.string(), handle: z.string(), displayName: z.string() });

const AVATAR_HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "private, max-age=60",
  "content-security-policy": "default-src 'none'; sandbox",
} as const;

async function readAll(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

export function registerPrincipalRoutes(app: FastifyInstance): void {
  const { db, config, blobs } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  // Handle lookup is the only way to probe for handles, so it is throttled per principal.
  const lookupActors = new WeakMap<FastifyRequest, string>();
  const lookupLimit = app.createRateLimit({
    max: Math.max(1, Math.round(30 * config.rateLimitScale)),
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => lookupActors.get(req) ?? req.ip,
  });

  api.patch(
    "/api/me",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({}),
        body: z.object({ displayName }),
        response: { 200: publicPrincipal },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await updateDisplayName(db, me.id, req.body.displayName);
      return { id: me.id, handle: me.handle, displayName: req.body.displayName };
    },
  );

  api.get(
    "/api/principals/lookup",
    {
      schema: {
        params: z.object({}),
        querystring: z.object({
          handle: z
            .string()
            .max(100)
            .transform((s) => s.toLowerCase())
            .pipe(z.string().regex(/^[a-z0-9_]{3,24}$/)),
        }),
        response: { 200: publicPrincipal },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      lookupActors.set(req, me.id);
      const limited = await lookupLimit(req);
      if ("isExceeded" in limited && limited.isExceeded) throw new AppError(429, "rate_limited");
      const found = await findByHandle(db, req.query.handle);
      if (!found) throw new AppError(404, "not_found");
      return found;
    },
  );

  api.get(
    "/api/principals/:id/avatar",
    { schema: { params: z.object({ id: z.uuid() }), querystring: z.object({}) } },
    async (req, reply) => {
      await requirePrincipal(req);
      const subject = await findAvatarSubject(db, req.params.id);
      if (!subject) throw new AppError(404, "not_found");

      reply.headers(AVATAR_HEADERS);
      if (subject.avatarKey) {
        try {
          const bytes = await readAll(await blobs.get(subject.avatarKey));
          const { mime, inline } = await sniff(bytes.subarray(0, SNIFF_BYTES));
          if (inline) return reply.type(mime).send(bytes);
        } catch (err) {
          if (!isMissingBlob(err)) throw err;
        }
      }
      return reply.type("image/svg+xml").send(defaultAvatarSvg(subject.displayName, subject.id));
    },
  );

  // Raw image bodies live in their own encapsulated scope so the 2 MB cap and the pass-through parser
  // apply to this route only. Fastify enforces the cap while the body streams in.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      /^(image\/[\w.+-]+|application\/octet-stream)$/i,
      { parseAs: "buffer", bodyLimit: AVATAR_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    scope.withTypeProvider<ZodTypeProvider>().put(
      "/api/me/avatar",
      {
        bodyLimit: AVATAR_MAX_BYTES,
        schema: {
          params: z.object({}),
          querystring: z.object({}),
          body: z.instanceof(Buffer),
          response: { 200: z.object({ ok: z.literal(true) }) },
        },
      },
      async (req) => {
        const me = await requirePrincipal(req);
        const body = req.body;
        // The declared Content-Type and any file name are ignored: only the bytes decide.
        const { mime } = await sniff(body.subarray(0, SNIFF_BYTES));
        if (!AVATAR_MIMES.has(mime)) throw new AppError(400, "invalid_request");

        const key = newBlobKey("avatar");
        await blobs.put(key, body);
        let previous: string | null;
        try {
          previous = await db.tx((client) => swapAvatarKey(client, me.id, key));
        } catch (err) {
          await blobs.delete(key).catch(() => {});
          throw err;
        }
        if (previous) await blobs.delete(previous).catch(() => {});
        return { ok: true as const };
      },
    );
  });
}
