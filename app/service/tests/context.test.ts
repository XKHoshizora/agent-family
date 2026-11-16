import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPrefix } from "../src/agents/context.ts";
import { CUT_MARK, fileText } from "../src/agents/runtime/context.ts";
import type { BlobStore } from "../src/attachments/blob.ts";
import { estimateTokens, IMAGE_TOKENS } from "../src/metering/prices.ts";
import type { ModelCall } from "../src/models/gateway.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, PNG } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

/**
 * What the model is shown (spec 6.2 "新话题", 6.5 "发给模型的内容", "思考程度"; README "Agents and runs"): the
 * conversation after the latest topic reset, newest turns kept within the model's context, with images, text files and
 * PDFs when the model can take them; never the stored reasoning. Read off the scripted gateway's recorded calls.
 */

const model = (id: string, over: Record<string, unknown>) => ({
  id,
  label: id,
  tier: "free",
  protocol: "anthropic",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "CONTEXT_TEST_KEY",
  model: `${id}-1`,
  // One micro-point per input token and none for output: a call's hold is its input estimate.
  inputMicroPerToken: 1,
  outputMicroPerToken: 0,
  maxOutputTokens: 4096,
  contextTokens: 1_000_000,
  vision: true,
  pdf: true,
  reasoning: ["low", "medium"],
  ...over,
});

const ENV = {
  CONTEXT_TEST_KEY: "not-a-real-key",
  SITE_MODELS: JSON.stringify([
    model("eyes", {}),
    model("blind", { vision: false, pdf: false, reasoning: [] }),
    model("tiny", { contextTokens: 2000, maxOutputTokens: 200 }),
    model("mid", { contextTokens: 8000, maxOutputTokens: 500 }),
  ]),
};

const gateway = scriptedGateway();
const store = useProbeBlobs("af-context-");
const { app, db } = useApp({ env: ENV, models: gateway, blobs: store.blobs, agentWorker: false });

let first = 0;
beforeEach(() => {
  first = gateway.calls.length;
});
afterEach(() => {
  expect(gateway.pending()).toBe(0);
});

const PERSONA = "你说话简短。";

async function owned(name: string, modelId = "eyes", over: Record<string, unknown> = {}) {
  const owner = await signUp(app, name);
  const agent = await mustCreateAgent(app, owner, { model: { source: "site", id: modelId }, persona: PERSONA, ...over });
  return { owner, agent, conv: agent.conversationId as string };
}

let txn = 0;
const say = async (owner: Actor, conv: string, text: string, extra: Record<string, unknown> = {}) => {
  const res = await api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `c${++txn}`, ...extra });
  expect(res.status).toBe(201);
  return res.json.message;
};
async function upload(owner: Actor, conv: string, filename: string, data: Buffer | string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: owner.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename, type: "application/octet-stream", data }]),
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}
/** Uploads the file and sends it, with `caption` when given. */
async function sendFile(owner: Actor, conv: string, filename: string, data: Buffer | string, caption?: string) {
  const attachmentId = await upload(owner, conv, filename, data);
  const res = await api(app, owner, "POST", `/api/conversations/${conv}/messages`, {
    attachmentId,
    ...(caption === undefined ? {} : { text: caption }),
    clientTxn: `c${++txn}`,
  });
  expect(res.status).toBe(201);
  return attachmentId;
}
const blobKeyOf = async (attachmentId: string) =>
  (await db.query<{ blob_key: string }>("select blob_key from attachments where id = $1", [attachmentId])).rows[0]!.blob_key;

