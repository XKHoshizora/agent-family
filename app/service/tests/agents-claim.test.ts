import { describe, expect, it } from "vitest";
import { signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";

/**
 * Which queued reply the worker claims next (`DbAgentPort.claimNext`; the limits plan, Task 3): an owner has at most
 * `AGENT_MAX_CONCURRENT_RUNS` replies running, of which at most `AGENT_MAX_CONCURRENT_OTHERS_RUNS` are not in the `own`
 * lane — so replies others call for cannot take every place. Here: 3 in all, 2 of them others'.
 */

const lines: string[] = [];
const { app, db } = useApp({
  env: { ...SITE_ENV, AGENT_MAX_CONCURRENT_RUNS: "3", AGENT_MAX_CONCURRENT_OTHERS_RUNS: "2" },
  models: scriptedGateway(),
  agentWorker: false,
  logStream: { write: (line) => void lines.push(line) },
});

const FAST = { source: "site", id: "fast" } as const;

/** One run is active per Agent and conversation, so each run here has an Agent of its own. */
type World = { owner: Actor; n: number };
const ownerOf = async (name: string): Promise<World> => ({ owner: await signUp(app, name), n: 0 });

/** A reply of a new Agent of the owner in `status` and `lane`, made `ageSeconds` ago. */
async function run(w: World, status: "queued" | "running", lane: "own" | "others", ageSeconds = 0): Promise<string> {
  const agent = await mustCreateAgent(app, w.owner, { name: `a${++w.n}`, model: FAST, persona: "简短地回答。" });
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, lane, caller_id, created_at, started_at)
     values ('reply', $1, $2, $3, $4, 0, $5, $3, now() - make_interval(secs => $6), case when $4 = 'running' then now() else null end) returning id`,
    [agent.conversationId, agent.id, w.owner.id, status, lane, ageSeconds],
  );
  return rows[0]!.id;
}

const statusOf = async (id: string) => (await db.query<{ status: string }>("select status from agent_runs where id = $1", [id])).rows[0]!.status;
const end = (id: string) => db.query("update agent_runs set status = 'done', finished_at = now() where id = $1", [id]);

describe("claiming the next reply", () => {
  it("others' replies leave room for the owner's", async () => {
    const w = await ownerOf("room");
    const [r1, r2] = [await run(w, "running", "others"), await run(w, "running", "others")];
    const olderOthers = await run(w, "queued", "others", 30);
    const newerOwn = await run(w, "queued", "own", 10);

    expect((await app.agentPort.claimNext())?.id).toBe(newerOwn);
    expect(await statusOf(olderOthers)).toBe("queued");
    // All three places are in use now.
    expect(await app.agentPort.claimNext()).toBeNull();

    await end(r1);
    await end(newerOwn);
    expect((await app.agentPort.claimNext())?.id).toBe(olderOthers);
    await end(r2);
  });

  it("the owner's own replies may use every place", async () => {
    const w = await ownerOf("every");
    for (let i = 0; i < 3; i++) await run(w, "running", "own");
    await run(w, "queued", "own", 20);
    await run(w, "queued", "others", 20);
    const other = await ownerOf("another");
    const theirs = await run(other, "queued", "own", 1);

    expect((await app.agentPort.claimNext())?.id).toBe(theirs);
    expect(await app.agentPort.claimNext()).toBeNull();
  });

  it("a draft counts as the owner's own", async () => {
    const w = await ownerOf("draft");
    await db.query("insert into agent_runs (purpose, owner_id, status, started_at, caller_id, lane) values ('draft', $1, 'running', now(), $1, 'own')", [w.owner.id]);
    await run(w, "running", "others");
    const others = await run(w, "queued", "others", 20);
    const own = await run(w, "queued", "own", 10);

    // The draft is not one of the others' two places, but it is one of the three.
    expect((await app.agentPort.claimNext())?.id).toBe(others);
    expect(await app.agentPort.claimNext()).toBeNull();
    expect(await statusOf(own)).toBe("queued");
  });

  it("logs how long the reply waited, with its lane, once per claim", async () => {
    const w = await ownerOf("wait");
    const id = await run(w, "queued", "others", 5);
    lines.length = 0;
    expect((await app.agentPort.claimNext())?.id).toBe(id);
    const waits = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.metric === "run_wait_ms");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ metric: "run_wait_ms", lane: "others", level: 30 });
    expect(waits[0]!.ms).toBeGreaterThanOrEqual(5000);
    expect(waits[0]!.ms).toBeLessThan(30_000);
  });
});
