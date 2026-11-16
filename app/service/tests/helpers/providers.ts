import http from "node:http";
import type net from "node:net";
import { afterAll, beforeAll, beforeEach } from "vitest";

/** What the stub answers to one request. */
export interface StubReply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface StubRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * A local stand-in for a model provider (plain HTTP on 127.0.0.1: apps that call it are built with
 * `allowInsecureLocal`). `reply` decides each answer (default: 200 with an OpenAI-style model list) and
 * every request is recorded. Started once per file, reset before each test.
 */
export function useProviderStub() {
  const requests: StubRequest[] = [];
  const state = {
    reply: (_req: StubRequest): StubReply => ({ status: 200, body: JSON.stringify({ data: [{ id: "stub-model" }] }) }),
  };
  let server: http.Server | undefined;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const seen: StubRequest = { method: req.method ?? "", path: req.url ?? "", headers: req.headers };
      requests.push(seen);
      const r = state.reply(seen);
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      res.end(r.body ?? "");
    });
    await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
    port = (server.address() as net.AddressInfo).port;
  });
  beforeEach(() => {
    requests.length = 0;
    state.reply = () => ({ status: 200, body: JSON.stringify({ data: [{ id: "stub-model" }] }) });
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  });

  return {
    /** `http://127.0.0.1:<port>/v1`: a baseUrl that reaches the stub. */
    baseUrl: () => `http://127.0.0.1:${port}/v1`,
    requests,
    /** Sets how the stub answers from now on (until the next test). */
    answer(reply: (req: StubRequest) => StubReply) {
      state.reply = reply;
    },
  };
}

/** A plausible `POST /api/providers` body; `over` replaces fields. */
export function providerBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "My provider",
    protocol: "openai_chat",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test-abcdefgh12345678",
    ...over,
  };
}
