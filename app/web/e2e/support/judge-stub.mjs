// A local stand-in for the judgement model (app/service/src/judge/client.ts; app/service/README.md, Proactive replies),
// and how a test reads it. The runner process (system.mjs) runs the server on 127.0.0.1; the service under test asks it
// as `JUDGE`'s one channel (through E2E_JUDGE, app/service/tests/helpers/e2e-server.ts). It answers by fixed rules on
// the latest line of the `state` it is shown — the message being judged —, so a spec decides the outcome by what its
// people write (`judgeAnswers`). Every request is recorded; specs read them through the control endpoint (control.mjs).
import http from "node:http";
import { expect } from "@playwright/test";
import { controlCall } from "./control.mjs";

/** The path of the stub's one endpoint (the channel's `url` ends in it). */
export const JUDGE_PATH = "/v1/judge";
/** How sure the stub is of what its rules pick. */
const SURE = 0.95;
/** A quiet answer when nobody asked for quiet. */
const NOT_QUIET = 0.02;
/** The words its rules look for in the latest line: an on-topic request for the first Agent; a request for quiet. */
export const ON_TOPIC = "川菜";
export const HUSH = "别插话";
/**
 * The words the memory rules look for (agents-memory.spec.mjs): a note whose text contains `VAULT_MARK` is private (the
 * sort question is answered 0.05, so the note goes into the vault; any other note is answered 0.95: outside); a new group
 * message that contains `LISTEN_MARK` is something said about its owner (the hearsay listener question is answered 0.95).
 */
export const VAULT_MARK = "体检";
export const LISTEN_MARK = "报告";

/**
 * The memory feature's questions (app/service/src/memory/sort.ts, hearsay.ts; agents/proactive/candidates.ts), each recognised
 * by a distinctive phrase of its instructions and answered by its own fixed rule; null for any other question. Answers are
 * a `noul` probability.
 * - sort (a note about the owner, or an Agent's own): 0.05 when the note holds `VAULT_MARK`, else 0.95;
 * - duplicate of an existing note: 0.05; the faithful check of a dream's change: 0.95;
 * - listener "someone else said something about the owner": 0.95 when a new (【新】) line holds `LISTEN_MARK`, else 0.05;
 * - listener "the owner said something about themselves": 0.05;
 * - hearsay "something new in this batch": 0.95; hearsay "abuse": 0.05.
 */
function memoryAnswer(state, question) {
  if (question?.type !== "noul") return null;
  const text = String(question.instructions ?? "");
  const has = (phrase) => text.includes(phrase);
  if (has("这是一个人的 AI 助手记下的一条关于主人的笔记") || has("这是一个 AI 助手给自己记的一条笔记")) return String(state ?? "").includes(VAULT_MARK) ? 0.05 : SURE;
  if (has("这是一个 AI 助手关于主人的笔记。state 是一个 JSON：new 是一条新的笔记")) return 0.05;
  if (has("新的这些说的全都是原来的笔记里已经有的事")) return SURE;
  if (has("有人（不是") && has("本人的、以后还用得上的事")) {
    const fresh = String(state ?? "").split("\n").filter((l) => l.startsWith("【新】"));
    return fresh.some((l) => l.includes(LISTEN_MARK)) ? SURE : 0.05;
  }
  if (has("自己说了一件关于自己的、以后还用得上的事")) return 0.05;
  if (has("至少有一条说了一件已经记下的内容里没有的、关于主人的新的事")) return SURE;
  if (has("反复发内容相近的话")) return 0.05;
  return null;
}

/**
 * The answers to `questions` about `state`, by the latest line of `state`: containing `ON_TOPIC`, every choice picks
 * its first option that is not `nobody` with 0.95 (the others share the rest) and every quiet question is 0.02;
 * containing `HUSH`, every choice picks `nobody` with 0.95 and every quiet question is 0.95; anything else, `nobody` with
 * 0.95 and quiet 0.02. The shape is the protocol's: `{answers: {key: {type: "choice", choice, confidence, probabilities}
 * | {noul}}}`. The memory feature's questions are answered by `memoryAnswer`'s rules instead of the hush rule.
 */
export function judgeAnswers(state, questions) {
  const lines = String(state ?? "").split("\n");
  const latest = lines[lines.length - 1] ?? "";
  const onTopic = latest.includes(ON_TOPIC);
  const hush = !onTopic && latest.includes(HUSH);
  const answers = {};
  for (const [key, question] of Object.entries(questions ?? {})) {
    if (question?.type === "choice") {
      const names = Object.keys(question.criteria ?? {});
      const first = names.find((n) => n !== "nobody");
      const choice = onTopic && first !== undefined ? first : "nobody";
      const rest = names.length > 1 ? (1 - SURE) / (names.length - 1) : 0;
      answers[key] = { type: "choice", choice, confidence: SURE, probabilities: Object.fromEntries(names.map((n) => [n, n === choice ? SURE : rest])) };
    } else if (question?.type === "noul") {
      const memory = memoryAnswer(state, question);
      answers[key] = { noul: memory ?? (hush ? SURE : NOT_QUIET) };
    }
  }
  return { answers };
}

/** The stub's server: `POST JUDGE_PATH` answers `judgeAnswers`; every request is recorded (its body and Authorization). */
export function startJudgeStub() {
  let requests = [];

  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch {
        body = null;
      }
      if (req.method !== "POST" || path !== JUDGE_PATH || body === null) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"no such endpoint"}');
        return;
      }
      const answer = judgeAnswers(body.state, body.questions);
      requests.push({ at: Date.now(), authorization: req.headers.authorization ?? null, body, answer });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });

  /** What the control endpoint's `/judge/<name>` does with its JSON body; answers JSON. */
  function control(name) {
    switch (name) {
      case "reset":
        requests = [];
        return { ok: true };
      case "state":
        return { requests };
      default:
        throw new Error(`unknown judgement stub command ${name}`);
    }
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        /** `http://127.0.0.1:<port>/v1/judge`: the channel's address. */
        url: `http://127.0.0.1:${server.address().port}${JUDGE_PATH}`,
        control,
        close: () => {
          server.closeAllConnections();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

// --- what a test does with it (through the control endpoint) ------------------------------------------------------

const call = (name, body) => controlCall(`judge/${name}`, body);

/** The latest line of a recorded request's state: the message it judged. */
export const judgedLine = (request) => {
  const lines = String(request.body?.state ?? "").split("\n");
  return lines[lines.length - 1] ?? "";
};

export const judgeStub = {
  /** Forgets every recorded request (each test starts so). */
  reset: () => call("reset"),
  /** The requests received so far, oldest first: `{at, authorization, body: {model, state, questions}, answer}`. */
  async requests() {
    return (await call("state")).requests;
  },
  /** Waits until a request judging a message that contains `text` has been answered; resolves with it. */
  async judged(text) {
    let found;
    await expect
      .poll(
        async () => {
          found = (await judgeStub.requests()).find((r) => judgedLine(r).includes(text));
          return found !== undefined;
        },
        { message: `a judgement of the message containing ${text}`, timeout: 20_000 },
      )
      .toBe(true);
    return found;
  },
};
