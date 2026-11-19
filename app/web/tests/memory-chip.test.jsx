// @vitest-environment jsdom
// What the owner is told when their Agent remembered something: the small 记忆已更新 chip (closed; opened it lists what
// changed, each line with its vault tag, and 撤销), the two confirmation cards, the full-room hint, the stale refusal —
// only in the owner's own conversation with the Agent, never in a group.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, ME_ID, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, deferred, group, notice, syncOf, wire } from "./fixtures.js";
import { StoreProvider, emptyState, useStore } from "../src/data/store.jsx";
import { MemoryNotice } from "../src/pages/MemoryChip.jsx";
import { click, installBrowser, mainText, openApp, push } from "./harness.jsx";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SITE_FREE = { source: "site", id: "free-1" };
const BASE = [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "我不吃辣")];
const LINES = ["记住了：不吃辣", "锁进了保险箱：住在上海"];

/** The `memory_changed` notice of the wire contract at `seq`; `fields` override. */
const changed = (seq, fields = {}) =>
  notice(A1, seq, "记忆已更新", {
    event: "memory_changed",
    actorId: AG1,
    changeId: "c1",
    lines: LINES,
    vaultLines: [false, true],
    pending: false,
    unlock: false,
    full: false,
    status: "applied",
    ...fields,
  });

async function openChat(messages, { api = {}, deleted = false } = {}) {
  const record = agentOf(AG1, { model: SITE_FREE, deleted });
  const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  const conversation = agentConv(A1, AG1, { lastSeq, readSeq: lastSeq, agent: { paused: false, deleted }, canSend: deleted ? { ok: false, reason: "agent_deleted" } : { ok: true } });
  const app = await openApp({
    sync: () => syncOf([conversation], messages, [...PRINCIPALS, agentPrincipal()]),
    api: {
      undoMemoryChange: vi.fn(async () => ({ status: "undone" })),
      confirmMemoryChange: vi.fn(async () => ({ status: "applied" })),
      discardMemoryChange: vi.fn(async () => ({ status: "discarded" })),
      listProviders: vi.fn(async () => ({ providers: [] })),
      ...api,
    },
    handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run: null }), models: () => MODELS },
  });
  await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
  return app;
}

const timeline = () => document.querySelector("ol.messages");
const li = (seq) => timeline().querySelector(`li[data-msg="m${seq}"]`);
const inLi = (seq) => within(li(seq));

describe("the 记忆已更新 chip", () => {
  it("an applied change is a small chip, closed: it says only 记忆已更新", async () => {
    await openChat([...BASE, changed(3)]);
    expect(li(3).textContent).toBe("记忆已更新");
    const chip = inLi(3).getByRole("button", { name: "记忆已更新" });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(inLi(3).queryByRole("button", { name: "撤销" })).toBeNull();
  });

  it("opened, it lists the lines with the vault ones tagged 保险箱, and 撤销", async () => {
    await openChat([...BASE, changed(3)]);
    await click(inLi(3).getByRole("button", { name: "记忆已更新" }));
    const items = [...li(3).querySelectorAll("li, .memory-line")].map((x) => x.textContent);
    expect(items).toEqual(["记住了：不吃辣", "锁进了保险箱：住在上海保险箱"]);
    expect(inLi(3).getByRole("button", { name: "撤销" })).toBeTruthy();
    expect(li(3).querySelectorAll(".tag").length).toBe(1);
  });

  it("撤销 calls the undo route and the chip then says 已撤销", async () => {
    const { api } = await openChat([...BASE, changed(3)]);
    await click(inLi(3).getByRole("button", { name: "记忆已更新" }));
    await click(inLi(3).getByRole("button", { name: "撤销" }));
    expect(api.undoMemoryChange).toHaveBeenCalledWith(AG1, "c1");
    expect(inLi(3).getByText("已撤销")).toBeTruthy();
    expect(inLi(3).queryByRole("button", { name: "撤销" })).toBeNull();
  });

  it("a change already undone reads 已撤销 when opened", async () => {
    await openChat([...BASE, changed(3, { status: "undone" })]);
    await click(inLi(3).getByRole("button", { name: "记忆已更新" }));
    expect(inLi(3).getByText("已撤销")).toBeTruthy();
    expect(inLi(3).queryByRole("button", { name: "撤销" })).toBeNull();
  });

  it("a stale undo (409) says so, keeps the lines and leaves no action button", async () => {
    const undoMemoryChange = vi.fn(async () => {
      throw apiError(409, "stale_change");
    });
    await openChat([...BASE, changed(3)], { api: { undoMemoryChange } });
    await click(inLi(3).getByRole("button", { name: "记忆已更新" }));
    await click(inLi(3).getByRole("button", { name: "撤销" }));
    expect(inLi(3).getByRole("alert").textContent).toBe("这条改动已经过时了：记忆后来又变过。");
    expect(inLi(3).queryByText("已撤销")).toBeNull();
    expect(inLi(3).queryByRole("button", { name: "撤销" })).toBeNull();
    expect(li(3).textContent).toContain("记住了：不吃辣");
  });

  it("full: the closed chip says 快满了; opened, the hint is there", async () => {
    await openChat([...BASE, changed(3, { full: true })]);
    expect(li(3).textContent).toBe("记忆已更新 · 快满了");
    await click(inLi(3).getByRole("button", { name: "记忆已更新 · 快满了" }));
    expect(inLi(3).getByRole("button", { name: "记忆宫殿快满了，去整理一下。" })).toBeTruthy();
  });

  it("the hint's link goes to the settings page memory (the palace's)", () => {
    const Probe = () => {
      const { state } = useStore();
      return <output>{`${state.nav.section}/${state.nav.settingsPage}`}</output>;
    };
    const msg = { id: "m3", seq: 3, kind: "system", text: "记忆已更新", system: { event: "memory_changed", changeId: "c1", lines: LINES, vaultLines: [false, true], pending: false, unlock: false, full: true, status: "applied" } };
    render(
      <StoreProvider initialState={emptyState()}>
        <Probe />
        <ol>
          <MemoryNotice msg={msg} conv={{ type: "agent", agentId: AG1, id: A1 }} />
        </ol>
      </StoreProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "记忆已更新 · 快满了" }));
    fireEvent.click(screen.getByRole("button", { name: "记忆宫殿快满了，去整理一下。" }));
    expect(screen.getByRole("status").textContent).toBe("settings/memory");
  });

  it("in a deleted Agent's conversation 撤销 is off", async () => {
    await openChat([...BASE, changed(3)], { deleted: true });
    await click(inLi(3).getByRole("button", { name: "记忆已更新" }));
    expect(inLi(3).getByRole("button", { name: "撤销" }).disabled).toBe(true);
  });

  it("a push of the same notice with a new status replaces it", async () => {
    const { transport } = await openChat([...BASE, changed(3)]);
    await click(inLi(3).getByRole("button", { name: "记忆已更新" }));
    await push(transport, { type: "message", message: changed(3, { status: "undone" }) });
    expect(inLi(3).getByText("已撤销")).toBeTruthy();
  });
});