const callsHere = () => gateway.calls.slice(first);
const lastCall = (): ModelCall => {
  const calls = callsHere();
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]!;
};
/** Every text the call shows, in order. */
const textsOf = (call: ModelCall) => call.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
const latestRun = async (owner: Actor, conv: string) => (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
const fromAgent = async (owner: Actor, conv: string, agentId: string): Promise<any[]> =>
  (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.filter((m: any) => m.senderId === agentId);
const usageInput = async (runId: string) =>
  (await db.query<{ input: number; estimated: boolean }>("select input_tokens::int as input, estimated from usage_records where run_id = $1", [runId]))
    .rows[0];

/** Runs the queued reply, answering `reply`. */
async function answer(reply: string, options: Parameters<typeof gateway.reply>[1] = {}) {
  gateway.reply(reply, options);
  expect(await app.agentWorker.runOnce()).toBe(true);
}

describe("turns", () => {
  it("the owner's messages are user turns and the Agent's assistant turns, in order; consecutive ones of one side are one turn; the call ends on the owner's", async () => {
    const { owner, conv } = await owned("ord");
    const hold = gateway.hang();
    await say(owner, conv, "甲");
    const running = app.agentWorker.runOnce();
    await hold.reached;
    await say(owner, conv, "乙");
    await say(owner, conv, "丙");
    hold.release("答甲");
    await running;
    // The follow-up answers 乙 and 丙: the Agent's reply to 甲 came after them and is not the call's last turn.
    await answer("答乙丙");
    expect(lastCall().messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "甲" },
          { type: "text", text: "乙" },
          { type: "text", text: "丙" },
        ],
      },
    ]);

    await say(owner, conv, "丁");
    await answer("答丁");
    expect(lastCall().messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "甲" },
          { type: "text", text: "乙" },
          { type: "text", text: "丙" },
        ],
      },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "答甲" },
          { type: "text", text: "答乙丙" },
        ],
      },
      { role: "user", parts: [{ type: "text", text: "丁" }] },
    ]);
  });

  it("a quoted message is shown before the text as > and its first 200 characters", async () => {
    const { owner, conv } = await owned("quo");
    await say(owner, conv, "讲一段");
    const long = `第一行\n${"长".repeat(300)}`;
    await answer(long);
    const reply = (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages.at(-1);
    await say(owner, conv, "这段什么意思？", { replyToSeq: reply.seq });
    await answer("就是这个意思。");
    const shown = Array.from(long).slice(0, 200).join("");
    expect(textsOf(lastCall()).at(-1)).toBe(`> 第一行\n> ${shown.slice("第一行\n".length)}\n这段什么意思？`);
  });
});

describe("a new topic", () => {
  it("after a topic reset nothing older is sent, while history and search still have it", async () => {
    const { owner, agent, conv } = await owned("topic");
    await say(owner, conv, "旧话题ALPHAWORD");
    await answer("旧回复BETAWORD");
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/topic`)).status).toBe(201);
    await say(owner, conv, "新话题");
    await answer("好的");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "新话题" }] }]);
    expect(JSON.stringify(lastCall().messages)).not.toMatch(/ALPHAWORD|BETAWORD/);

    const history = (await api(app, owner, "GET", `/api/conversations/${conv}/messages`)).json.messages;
    expect(history.map((m: any) => (m.kind === "system" ? m.system.event : m.text))).toEqual([
      "旧话题ALPHAWORD",
      "旧回复BETAWORD",
      "topic_reset",
      "新话题",
      "好的",
    ]);
    expect((await api(app, owner, "GET", "/api/search?q=ALPHAWORD")).json.messages).toHaveLength(1);
    expect((await api(app, owner, "GET", `/api/conversations/${conv}/search?q=BETAWORD`)).json.messages).toHaveLength(1);
    expect((await fromAgent(owner, conv, agent.id)).map((m) => m.text)).toEqual(["旧回复BETAWORD", "好的"]);
  });

  it("a reply with nothing to answer never reaches the model: it fails busy and may be retried", async () => {
    const { owner, conv } = await owned("empty");
    gateway.fail("provider_unavailable");
    const hello = await say(owner, conv, "你好");
    await app.agentWorker.runOnce();
    expect((await latestRun(owner, conv)).error).toBe("provider_unavailable");
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/topic`)).status).toBe(201);

    const calls = gateway.calls.length;
    const retried = await api(app, owner, "POST", `/api/conversations/${conv}/runs/retry`);
    expect(retried.status).toBe(201);
    // A retry answers up to the owner's last message; the notice, though written by the owner, is not one.
    const covers = await db.query("select covers_seq::int as c from agent_runs where id = $1", [retried.json.run.id]);
    expect(covers.rows).toEqual([{ c: hello.seq }]);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.length).toBe(calls);
    const run = await latestRun(owner, conv);
    expect(run).toEqual({ id: run.id, status: "failed", error: "busy", retryable: true });
    // Never admitted: no model on its record and nothing charged.
    expect((await db.query("select source, cost_micro::text as cost from usage_records where run_id = $1", [run.id])).rows).toEqual([
      { source: null, cost: "0" },
    ]);
  });
});

