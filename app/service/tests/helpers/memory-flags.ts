import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import type { Db } from "../../src/db.ts";
import { api, group, signUp, type Actor } from "./actors.ts";
import { mustCreateAgent } from "./agents.ts";
import type { TestClock } from "./harness.ts";
import type { ScriptedGateway } from "./models.ts";

/**
 * What the two files that test acting on flags (memory-hearsay, memory-group-review) share: the judgement channel they
 * configure, and a few steps of their worlds (a group with an owner's Agent in it, a flag the reviewer is told about, the
 * quiet time passing). `flagHelpers` is given the file's own `useApp` results.
 */

export const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 500,
  dailyLimit: 20_000,
};

export const FAST = { source: "site", id: "fast" } as const;
export const PERSONA = "你是一个说话简洁的助手。";
export const MIN = 60_000;

/** Lets everything that is already due on the event loop run. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
};

/** The text of the first part of a recorded model call's first message (what the memory calls send: one JSON string). */
export const textOf = (call: { messages: Array<{ parts: unknown[] }> }): string => (call.messages[0]!.parts[0] as { text: string }).text;

export interface FlagWorld {
  app: FastifyInstance;
  db: Db;
  clock: TestClock;
  gateway: ScriptedGateway;
}

export function flagHelpers({ app, db, clock }: FlagWorld) {
  const memory = () => app.deps.memory!;

  let txn = 0;
  /** `who` writes `text` in `conv`; its seq. */
  const say = async (who: Actor, conv: string, text: string): Promise<number> => {
    const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `mf${++txn}` });
    if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
    return sent.json.message.seq as number;
  };

  /** The owner, two other members, a group (titled `title`) of the three, and the owner's Agent in it. */
  async function world(tag: string, title = "读书会", over: Record<string, unknown> = {}) {
    const owner = await signUp(app, `own${tag}`);
    const mia = await signUp(app, `mia${tag}`);
    const third = await signUp(app, `thr${tag}`);
    const g = await group(app, mia, title, [owner, third]);
    const agent = await mustCreateAgent(app, owner, { handle: `mf_${tag}`, name: `mf_${tag}`, model: FAST, persona: PERSONA, ...over });
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    return { owner, mia, third, g, agent };
  }

  /** The judgement flagged message `seq` for the Agent (the row, as `writeFlags` writes it) and, unless `tell` is false, the reviewer was told. */
  async function flag(agentId: string, conv: string, seq: number, kind: "hearsay" | "own", tell = true): Promise<void> {
    await db.query("insert into memory_flags (agent_id, conversation_id, seq, kind) values ($1, $2, $3, $4) on conflict do nothing", [agentId, conv, seq, kind]);
    if (tell) memory().flagged(agentId, conv, kind);
  }

  /** The quiet time passes (two minutes: `groupQuietMs`), the wake-up runs, and is done. */
  async function wake(ms = 2 * MIN): Promise<void> {
    clock.advance(ms);
    await memory().idle();
  }

  const flagRows = async (agentId: string, kind: "hearsay" | "own"): Promise<number[]> =>
    (await db.query<{ s: string }>("select seq::text as s from memory_flags where agent_id = $1 and kind = $2 order by memory_flags.seq", [agentId, kind])).rows.map((r) => Number(r.s));
  const messagesOf = async (who: Actor, conv: string): Promise<any[]> => (await api(app, who, "GET", `/api/conversations/${conv}/messages`)).json.messages;
  const chips = async (who: Actor, conv: string) => (await messagesOf(who, conv)).filter((m) => m.system?.event === "memory_changed");

  return { memory, say, world, flag, wake, flagRows, messagesOf, chips };
}
