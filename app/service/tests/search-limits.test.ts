import { describe, expect, it, vi } from "vitest";
import { MAX_CONCURRENT_SEARCHES } from "../src/messages/search.ts";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { listen } from "./helpers/ws.ts";

const SEARCH_MS = 600;
const POOL_MS = 1500;
const { app, db } = useApp({ env: { SEARCH_STATEMENT_TIMEOUT_MS: String(SEARCH_MS), DB_STATEMENT_TIMEOUT_MS: String(POOL_MS) } });

const BUSY = { status: 503, json: { error: "busy" } };

/** Holds an exclusive lock on `messages` (every search waits on it) until the returned function is called. */
async function blockMessages(): Promise<() => Promise<void>> {
  const client = await db.pool.connect();
  await client.query("begin");
  await client.query("lock table messages in access exclusive mode");
  return async () => {
    await client.query("rollback");
    client.release();
  };
}

async function pair() {
  const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
  const { conversationId: dm } = await befriend(app, a, b);
  await api(app, a, "POST", `/api/conversations/${dm}/messages`, { text: "find me", clientTxn: "t1" });
  return { a, b, dm };
}

describe("search in-flight cap", () => {
  it(`allows ${MAX_CONCURRENT_SEARCHES} searches in flight per principal across both routes; one more is 429; others are unaffected`, async () => {
    const { a, b, dm } = await pair();
    const release = await blockMessages();
    let first, second, others;
    try {
      first = api(app, a, "GET", "/api/search?q=find");
      second = api(app, a, "GET", `/api/conversations/${dm}/search?q=find`);
      await vi.waitFor(() => expect(app.deps.searches.inProgress(a.id)).toBe(2));
      expect(await api(app, a, "GET", "/api/search?q=find")).toEqual({ status: 429, json: { error: "rate_limited" } });
      expect(await api(app, a, "GET", `/api/conversations/${dm}/search?q=find`)).toEqual({ status: 429, json: { error: "rate_limited" } });
      others = api(app, b, "GET", "/api/search?q=find"); // b has slots of its own
      await vi.waitFor(() => expect(app.deps.searches.inProgress(b.id)).toBe(1));
    } finally {
      await release();
    }
    // Released before the search timeout (normally): they finish. A slow machine may see them time out.
    for (const r of await Promise.all([first, second, others])) expect([200, 503]).toContain(r!.status);
    expect(app.deps.searches.inProgress()).toBe(0);
    expect((await api(app, a, "GET", "/api/search?q=find")).status).toBe(200);
  });

  it("a search whose client went away keeps its slot until its work ends, then gives it back", async () => {
    const { a } = await pair();
    const { http } = await listen(app);
    const release = await blockMessages();
    try {
      const abort = new AbortController();
      const gone = fetch(`${http}/api/search?q=find`, { headers: { cookie: a.cookie }, signal: abort.signal }).catch(() => "aborted");
      await vi.waitFor(() => expect(app.deps.searches.inProgress(a.id)).toBe(1));
      abort.abort();
      expect(await gone).toBe("aborted");
      // The statement is still running in the database: the slot stays taken.
      await new Promise((r) => setTimeout(r, 100));
      expect(app.deps.searches.inProgress(a.id)).toBe(1);
    } finally {
      await release();
    }
    await vi.waitFor(() => expect(app.deps.searches.inProgress()).toBe(0));
  });
});

describe("search statement timeout", () => {
  it(`a search running longer than SEARCH_STATEMENT_TIMEOUT_MS is cut off with 503 busy and gives its slot back`, async () => {
    const { a, dm } = await pair();
    const release = await blockMessages();
    try {
      for (const url of ["/api/search?q=find", `/api/conversations/${dm}/search?q=find`]) {
        const t0 = performance.now();
        expect(await api(app, a, "GET", url)).toEqual(BUSY);
        const took = performance.now() - t0;
        // Its own timeout, not the pool's.
        expect(took).toBeGreaterThanOrEqual(SEARCH_MS - 50);
        expect(took).toBeLessThan(POOL_MS);
      }
    } finally {
      await release();
    }
    expect(app.deps.searches.inProgress()).toBe(0);
    expect((await api(app, a, "GET", "/api/search?q=find")).json.messages).toHaveLength(1);
  });
});