describe("attachments", () => {
  it("a model that can see gets the image's bytes, counted as 1 500 tokens; one that cannot gets its name and the blob is not read", async () => {
    const { owner, conv } = await owned("vis");
    const hold = gateway.hang();
    await sendFile(owner, conv, "pixel.png", PNG, "这是什么？");
    const running = app.agentWorker.runOnce();
    const call = await hold.reached;
    expect(call.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "这是什么？" },
          { type: "image", mime: "image/png", data: PNG },
        ],
      },
    ]);
    // The hold is the input estimate (1 micro-point per input token, outputs free): system, text and the image.
    const estimate = estimateTokens(call.system) + estimateTokens("这是什么？") + IMAGE_TOKENS;
    const held = await db.query<{ hold: string }>("select hold_micro::text as hold from agent_runs where status = 'running'");
    expect(held.rows).toEqual([{ hold: String(estimate) }]);
    hold.release("一个像素。");
    await running;
    // No usage reported: settled on the same estimate, images included.
    expect(await usageInput((await latestRun(owner, conv)).id)).toEqual({ input: estimate, estimated: true });

    const blind = await owned("blind", "blind");
    const attachment = await sendFile(blind.owner, blind.conv, "pixel.png", PNG);
    await answer("看不到图。");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "[图片：pixel.png]" }] }]);
    expect(store.probe.gets).not.toContain(await blobKeyOf(attachment));
  });

  it("at most 10 images in one call, the newest", async () => {
    const { owner, agent, conv } = await owned("many");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    for (let i = 0; i < 12; i++) await sendFile(owner, conv, `p${i}.png`, PNG);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    await say(owner, conv, "都看看");
    await answer("看了。");
    const parts = lastCall().messages.flatMap((m) => m.parts);
    expect(parts.filter((p) => p.type === "image")).toHaveLength(10);
    expect(textsOf(lastCall())).toEqual(["[图片：p0.png]", "[图片：p1.png]", "都看看"]);
  });

  it("a text file is shown by its content, not its name: cut at 100 000 characters with a mark, BOM and unsafe characters removed", async () => {
    const { owner, conv } = await owned("txt");
    const bidi = String.fromCodePoint(0x202e);
    await sendFile(owner, conv, "notes", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`第一行\nsecond${bidi} line\n`)]), "看看笔记");
    const long = `${"a".repeat(99_990)}0123456789TAILWORD${"b".repeat(50_000)}`;
    await sendFile(owner, conv, "long.txt", long);
    await answer("读完了。");
    expect(textsOf(lastCall())).toEqual(["看看笔记", "[文件：notes]\n第一行\nsecond line\n", `[文件：long.txt]\n${long.slice(0, 100_000)}${CUT_MARK}`]);
    expect(CUT_MARK).toBe("…（已截断）");
  });

  it("at most 200 000 characters of files in one call: the oldest file over it is cut, older ones are named", async () => {
    const { owner, agent, conv } = await owned("cap");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    await sendFile(owner, conv, "a.txt", "A".repeat(80_000));
    await sendFile(owner, conv, "b.txt", "B".repeat(90_000));
    await sendFile(owner, conv, "c.txt", "C".repeat(90_000));
    await sendFile(owner, conv, "d.txt", "D".repeat(10));
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    await say(owner, conv, "汇总");
    await answer("好。");
    // Newest first: d (10), c (90 000), b (90 000) fill 180 010; a gets the 19 990 left.
    expect(textsOf(lastCall())).toEqual([
      `[文件：a.txt]\n${"A".repeat(19_990)}${CUT_MARK}`,
      `[文件：b.txt]\n${"B".repeat(90_000)}`,
      `[文件：c.txt]\n${"C".repeat(90_000)}`,
      `[文件：d.txt]\n${"D".repeat(10)}`,
      "汇总",
    ]);
  });

  it("a binary file named .txt, and any other file, is shown by its name; a message with only an attachment is still a turn", async () => {
    const { owner, conv } = await owned("bin");
    const binary = Buffer.from([0x50, 0x4b, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x00, 0x13, 0x37]);
    await sendFile(owner, conv, "data.txt", binary);
    await answer("这是二进制文件。");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "[文件：data.txt]" }] }]);
    await sendFile(owner, conv, "bad.txt", Buffer.from([0x68, 0x69, 0xc3, 0x28, 0x0a])); // not UTF-8
    await sendFile(owner, conv, "ctl.txt", Buffer.from(`ok${"\u0007".repeat(5)}${"x".repeat(100)}`)); // many control characters
    await answer("都打不开。");
    expect(textsOf(lastCall()).slice(-2)).toEqual(["[文件：bad.txt]", "[文件：ctl.txt]"]);
  });

  it("a PDF goes to a model that reads PDFs as a file, counted at 300 tokens a kilobyte; to one that does not, by name", async () => {
    const pdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${"% filler\n".repeat(300)}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
    const { owner, conv } = await owned("pdf");
    await sendFile(owner, conv, "doc.pdf", pdf, "总结");
    await answer("是个空文档。");
    const call = lastCall();
    expect(call.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "总结" },
          { type: "file", mime: "application/pdf", name: "doc.pdf", data: pdf },
        ],
      },
    ]);
    const estimate = estimateTokens(call.system) + estimateTokens("总结") + Math.ceil((pdf.length * 300) / 1000);
    expect(await usageInput((await latestRun(owner, conv)).id)).toEqual({ input: estimate, estimated: true });

    const blind = await owned("pdfblind", "blind");
    await sendFile(blind.owner, blind.conv, "doc.pdf", pdf);
    await answer("看不了 PDF。");
    expect(lastCall().messages).toEqual([{ role: "user", parts: [{ type: "text", text: "[文件：doc.pdf]" }] }]);
  });
});

