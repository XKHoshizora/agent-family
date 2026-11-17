import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { displayName, uuidParam } from "../schemas.ts";
import { isMissingBlob } from "../attachments/blob.ts";
import { sniff } from "../attachments/sniff.ts";
import { AppError } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { requirePrincipal } from "../session.ts";
import { defaultAvatarSvg } from "./avatar.ts";
import { registerAvatarPut, SNIFF_BYTES, storeAvatar } from "./avatar-upload.ts";
import { findAvatarSubject, findByHandle, swapAvatarKey, updateDisplayName } from "./store.ts";

const publicPrincipal = z.object({ id: z.string(), handle: z.string(), displayName: z.string(), avatarVersion: z.number() });

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
      return { id: me.id, handle: me.handle, displayName: req.body.displayName, avatarVersion: me.avatarVersion };
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
   * prefix of a stored image, so a HEAD does not drain the blob. Any person's; an Agent's for its owner only
   * (anybody else: the 404 of an id that is no principal).
   */
  async function avatarOf(
    req: FastifyRequest<{ Params: { id: string } }>,
    whole: boolean,
  ): Promise<{ type: string; body: Buffer | string; complete: boolean }> {
    const me = await requirePrincipal(req);
    const subject = await findAvatarSubject(db, req.params.id, me.id);
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

  registerAvatarPut(app, "/api/me/avatar", z.object({}), async (req, body) => {
    const me = await requirePrincipal(req);
    await avatarLimit(req, me.id);
    await storeAvatar(app, req.log, body, (t, key) => swapAvatarKey(t, me.id, key));
    await app.realtime.pushPrincipalChanged(me.id);
  });
}
