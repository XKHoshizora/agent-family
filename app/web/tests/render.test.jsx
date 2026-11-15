// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StoreProvider, emptyState } from "../src/data/store.jsx";
import { ChatView } from "../src/pages/ChatView.jsx";

const person = (id, name) => ({ id, kind: "person", name, handle: `@${id}`, cell: [0, 0] });
const text = (id, from, body, extra = {}) => ({ id, from, kind: "text", text: body, at: "10:00", status: "read", ...extra });
const quoting = (id, from, body) => ({ replyTo: id, quote: { seq: Number(id.slice(1)), visible: true, from, text: body, kind: "text", attachmentName: null } });

function stateWithChats() {
  const s = emptyState(person("me", "你"));
  s.people.ann = person("ann", "小安");
  s.people.bo = person("bo", "阿波");
  s.convs.d1 = {
    id: "d1",
    type: "human",
    title: null,
    members: ["me", "ann"],
    admin: null,
    unread: 0,
    at: "10:02",
    cutoffs: {},
    messages: [text("m1", "ann", "早上好"), text("m2", "me", "早", quoting("m1", "ann", "早上好")), text("m3", "ann", "今天见面吗")],
  };
  s.convs.g1 = {
    id: "g1",
    type: "group",
    title: "周末小组",
    members: ["me", "ann", "bo"],
    admin: "me",
    unread: 0,
    at: "10:05",
    cutoffs: {},
    messages: [text("m1", "bo", "周六可以吗"), text("m2", "ann", "可以", quoting("m1", "bo", "周六可以吗")), text("m3", "me", "好的")],
  };
  s.order = ["g1", "d1"];
  s.nav.convId = "d1";
  return s;
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

function mount(convId) {
  const state = stateWithChats();
  return render(
    <StoreProvider initialState={state}>
      <ChatView conv={state.convs[convId]} />
    </StoreProvider>,
  );
}

describe("chat view smoke", () => {
  it("renders a direct chat with a reply quote", () => {
    mount("d1");
    expect(screen.getByText("今天见面吗")).toBeTruthy();
    expect(screen.getByText("早上好", { selector: "blockquote" })).toBeTruthy();
    expect(screen.queryByText("群资料")).toBeNull();
  });

  it("renders a group chat with its group profile button", () => {
    mount("g1");
    expect(screen.getByRole("heading", { name: "周末小组" })).toBeTruthy();
    expect(screen.getByText("周六可以吗", { selector: "blockquote" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "群资料" })).toBeTruthy();
  });
});
