import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { newBlobKey } from "../attachments/blob.ts";
import { discardBlob, holdBlob, releaseBlob } from "../attachments/pending.ts";
import { sniff } from "../attachments/sniff.ts";
import { liftBodyDeadline } from "../body-deadline.ts";
import type { Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { requirePrincipal } from "../session.ts";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const SNIFF_BYTES = 4100;

/**
 * Registers a raw-image `PUT` (the rules of `PUT /api/me/avatar`) in its own encapsulated scope, so the 2 MB
 * cap and the pass-through parser apply to this route only. Fastify enforces the cap while the body streams in.
 * `handle` runs after the body is in: it checks who may do this (and any rate limit) and calls `storeAvatar`.
 */
export function registerAvatarPut(
  app: FastifyInstance,
  url: string,
  params: z.ZodType,
  handle: (req: FastifyRequest, body: Buffer) => Promise<void>,
): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      /^(image\/[\w.+-]+|application\/octet-stream)$/i,
      { parseAs: "buffer", bodyLimit: AVATAR_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    scope.withTypeProvider<ZodTypeProvider>().put(
      url,
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
          params,
          querystring: z.object({}),
          body: z.instanceof(Buffer),
          response: { 200: z.object({ ok: z.literal(true) }) },
        },
      },
      async (req) => {
        await handle(req, req.body);
        return { ok: true as const };
      },
    );
  });
}

/**
 * Stores `body` as the avatar of the principal `swap` changes. The declared Content-Type and any file name are
 * ignored: only the bytes decide (400 `invalid_request` unless PNG, JPEG or WebP). `swap` runs in the
 * transaction that commits the change: it locks what it must and returns `swapAvatarKey`'s previous key.
 */
export async function storeAvatar(
  app: FastifyInstance,
  log: FastifyRequest["log"],
  body: Buffer,
  swap: (t: Tx, newKey: string) => Promise<string | null>,
): Promise<void> {
  const { db, blobs } = app.deps;
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
      const old = await swap(t, key);
      await releaseBlob(t, key);
      if (old) await holdBlob(t, old);
      return old;
    });
  } catch (err) {
    await discardBlob({ db, blobs }, key, log);
    throw err;
  }
  if (previous) await discardBlob({ db, blobs }, previous, log);
}