describe("the context budget", () => {
  it("with a 2 000-token context the oldest turns are gone and the newest owner message is there", async () => {
    const { owner, agent, conv } = await owned("tiny", "tiny");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    const sent = Array.from({ length: 10 }, (_, i) => `M${i}:${"字".repeat(296)}`);
    for (const text of sent) await say(owner, conv, text);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    await say(owner, conv, "最后一句");
    await answer("好。");
    const call = lastCall();
    const texts = textsOf(call);
    expect(texts.at(-1)).toBe("最后一句");
    expect(texts).not.toContain(sent[0]);
    // The newest that fit, with no gap.
    const kept = texts.slice(0, -1);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(sent.slice(sent.length - kept.length));
    const used = estimateTokens(call.system) + texts.reduce((n, t) => n + estimateTokens(t), 0);
    expect(used).toBeLessThanOrEqual(2000 - 200);
    expect(used + 300).toBeGreaterThan(2000 - 200);
  });

  it("the newest owner message alone over the budget is cut from the front", async () => {
    const { owner, conv } = await owned("huge", "tiny");
    await say(owner, conv, `HEAD${"长".repeat(5000)}TAIL`);
    await answer("太长了。");
    const call = lastCall();
    const [text] = textsOf(call);
    expect(text!.startsWith("…")).toBe(true);
    expect(text!.endsWith("TAIL")).toBe(true);
    expect(text).not.toContain("HEAD");
    expect(estimateTokens(call.system) + estimateTokens(text!)).toBe(2000 - 200);
  });

  // An 8 000-token context with 500 for the output: about 7 300 tokens for the conversation; an image counts 1 500.
  it("an older message's attachment goes, leaving its name, before older messages do", async () => {
    const { owner, agent, conv } = await owned("midold", "mid");
    const early = `早${"文".repeat(5999)}`;
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    await say(owner, conv, early);
    await sendFile(owner, conv, "old.png", PNG, "旧图");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    await say(owner, conv, "看图");
    await answer("看不清。");
    await say(owner, conv, "比较");
    await answer("比较完了。");
    // The image would fit without the long first message; that message stays, the image is named.
    expect(lastCall().messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: early },
          { type: "text", text: "旧图" },
          { type: "text", text: "[图片：old.png]" },
          { type: "text", text: "看图" },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "看不清。" }] },
      { role: "user", parts: [{ type: "text", text: "比较" }] },
    ]);
  });

  it("the image the owner just sent is kept before older messages", async () => {
    const { owner, agent, conv } = await owned("midnew", "mid");
    await sendFile(owner, conv, "old.png", PNG, "旧图");
    await answer("看到旧图了。");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);
    const sent = Array.from({ length: 6 }, (_, i) => `段${i}${"文".repeat(997)}`);
    for (const text of sent) await say(owner, conv, text);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/resume`)).status).toBe(200);
    await say(owner, conv, "继续");
    await answer("好的。");
    await sendFile(owner, conv, "new.png", PNG, "比较一下");
    await answer("比较完了。");
    const { messages } = lastCall();
    expect(messages.at(-1)).toEqual({
      role: "user",
      parts: [
        { type: "text", text: "比较一下" },
        { type: "image", mime: "image/png", data: PNG },
      ],
    });
    // Older messages fill what is left after it, newest first: the oldest no longer fit.
    const texts = messages.slice(0, -1).flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : p.type)));
    expect(texts.slice(-3)).toEqual([sent[5], "继续", "好的。"]);
    expect(texts).not.toContain(sent[0]);
    expect(texts).not.toContain("旧图");
  });
});

describe("reasoning", () => {
  it("is stored with the reply (at most 32 000 characters) and returned, but never sent to a model again or found by search", async () => {
    const { owner, agent, conv } = await owned("rsn");
    const thought = `思考SECRETTHOUGHT${"想".repeat(40_000)}`;
    await say(owner, conv, "一加一？");
    await answer("二。", { reasoning: thought });
    const [reply] = await fromAgent(owner, conv, agent.id);
    expect(reply.reasoning).toBe(Array.from(thought).slice(0, 32_000).join(""));
    expect((await api(app, owner, "GET", "/api/search?q=SECRETTHOUGHT")).json.messages).toEqual([]);

    await say(owner, conv, "再加一？");
    await answer("三。");
    expect(lastCall().messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "一加一？" }] },
      { role: "assistant", parts: [{ type: "text", text: "二。" }] },
      { role: "user", parts: [{ type: "text", text: "再加一？" }] },
    ]);
    expect(JSON.stringify(lastCall())).not.toContain("SECRETTHOUGHT");
  });

  it("the call carries the Agent's level when the model allows it, else none", async () => {
    const { owner, agent, conv } = await owned("lvl", "eyes", { reasoning: "medium" });
    await say(owner, conv, "想一想");
    await answer("想好了。");
    expect(lastCall().reasoning).toBe("medium");
    // A level the model does not (or no longer) offer, e.g. after the site's configuration changed.
    await db.query("update agents set reasoning = 'high' where principal_id = $1", [agent.id]);
    await say(owner, conv, "再想想");
    await answer("又想好了。");
    expect(lastCall().reasoning).toBe("none");
  });
});

describe("reading files for the model", () => {
  it("decides text by its bytes: valid UTF-8 without NUL and with few control characters", () => {
    const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
    const text = (bytes: Uint8Array, complete: boolean, maxChars: number) => fileText(bytes, complete, maxChars)?.text ?? null;
    // A form feed does not make it binary; like every control character but tab and line breaks it is not passed on.
    expect(text(utf8("hello\r\n\tworld\f"), true, 100)).toBe("hello\r\n\tworld");
    expect(text(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]), true, 100)).toBe("hi");
    expect(text(new Uint8Array([0x68, 0x00, 0x69]), true, 100)).toBeNull();
    expect(text(new Uint8Array([0x68, 0xc3, 0x28]), true, 100)).toBeNull();
    expect(text(utf8(`${"\u001b".repeat(2)}${"x".repeat(98)}`), true, 1000)).toBeNull();
    expect(text(utf8(`\u001b${"x".repeat(99)}`), true, 1000)).toBe("x".repeat(99));
    expect(text(new Uint8Array(0), true, 100)).toBeNull();
    // Cut inside a character: the partial character is dropped, and the text is marked cut.
    const word = utf8("你好");
    expect(fileText(word.subarray(0, 4), false, 100)).toEqual({ text: `你${CUT_MARK}`, chars: 1 });
    expect(fileText(utf8("abcdef"), true, 3)).toEqual({ text: `abc${CUT_MARK}`, chars: 3 });
    expect(fileText(utf8("abc"), true, 3)).toEqual({ text: "abc", chars: 3 });
  });

  it("reads at most what it is allowed, and gives up on a blob that does not come", async () => {
    const stalled: BlobStore = {
      put: async () => ({ size: 0 }),
      get: () => new Promise<Readable>(() => {}),
      delete: async () => {},
    };
    await expect(readPrefix(stalled, "att-x", 10, { timeoutMs: 50 })).rejects.toThrow(/did not arrive/);

    let pulled = 0;
    const endless: BlobStore = {
      ...stalled,
      get: async () =>
        new Readable({
          read() {
            pulled++;
            this.push(Buffer.alloc(1024, 0x61));
          },
        }),
    };
    const read = await readPrefix(endless, "att-y", 5000, { timeoutMs: 1000 });
    expect(read).toMatchObject({ complete: false });
    expect(read!.data.length).toBe(5000);
    expect(pulled).toBeLessThan(20);

    const missing: BlobStore = { ...stalled, get: async () => Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })) };
    expect(await readPrefix(missing, "att-z", 10, { timeoutMs: 1000 })).toBeNull();
  });
});
