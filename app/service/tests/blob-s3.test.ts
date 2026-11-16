import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createBlobStore, fsBlobStore, s3BlobStore } from "../src/attachments/blob.ts";
import { loadConfig } from "../src/config.ts";
import { sniff } from "../src/attachments/sniff.ts";

// A real S3Client whose requests are intercepted before serialisation, so nothing leaves the process.
// This checks key handling and config wiring only. It is NOT a test against a real bucket.
function fakeClient() {
  const commands: { name: string; input: any }[] = [];
  const client = new S3Client({
    region: "r",
    endpoint: "http://s3.test",
    credentials: { accessKeyId: "k", secretAccessKey: "s" },
  });
  client.middlewareStack.add(
    (_next, context) => async (args) => {
      const name = String(context.commandName);
      commands.push({ name, input: args.input });
      return { output: name === "GetObjectCommand" ? { Body: Readable.from([Buffer.from("hi")]) } : {} } as any;
    },
    { step: "initialize", name: "captureOnly" },
  );
  return { client, commands };
}

const cfg = { endpoint: "http://s3.test", region: "r", bucket: "bkt", accessKeyId: "k", secretAccessKey: "s" };

describe("s3BlobStore (fake client)", () => {
  it("uses the configured bucket and the server-generated key, and counts bytes", async () => {
    const { client, commands } = fakeClient();
    const store = s3BlobStore(cfg, client);
    expect(await store.put("avatar-abc", Buffer.from("12345"))).toEqual({ size: 5 });
    await store.get("avatar-abc");
    await store.delete("avatar-abc");
    expect(commands.map((c) => [c.name, c.input.Bucket, c.input.Key])).toEqual([
      ["PutObjectCommand", "bkt", "avatar-abc"],
      ["GetObjectCommand", "bkt", "avatar-abc"],
      ["DeleteObjectCommand", "bkt", "avatar-abc"],
    ]);
  });

  it("rejects keys with path segments before talking to S3", async () => {
    const { client, commands } = fakeClient();
    const store = s3BlobStore(cfg, client);
    await expect(store.get("../x")).rejects.toThrow("invalid blob key");
    await expect(store.delete("a/b")).rejects.toThrow("invalid blob key");
    expect(commands).toHaveLength(0);
  });
});

describe("blob store selection", () => {
  const base = { DATABASE_URL: "postgres://x", APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "x".repeat(32), PROVIDER_KEY_SECRET: "p".repeat(32) };
  it("uses the filesystem unless S3 is configured", () => {
    expect(typeof createBlobStore(loadConfig({ ...base, BLOB_DIR: "./tmp-blobs" })).put).toBe("function");
    expect(loadConfig({ ...base }).s3).toBeUndefined();
    const withS3 = loadConfig({
      ...base,
      S3_ENDPOINT: "http://s3.test",
      S3_REGION: "r",
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
    });
    expect(withS3.s3?.bucket).toBe("b");
    expect(fsBlobStore).toBeTypeOf("function");
  });
});

describe("sniff", () => {
  it("trusts bytes only", async () => {
    expect(await sniff(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"))).toEqual({ mime: "image/png", inline: true });
    expect(await sniff(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;"))).toEqual({ mime: "image/gif", inline: true });
    expect(await sniff(Buffer.from("<html><script>"))).toEqual({ mime: "application/octet-stream", inline: false });
    expect(await sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({
      mime: "application/octet-stream",
      inline: false,
    });
    expect(await sniff(Buffer.alloc(0))).toEqual({ mime: "application/octet-stream", inline: false });
  });
});
