import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { displayName, uuidParam } from "../schemas.ts";
import { isMissingBlob, newBlobKey } from "../attachments/blob.ts";
import { discardBlob, holdBlob, releaseBlob } from "../attachments/pending.ts";
import { sniff } from "../attachments/sniff.ts";
import { liftBodyDeadline } from "../body-deadline.ts";
import { AppError } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { requirePrincipal } from "../session.ts";
import { defaultAvatarSvg } from "./avatar.ts";
import { findAvatarSubject, findByHandle, swapAvatarKey, updateDisplayName } from "./store.ts";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SNIFF_BYTES = 4100;

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

/** The first `max` bytes (fewer if the stream is shorter); the rest is never pulled and the stream is closed. */
async function readPrefix(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for await (const c of stream as AsyncIterable<Buffer>) {
      chunks.push(c);
      n += c.length;
      if (n >= max) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, max);
}

export function registerPrincipalRoutes(app: FastifyInstance): void {
  const { db, blobs } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  // Handle lookup is the only way to probe for handles, so it is throttled per principal.
  const lookupLimit = perPrincipalLimit(app, 30);
  // Others see both everywhere (and every avatar is a blob write): 10 changes a minute each.
  const renameLimit = perPrincipalLimit(app, 10);
  const avatarLimit = perPrincipalLimit(app, 10);

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
      await renameLimit(req, me.id);
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
      await lookupLimit(req, me.id);
      const found = await findByHandle(db, req.query.handle);
      if (!found) throw new AppError(404, "not_found");
      return found;
    },
  );

  const avatarSchema = { params: z.object({ id: uuidParam }), querystring: z.object({}) };

  /**
   * What `GET`/`HEAD /api/principals/:id/avatar` answer with: the stored image (its type from the bytes,
   * only when browsers may show it) or the generated SVG. `whole: false` reads no more than the sniffing
   * prefix of a stored image, so a HEAD does not drain the blob.
   */
  async function avatarOf(
    req: FastifyRequest<{ Params: { id: string } }>,
    whole: boolean,
  ): Promise<{ type: string; body: Buffer | string; complete: boolean }> {
    await requirePrincipal(req);
    const subject = await findAvatarSubject(db, req.params.id);
    if (!subject) throw new AppError(404, "not_found");
    if (subject.avatarKey) {
      try {
        const stream = await blobs.get(subject.avatarKey);
        const bytes = whole ? await readAll(stream) : await readPrefix(stream, SNIFF_BYTES);
        const { mime, inline } = await sniff(bytes.subarray(0, SNIFF_BYTES));
        if (inline) return { type: mime, body: bytes, complete: whole };
      } catch (err) {
        if (!isMissingBlob(err)) throw err;
      }
    }
    return { type: "image/svg+xml", body: defaultAvatarSvg(subject.displayName, subject.id), complete: true };
  }

  // Declared before the GET, so Fastify does not derive a HEAD from it (that one would read the whole blob).
  // The same decision and headers; of a stored image only the first bytes are read, so there is no
  // `Content-Length` for it (the generated SVG has one).
  app.withTypeProvider<ZodTypeProvider>().head("/api/principals/:id/avatar", { schema: avatarSchema }, async (req, reply) => {
    const found = await avatarOf(req, false);
    reply.headers(AVATAR_HEADERS).type(found.type);
    if (found.complete) reply.header("content-length", String(Buffer.byteLength(found.body)));
    return reply.send();
  });

  api.get("/api/principals/:id/avatar", { schema: avatarSchema }, async (req, reply) => {
    const found = await avatarOf(req, true);
    return reply.headers(AVATAR_HEADERS).type(found.type).send(found.body);
  });

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
        // Up to 2 MiB from a slow connection may take long: a signed-in person's upload is governed by the
        // server-wide timeouts, not the body deadline (body-deadline.ts). Anyone else's body stays under it; the
        // handler still gives every answer (the order of checks is unchanged).
        preParsing: async (req) => {
          try {
            await requirePrincipal(req);
            liftBodyDeadline(req);
          } catch {
            // Not signed in (or the session could not be checked now): the body deadline stays.
          }
        },
        schema: {
          params: z.object({}),
          querystring: z.object({}),
          body: z.instanceof(Buffer),
          response: { 200: z.object({ ok: z.literal(true) }) },
        },
      },
      async (req) => {
        const me = await requirePrincipal(req);
        await avatarLimit(req, me.id);
        const body = req.body;
        // The declared Content-Type and any file name are ignored: only the bytes decide.
        const { mime } = await sniff(body.subarray(0, SNIFF_BYTES));
        if (!AVATAR_MIMES.has(mime)) throw new AppError(400, "invalid_request");

        // Every blob that may exist unreferenced is held (attachments/pending.ts): the new one until the
        // swap commits, the replaced one from the swap until it is deleted. The sweep removes leftovers.
        const key = newBlobKey("avatar");
        await holdBlob(db, key);
        let previous: string | null;
        try {
          await blobs.put(key, body);
          previous = await db.tx(async (t) => {
            const old = await swapAvatarKey(t, me.id, key);
            await releaseBlob(t, key);
            if (old) await holdBlob(t, old);
            return old;
          });
        } catch (err) {
          await discardBlob({ db, blobs }, key, req.log);
          throw err;
        }
        if (previous) await discardBlob({ db, blobs }, previous, req.log);
        return { ok: true as const };
      },
    );
  });
}
