import { describe, expect, it } from "vitest";
import type { ModelEvent, ModelGateway } from "../src/models/gateway.ts";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * The clean-up the harness does between tests (`useApp`): the truncate runs outside the app's statement timeout, and
 * starts only when what the previous test left running in the app is over. Each pair of tests below is one thing and
 * what it leaves behind; the second test of the pair finds out what the hook before it did. Order matters (tests of a
 * file run one after another, in the order written).
 */

let replyEnded = false;
/** Answers after a real pause: a reply still going when the test that asked for it has ended. */
const slow: ModelGateway = {
  async *stream(call): AsyncGenerator<ModelEvent> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 300);
      call.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(call.signal!.reason)), { once: true });
    });
    yield { type: "text", delta: "好的。" };
    replyEnded = true;
    yield { type: "finish", usage: null, truncated: false, toolCalls: [], assistant: [] };
  },
  async listModels() {
    return [];
  },
};

const POOL_MS = 1000;
const { app, db } = useApp({ env: { ...SITE_ENV, DB_STATEMENT_TIMEOUT_MS: String(POOL_MS) }, models: slow });

let lockReleased = false;

describe("the truncate between tests", () => {
  it("(setup) a test ends while a lock on a table still holds for longer than the app's statement timeout", async () => {
    const holder = await db.pool.connect();
    await holder.query("begin");
    await holder.query("lock table principals in access exclusive mode");
    // Let go on its own, after the pool's timeout, once this test has ended.
    setTimeout(() => {
      void holder.query("rollback").finally(() => {
        lockReleased = true;
        holder.release();
      });
    }, POOL_MS * 1.5).unref();
    expect(lockReleased).toBe(false);
  });

  it("waits for that lock under a limit of its own: the app's one-second statement timeout does not cut it off", async () => {
    // The hook before this test has run: it waited for the lock (it would have failed with 57014 under the pool's timeout).
    expect(lockReleased).toBe(true);
    expect((await db.query("select count(*)::int n from principals")).rows[0].n).toBe(0);
  });
});
