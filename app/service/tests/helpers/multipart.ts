import type { FastifyInstance } from "fastify";
import http from "node:http";
import { listen } from "./ws.ts";

export const BOUNDARY = "----af-test-boundary-7d1f0c";
export const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;

export interface Part {
  name: string;
  /** Omitted: the part is a plain field (unless `type` is application/octet-stream). */
  filename?: string;
  type?: string;
  data: Buffer | string;
}

/** The head of one part, written as a browser does: header values as raw UTF-8. */
export function partHead(p: Omit<Part, "data">): string {
  const disposition = `form-data; name="${p.name}"` + (p.filename === undefined ? "" : `; filename="${p.filename}"`);
  return `--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n` + (p.type ? `Content-Type: ${p.type}\r\n` : "") + "\r\n";
}

export const CLOSING = `\r\n--${BOUNDARY}--\r\n`;

/** A complete multipart/form-data body. */
export function multipart(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  parts.forEach((p, i) => {
    chunks.push(Buffer.from((i === 0 ? "" : "\r\n") + partHead(p), "utf8"));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data, "utf8"));
  });
  chunks.push(Buffer.from(parts.length === 0 ? `--${BOUNDARY}--\r\n` : CLOSING));
  return Buffer.concat(chunks);
}

/** A real HTTP request (over a listening port) whose body the test writes piece by piece. */
export interface OpenRequest {
  /** Resolves with the response as soon as it arrives, possibly before the body is finished. */
  response: Promise<{ status: number; body: string }>;
  write(chunk: Buffer | string): Promise<void>;
  /** Writes `n` filler bytes in 256 KB pieces, waiting for each to be flushed. */
  fill(n: number): Promise<void>;
  /** Ends the request body. */
  end(): Promise<void>;
  /** Drops the connection. */
  destroy(): void;
}

const FILLER = Buffer.alloc(256 * 1024, 0x61);

const openRequests = new Set<OpenRequest>();

/** Drops every request `openRequest` opened that is still around (call from afterEach). */
export function destroyOpenRequests(): void {
  for (const r of [...openRequests]) r.destroy();
}

export async function openRequest(
  app: FastifyInstance,
  {
    path,
    cookie,
    contentType = MULTIPART,
    method = "POST",
  }: { path: string; cookie: string; contentType?: string; method?: "POST" | "PUT" },
): Promise<OpenRequest> {
  const { port } = await listen(app);
  // Keep-alive, as a browser: the server can then answer early and drain the rest of the body.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const req = http.request({
    host: "127.0.0.1",
    port,
    method,
    path,
    agent,
    headers: { cookie, "content-type": contentType, "transfer-encoding": "chunked" },
  });
  req.on("error", () => {}); // a reset after the answer is reported through `response`, if at all
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.once("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
  });
  response.catch(() => {}); // a test that drops the connection never asks for the answer

  const write = (chunk: Buffer | string) =>
    new Promise<void>((resolve, reject) => req.write(chunk, (err) => (err ? reject(err) : resolve())));
  const open: OpenRequest = {
    response,
    write,
    async fill(n) {
      for (let left = n; left > 0; left -= FILLER.length) await write(FILLER.subarray(0, Math.min(left, FILLER.length)));
    },
    end: () =>
      new Promise<void>((resolve) => {
        req.end(() => {
          // Release the kept-alive connection once the answer is in as well.
          const close = () => agent.destroy();
          response.then(close, close);
          resolve();
        });
      }),
    destroy() {
      openRequests.delete(open);
      req.destroy();
      agent.destroy();
    },
  };
  openRequests.add(open);
  return open;
}
