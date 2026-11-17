// A local stand-in for a model service, and how a test scripts it. The runner process (system.mjs) runs the server on
// 127.0.0.1; the service under test reaches it as its site models and as a person's own provider. It speaks OpenAI Chat
// Completions, streamed (`POST …/chat/completions`), Anthropic Messages, streamed (`POST …/messages`, the protocol whose
// thinking the service shows), and the model list both have (`GET …/models`); the wire shapes are those of
// app/service/tests/helpers/models.ts `protocolStub()`. Tests script it through the control endpoint (control.mjs):
// what the next calls answer, and what each call was sent.
import http from "node:http";
import { expect } from "@playwright/test";
import { controlCall } from "./control.mjs";

/** What a call answers when nothing is scripted. */
export const DEFAULT_REPLY = "好的，收到。";
/** The usage every answer reports unless its step names another: small, so a person's free allowance lasts a while. */
export const DEFAULT_USAGE = { input: 20, output: 10 };
/**
 * The model names `GET …/models` lists: two of the stub's own (unknown to the service's model catalogue), two the
 * catalogue knows, and one that is no chat model.
 */
export const STUB_MODELS = ["stub-chat", "stub-vision", "gpt-4o-mini", "claude-sonnet-5-5", "text-embedding-3-small"];

/** Chunks of at most `size` code points (a surrogate pair is never split). */
function chunks(text, size) {
  const points = Array.from(text);
  const out = [];
  for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(""));
  return out;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** One server-sent event: an `event:` line when named, then the JSON as `data:`. */
const sse = (data, event) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

/** The frames of an OpenAI Chat Completions stream. */
function openaiFrames(model, usage) {
  const chunk = (delta, finish = null) =>
    sse({ id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 1_700_000_000, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  return {
    head: () => chunk({ role: "assistant", content: "" }),
    // (Chat Completions has no thinking the service reads: a step's reasoning is not sent on this protocol.)
    reasoning: () => "",
    text: (d) => chunk({ content: d }),
    end: () =>
      chunk({}, "stop") +
      sse({
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model,
        choices: [],
        usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
      }) +
      sse("[DONE]"),
  };
}

/** The frames of an Anthropic Messages stream: thinking (block 0) when there is reasoning, then the text. */
function anthropicFrames(model, usage) {
  const ev = (type, fields = {}) => sse({ type, ...fields }, type);
  let index = -1;
  let open = null;
  const start = (kind) => {
    let out = open ? ev("content_block_stop", { index }) : "";
    index += 1;
    open = kind;
    out += ev("content_block_start", { index, content_block: kind === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } });
    return out;
  };
  return {
    head: () =>
      ev("message_start", {
        message: { id: "msg_e2e", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1 } },
      }),
    reasoning: (d) => (open === "thinking" ? "" : start("thinking")) + ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: d } }),
    text: (d) =>
      (open === "text" ? "" : (open === "thinking" ? ev("content_block_delta", { index, delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" } }) : "") + start("text")) +
      ev("content_block_delta", { index, delta: { type: "text_delta", text: d } }),
    end: () =>
      (open ? ev("content_block_stop", { index }) : "") +
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output } }) +
      ev("message_stop"),
  };
}

/**
 * The stub's server. Each streaming call takes the next scripted step (or the default reply) when it arrives:
 * `{text, reasoning?, chunkSize? (code points, default 4), delayMs? (before each piece), waitMs? (once, after the stream's
 * head and before its first piece), usage? ({input, output} tokens), status? (answer with this HTTP error instead), hang?
 * (after the text, hold until released or until the caller goes)}`.
 * Every request is recorded: method, path, the Authorization / x-api-key it carried, its JSON body, and whether the
 * caller went away before the answer ended.
 */
