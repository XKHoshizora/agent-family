import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fsBlobStore } from "../src/attachments/blob.ts";
import { befriend, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

const blobDir = mkdtempSync(path.join(tmpdir(), "af-att-rl-"));
afterAll(() => rmSync(blobDir, { recursive: true, force: true }));

// Scale 0.25: 60 × 0.25 = 15 uploads per hour per principal (and enough sign-ups for two people).
const { app } = useApp({ blobs: fsBlobStore(blobDir), env: { RATE_LIMIT_SCALE: "0.25" } });

const upload = async (who: Actor, conv: string) => {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename: "a.txt", type: "text/plain", data: "hello" }]),
  });
  return { status: res.statusCode, json: JSON.parse(res.body) };
};

describe("upload rate limit", () => {
  it("allows 60 × RATE_LIMIT_SCALE uploads per hour per principal, then 429 rate_limited; the other party is unaffected", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    for (let i = 1; i <= 15; i++) expect((await upload(a, dm)).status).toBe(201);
    expect(await upload(a, dm)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect((await upload(b, dm)).status).toBe(201);
  });
});
