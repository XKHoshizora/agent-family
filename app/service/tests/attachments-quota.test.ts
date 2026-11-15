import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fsBlobStore } from "../src/attachments/blob.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

const blobDir = mkdtempSync(path.join(tmpdir(), "af-att-quota-"));
afterAll(() => rmSync(blobDir, { recursive: true, force: true }));
beforeEach(() => {
  for (const f of readdirSync(blobDir)) rmSync(path.join(blobDir, f), { force: true });
});

const QUOTA = 4096;
const { app, db } = useApp({ blobs: fsBlobStore(blobDir), env: { ATTACHMENT_QUOTA_BYTES: String(QUOTA) } });

const QUOTA_REFUSAL = { error: "too_large", reason: "quota" };
const bytes = (n: number) => Buffer.alloc(n, 0x61);
const upload = async (who: Actor, conv: string, size: number) => {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename: "a.bin", type: "application/octet-stream", data: bytes(size) }]),
  });
  return { status: res.statusCode, json: JSON.parse(res.body) };
};
const stored = async (who: Actor) =>
  Number((await db.query("select coalesce(sum(size), 0) n from attachments where uploader_id = $1", [who.id])).rows[0].n);

describe("storage quota per uploader", () => {
  it("counts every upload, sent or not, across conversations; refuses what would exceed it with 413 quota and leaves no blob", async () => {
    const [a, b, c] = [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const { conversationId: dm } = await befriend(app, a, b);
    const g = await group(app, a, "team", [b, c]);

    const first = await upload(a, dm, 2000);
    expect(first.status).toBe(201);
    const sent = await api(app, a, "POST", `/api/conversations/${dm}/messages`, { attachmentId: first.json.id, clientTxn: "q1" });
    expect(sent.status).toBe(201);
    expect((await upload(a, g, 2000)).status).toBe(201); // 4000 of 4096, in another conversation, unsent
    expect(readdirSync(blobDir)).toHaveLength(2);

    expect(await upload(a, g, 97)).toEqual({ status: 413, json: QUOTA_REFUSAL });
    expect(await upload(a, dm, 97)).toEqual({ status: 413, json: QUOTA_REFUSAL });
    expect(readdirSync(blobDir)).toHaveLength(2); // the refused bytes were deleted
    expect((await upload(a, dm, 96)).status).toBe(201); // exactly full is fine
    expect(await stored(a)).toBe(QUOTA);
    // Full: refused up front, before a byte is stored.
    expect(await upload(a, dm, 1)).toEqual({ status: 413, json: QUOTA_REFUSAL });
    expect(readdirSync(blobDir)).toHaveLength(3);

    // Someone else's quota is their own.
    expect((await upload(b, dm, 4000)).status).toBe(201);
  });

  it("concurrent uploads cannot exceed the quota together", async () => {
    const [a, b, c] = [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const { conversationId: dm } = await befriend(app, a, b);
    const g = await group(app, a, "team", [b, c]);

    const results = await Promise.all([upload(a, dm, 1500), upload(a, g, 1500), upload(a, dm, 1500), upload(a, g, 1500)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 413, 413]);
    expect(results.filter((r) => r.status === 413).every((r) => r.json.reason === "quota")).toBe(true);
    expect(await stored(a)).toBe(3000);
    expect(readdirSync(blobDir)).toHaveLength(2);
  });
});