describe("the confirmation cards", () => {
  const pending = (fields = {}) => changed(3, { pending: true, status: "pending", ...fields });

  it("a pending change is the card 要记住这些吗？ with its lines, 记住 and 不用", async () => {
    await openChat([...BASE, pending()]);
    expect(li(3).textContent).toContain("要记住这些吗？");
    expect(li(3).textContent).toContain("记住了：不吃辣");
    expect(inLi(3).getByRole("button", { name: "记住" })).toBeTruthy();
    expect(inLi(3).getByRole("button", { name: "不用" })).toBeTruthy();
    expect(inLi(3).queryByRole("button", { name: "记忆已更新" })).toBeNull();
  });

  it("记住 confirms: the route is called and the card becomes the chip", async () => {
    const { api } = await openChat([...BASE, pending()]);
    await click(inLi(3).getByRole("button", { name: "记住" }));
    expect(api.confirmMemoryChange).toHaveBeenCalledWith(AG1, "c1");
    expect(li(3).textContent).toBe("记忆已更新");
  });

  it("不用 discards: the route is called and the card goes", async () => {
    const { api } = await openChat([...BASE, pending()]);
    await click(inLi(3).getByRole("button", { name: "不用" }));
    expect(api.discardMemoryChange).toHaveBeenCalledWith(AG1, "c1");
    expect(li(3).textContent).toBe("");
  });

  it("an unlock is the card 要把这条从保险箱取出来吗？ with 取出 and 不用", async () => {
    const { api } = await openChat([...BASE, pending({ unlock: true, lines: ["取出来：住在上海"], vaultLines: [true] })]);
    expect(li(3).textContent).toContain("要把这条从保险箱取出来吗？");
    expect(inLi(3).queryByRole("button", { name: "记住" })).toBeNull();
    await click(inLi(3).getByRole("button", { name: "取出" }));
    expect(api.confirmMemoryChange).toHaveBeenCalledWith(AG1, "c1");
    expect(inLi(3).getByRole("button", { name: "记忆已更新" })).toBeTruthy();
  });

  it("a stale confirm (409) says so, keeps the lines and leaves no button", async () => {
    const confirmMemoryChange = vi.fn(async () => {
      throw apiError(409, "stale_change");
    });
    await openChat([...BASE, pending()], { api: { confirmMemoryChange } });
    await click(inLi(3).getByRole("button", { name: "记住" }));
    expect(inLi(3).getByRole("alert").textContent).toBe("这条改动已经过时了：记忆后来又变过。");
    expect(inLi(3).queryByRole("button", { name: "记住" })).toBeNull();
    expect(inLi(3).queryByRole("button", { name: "不用" })).toBeNull();
    expect(li(3).textContent).toContain("记住了：不吃辣");
  });

  it("in a deleted Agent's conversation the card's buttons are off", async () => {
    await openChat([...BASE, pending()], { deleted: true });
    expect(inLi(3).getByRole("button", { name: "记住" }).disabled).toBe(true);
    expect(inLi(3).getByRole("button", { name: "不用" }).disabled).toBe(true);
  });

  it("one decision at a time while one is on its way", async () => {
    const wait = deferred();
    const { api } = await openChat([...BASE, pending()], { api: { confirmMemoryChange: vi.fn(() => wait.promise) } });
    await click(inLi(3).getByRole("button", { name: "记住" }));
    expect(inLi(3).getByRole("button", { name: "不用" }).disabled).toBe(true);
    expect(api.discardMemoryChange).not.toHaveBeenCalled();
  });
});

describe("never in a group", () => {
  it("a memory notice in a group shows nothing", async () => {
    const G = "00000000-0000-4000-8000-0000000000c2";
    const members = [ME_ID, ANN].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
    const messages = [wire(G, 1, ANN, "大家好"), notice(G, 2, "记忆已更新", { event: "memory_changed", actorId: AG1, changeId: "c9", lines: ["记住了：x"], pending: false, unlock: false, full: false, status: "applied" })];
    const conversation = group(G, { members, lastSeq: 2, readSeq: 2 });
    await openApp({ sync: () => syncOf([conversation], messages, PRINCIPALS), handlers: { models: () => MODELS } });
    await click(screen.getByText(conversation.title, { selector: ".list-col .row-name" }));
    expect(timeline().textContent).toContain("大家好");
    expect(mainText()).not.toContain("记忆已更新");
    expect(mainText()).not.toContain("记住了");
  });
});