export function startModelStub() {
  let requests = [];
  let queue = [];
  /** Calls holding (`hang`), oldest first: `release(text)` goes on with `text` and ends the answer. */
  let held = [];

  async function stream(req, res, record, step, protocol) {
    const usage = step.usage ?? DEFAULT_USAGE;
    const frames = (protocol === "anthropic" ? anthropicFrames : openaiFrames)(record.body?.model ?? "stub", usage);
    const size = step.chunkSize ?? 4;
    const delay = step.delayMs ?? 0;
    let gone = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        gone = true;
        record.aborted = true;
      }
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(frames.head());
    if (step.waitMs > 0) await sleep(step.waitMs);
    const emit = async (kind, text) => {
      for (const piece of chunks(text, size)) {
        if (gone) return;
        if (delay > 0) await sleep(delay);
        if (gone) return;
        const frame = frames[kind](piece);
        if (frame) res.write(frame);
      }
    };
    await emit("reasoning", step.reasoning ?? "");
    await emit("text", step.text ?? "");
    if (step.hang) {
      const rest = await new Promise((resolve) => {
        const hold = { record, release: resolve };
        held.push(hold);
        res.on("close", () => resolve(null));
      });
      held = held.filter((h) => h.record !== record);
      if (gone) return;
      if (rest === null) {
        // (Cut off by a reset: the stream ends broken at once rather than idling until the service gives up on it.)
        res.destroy();
        return;
      }
      await emit("text", rest);
    }
    if (gone) return;
    res.end(frames.end());
  }

  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      let body = null;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const path = (req.url ?? "").split("?")[0];
      const record = {
        at: Date.now(),
        method: req.method,
        path,
        authorization: req.headers.authorization ?? req.headers["x-api-key"] ?? null,
        body,
        aborted: false,
      };
      requests.push(record);
      if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: STUB_MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "e2e" })) }));
        return;
      }
      const protocol = req.method === "POST" && path.endsWith("/chat/completions") ? "openai" : req.method === "POST" && path.endsWith("/messages") ? "anthropic" : null;
      if (!protocol) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":{"message":"no such endpoint"}}');
        return;
      }
      const step = queue.shift() ?? { text: DEFAULT_REPLY };
      if (step.status) {
        res.writeHead(step.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted failure", type: "e2e", code: null } }));
        return;
      }
      stream(req, res, record, step, protocol).catch(() => res.destroy());
    });
  });

  /** What the control endpoint's `/stub/<name>` does with its JSON body; answers JSON. */
  function control(name, body) {
    switch (name) {
      case "reset":
        // A call still holding from an earlier test is cut off: it can never answer anyone later.
        for (const hold of held) hold.release(null);
        held = [];
        queue = [];
        requests = [];
        return { ok: true };
      case "script":
        queue.push(...(body?.steps ?? []));
        return { pending: queue.length };
      case "release": {
        const hold = held.shift();
        if (!hold) throw new Error("no call is holding");
        hold.release(body?.text ?? "");
        return { ok: true };
      }
      case "state":
        return { requests, pending: queue.length, holding: held.length };
      default:
        throw new Error(`unknown stub command ${name}`);
    }
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        /** `http://127.0.0.1:<port>/v1`: a site model's or a provider's base URL. */
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        control,
        close: () => {
          for (const hold of held) hold.release(null);
          server.closeAllConnections();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

// --- what a test does with it (through the control endpoint) ------------------------------------------------------

const call = (name, body) => controlCall(`stub/${name}`, body);

export const modelStub = {
  /** The stub's base URL (`http://127.0.0.1:<port>/v1`), for a person's own provider. */
  get baseUrl() {
    if (!process.env.E2E_STUB_URL) throw new Error("the model stub runs only in the local suite");
    return process.env.E2E_STUB_URL;
  },
  /** Forgets every script and recorded request, and cuts off any call still holding (each test starts so). */
  reset: () => call("reset"),
  /** The next streaming calls answer with these steps, in order (see `startModelStub`). */
  script: (...steps) => call("script", { steps }),
  /** The next call answers `text` (options as a step's). */
  reply: (text, options = {}) => call("script", { steps: [{ text, ...options }] }),
  /** The next call streams `text`, then holds until `release()` (or until the service stops it). */
  hangAfter: (text, options = {}) => call("script", { steps: [{ text, hang: true, ...options }] }),
  /** The oldest holding call goes on with `text` and ends. */
  release: (text = "") => call("release", { text }),
  /** `{requests, pending, holding}`. */
  state: () => call("state"),
  /** The streaming calls received so far (model calls, not model lists), oldest first. */
  async calls() {
    return (await call("state")).requests.filter((r) => r.method === "POST");
  },
  /** Waits until `n` calls are holding. */
  async holding(n = 1) {
    await expect.poll(async () => (await call("state")).holding, { message: `${n} model call(s) holding`, timeout: 20_000 }).toBe(n);
  },
  /** Waits until `n` streaming calls have been received in all; resolves with them. */
  async waitForCalls(n) {
    await expect.poll(async () => (await modelStub.calls()).length, { message: `${n} model call(s) received`, timeout: 20_000 }).toBe(n);
    return modelStub.calls();
  },
};
