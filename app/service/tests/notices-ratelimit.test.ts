import { describe, expect, it } from "vitest";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Scale 1: writes that append a system notice others cannot stop — blocking and unblocking (in the pair's
 * direct chat), renaming a group and adding or removing members (in the group) — are limited to 20 per
 * minute per principal: block + unblock share one budget, rename + add + remove (and leave) another, and halting a
 * group's Agents (`POST …/agents/halt`) a third.
 */
const { app, db } = useApp({ env: { RATE_LIMIT_SCALE: "1" } });

const notices = async (conversationId: string) =>
  Number((await db.query("select count(*) n from messages where conversation_id = $1 and kind = 'system'", [conversationId])).rows[0].n);

describe("notice-producing writes", () => {
  it("block and unblock together: 20 per minute per principal, then 429 and no notice; the other side is unaffected", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    const block = (who: Actor, other: Actor) => api(app, who, "PUT", `/api/blocks/${other.id}`);
    const unblock = (who: Actor, other: Actor) => api(app, who, "DELETE", `/api/blocks/${other.id}`);

    for (let i = 0; i < 10; i++) {
      expect((await block(a, b)).status).toBe(200);
      expect((await unblock(a, b)).status).toBe(200);
    }
    expect(await notices(dm)).toBe(20);
    expect(await block(a, b)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect(await unblock(a, b)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect(await notices(dm)).toBe(20);
    // The other side has a budget of its own.
    expect((await block(b, a)).status).toBe(200);
    expect(await notices(dm)).toBe(21);
  });

  it("rename, add and remove (or leave) together: 20 per minute per principal, then 429 and no notice", async () => {
    const [a, b, c, d] = [await signUp(app, "carol"), await signUp(app, "dave"), await signUp(app, "erin"), await signUp(app, "frank")];
    const g = await group(app, a, "team", [b, c]);
    await befriend(app, a, d);
    const before = await notices(g);

    for (let i = 0; i < 9; i++) {
      expect((await api(app, a, "POST", `/api/conversations/${g}/members`, { principalId: d.id })).status).toBe(201);
      expect((await api(app, a, "DELETE", `/api/conversations/${g}/members/${d.id}`)).status).toBe(200);
    }
    expect((await api(app, a, "PATCH", `/api/conversations/${g}`, { title: "renamed" })).status).toBe(200);
    expect((await api(app, a, "PATCH", `/api/conversations/${g}`, { title: "renamed" })).status).toBe(200); // no change, still counted
    expect(await notices(g)).toBe(before + 19);

    expect(await api(app, a, "POST", `/api/conversations/${g}/members`, { principalId: d.id })).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect(await api(app, a, "PATCH", `/api/conversations/${g}`, { title: "again" })).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect(await api(app, a, "DELETE", `/api/conversations/${g}/members/${a.id}`)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect(await notices(g)).toBe(before + 19);

    // Another member has a budget of their own.
    expect((await api(app, b, "DELETE", `/api/conversations/${g}/members/${b.id}`)).status).toBe(200);
    expect(await notices(g)).toBe(before + 20);
  });

  it("halting a group's Agents: 20 per minute per principal, a budget of its own, then 429 and no notice", async () => {
    const [a, b, c] = [await signUp(app, "gina"), await signUp(app, "hank"), await signUp(app, "ivy")];
    const g = await group(app, a, "halts", [b, c]);
    const halt = (who: Actor) => api(app, who, "POST", `/api/conversations/${g}/agents/halt`);
    const say = (text: string, n: number) => api(app, b, "POST", `/api/conversations/${g}/messages`, { text, clientTxn: `h${n}` });
    const before = await notices(g);
    // A person writing between halts makes each one a new halt with its notice.
    for (let i = 0; i < 10; i++) {
      expect((await halt(a)).status).toBe(200);
      expect((await halt(a)).status).toBe(200); // halted already: nothing appended, still counted
      expect((await say(`继续 ${i}`, i)).status).toBe(201);
    }
    expect(await notices(g)).toBe(before + 10);
    expect(await halt(a)).toEqual({ status: 429, json: { error: "rate_limited" } });
    expect(await notices(g)).toBe(before + 10);
    // Renaming is another budget; another member has a halt budget of their own.
    expect((await api(app, a, "PATCH", `/api/conversations/${g}`, { title: "renamed" })).status).toBe(200);
    expect((await halt(c)).status).toBe(200);
    expect(await notices(g)).toBe(before + 12);
  });
});
