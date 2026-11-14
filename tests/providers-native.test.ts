import { beforeAll, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
vi.hoisted(() => {
  process.env.DATA_DIR = `${process.env.TEMP || "/tmp"}/agent-family-native-test-${process.pid}-${Date.now()}`;
  process.env.CANAL_KEY_FILE = `${process.env.DATA_DIR}/no-key`;
  process.env.CANAL_API_KEY = "";
});
import { generateText } from "ai";
import { db } from "../server/db";
import { saveProvider, modelFor } from "../server/providers";
import type { Agent } from "../shared/types";
beforeAll(() => {
  db.prepare("INSERT INTO workspaces VALUES(?,?,?)").run(
    "native-workspace",
    "Native contract tests",
    new Date().toISOString(),
  );
});
afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
  const target = path.resolve(process.env.DATA_DIR!);
  expect(target.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
  fs.rmSync(target, { recursive: true, force: true });
});
it.each([
  {
    kind: "openai" as const,
    base: "https://api.openai.com/v1",
    model: "gpt-test",
    path: "/v1/chat/completions",
    response: {
      id: "chat-test",
      object: "chat.completion",
      created: 1,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OpenAI adapter works" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    },
    text: "OpenAI adapter works",
    header: "authorization",
  },
  {
    kind: "anthropic" as const,
    base: "https://api.anthropic.com/v1",
    model: "claude-test",
    path: "/v1/messages",
    response: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "Claude adapter works" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 4 },
    },
    text: "Claude adapter works",
    header: "x-api-key",
  },
  {
    kind: "google" as const,
    base: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-test",
    path: "/v1beta/models/gemini-test:generateContent",
    response: {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Gemini adapter works" }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 4,
        totalTokenCount: 7,
      },
      modelVersion: "gemini-test",
    },
    text: "Gemini adapter works",
    header: "x-goog-api-key",
  },
])("uses the native $kind protocol and extracts its answer", async (spec) => {
  const requests: { url: string; headers: Headers; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any) => {
      requests.push({
        url: String(input),
        headers: new Headers(init.headers),
        body: JSON.parse(init.body),
      });
      return new Response(JSON.stringify(spec.response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  saveProvider("native-workspace", {
    id: spec.kind,
    kind: spec.kind,
    baseUrl: spec.base,
    apiKey: "fake-native-contract-key",
    models: [spec.model],
  });
  const agent: Agent = {
    id: "native",
    name: "Native",
    provider: spec.kind,
    model: spec.model,
    persona: "test",
    color: "sage",
    tools: false,
    enabled: true,
  };
  const result = await generateText({
    model: modelFor("native-workspace", agent),
    prompt: "hello",
    maxOutputTokens: 32,
    maxRetries: 0,
  });
  expect(result.text).toBe(spec.text);
  expect(new URL(requests[0].url).pathname).toBe(spec.path);
  expect(requests[0].headers.get(spec.header)).toContain(
    "fake-native-contract-key",
  );
  expect(requests[0].url).not.toContain("fake-native-contract-key");
  expect(result.totalUsage.totalTokens).toBe(7);
});

it("MiniMax compatible requests separate reasoning and preserve its completion budget", async () => {
  let body: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: "mini",
          object: "chat.completion",
          created: 1,
          model: "MiniMax-M3",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "正式回答",
                reasoning_content: "model reasoning",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  saveProvider("native-workspace", {
    id: "mini-test",
    kind: "compatible",
    baseUrl: "https://api.canalapi.com/v1",
    apiKey: "fake-key",
    models: ["MiniMax-M3"],
  });
  const result = await generateText({
    model: modelFor("native-workspace", {
      id: "m",
      name: "MiniMax",
      provider: "mini-test",
      model: "MiniMax-M3",
      persona: "",
      color: "sage",
      tools: false,
      enabled: true,
    }),
    prompt: "hello",
    maxOutputTokens: 8192,
    maxRetries: 0,
  });
  expect(body.max_completion_tokens).toBe(8192);
  expect(body.max_tokens).toBeUndefined();
  expect(body.reasoning_split).toBe(true);
  expect(body.thinking).toBeUndefined();
  expect(result.text).toBe("正式回答");
  expect(result.reasoningText).toBe("model reasoning");
});

it.each(["compatible", "openai"] as const)(
  "%s MiniMax recovery uses the same model and only changes thinking for that request",
  async (kind) => {
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({
            id: "mini",
            object: "chat.completion",
            created: 1,
            model: "MiniMax-M3",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "完整结论" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    saveProvider("native-workspace", {
      id: "mini-finalize",
      kind,
      baseUrl: "https://api.canalapi.com/v1",
      apiKey: "fake",
      models: ["MiniMax-M3", "MiniMax-M3.1-Flash"],
    });
    const a: Agent = {
      id: "m",
      name: "MiniMax",
      provider: "mini-finalize",
      model: "MiniMax-M3",
      persona: "",
      color: "sage",
      tools: false,
      enabled: true,
    };
    for (const finalize of [true, false])
      await generateText({
        model: modelFor("native-workspace", a, { finalize }),
        prompt: "hi",
        maxOutputTokens: 4096,
        maxRetries: 0,
      });
    expect(bodies[0].model).toBe("MiniMax-M3");
    expect(bodies[0].thinking).toEqual({ type: "disabled" });
    expect(bodies[0].max_completion_tokens).toBe(4096);
    expect(bodies[1].thinking).toBeUndefined();
    expect(() =>
      modelFor(
        "native-workspace",
        { ...a, model: "MiniMax-M3.1-Flash" },
        { finalize: true },
      ),
    ).toThrow("不支持");
  },
);
