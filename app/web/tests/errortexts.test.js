import { describe, expect, it } from "vitest";
import { friendErrorText, groupErrorText } from "../src/data/errorTexts.js";

const GENERIC = "操作没有成功，请稍后再试。";
const err = (code, status = 400) => ({ code, status, reason: null });

// Every code app/service/README.md documents for each route (plus the shared ones any route can answer).
const SHARED = ["rate_limited", "busy", "network_error", "invalid_request"];
const FRIEND_ROUTES = {
  lookup: ["not_found", "invalid_request", "rate_limited"],
  sendRequest: ["not_found", "invalid_request", "blocked", "already_friends", "request_pending", "rate_limited"],
  accept: ["not_found", "request_not_pending", "request_expired", "blocked"],
  reject: ["not_found", "request_not_pending", "request_expired"],
  withdraw: ["not_found", "request_not_pending", "request_expired"],
  unfriend: ["not_found"],
  block: ["invalid_request", "not_found", "rate_limited"],
  unblock: ["rate_limited"],
};
const GROUP_ROUTES = {
  create: ["invalid_request", "forbidden", "rate_limited"],
  rename: ["not_found", "forbidden", "invalid_request", "rate_limited"],
  add: ["not_found", "already_member", "forbidden", "rate_limited"],
  remove: ["not_found", "forbidden", "rate_limited"],
  leave: ["not_found", "rate_limited"],
};

describe("friend and block refusals", () => {
  for (const [route, codes] of Object.entries(FRIEND_ROUTES)) {
    it(`${route}: every documented code has its own Chinese text, an unknown one is generic`, () => {
      for (const code of [...codes, ...SHARED]) {
        const text = friendErrorText(route, err(code));
        expect(text, `${route}/${code}`).toMatch(/[一-鿿]/);
        expect(text, `${route}/${code}`).not.toBe(GENERIC);
      }
      expect(friendErrorText(route, err("something_new"))).toBe(GENERIC);
      expect(friendErrorText(route, undefined)).toBe(GENERIC);
    });
  }
  it("the same code reads differently where it means something different", () => {
    expect(friendErrorText("accept", err("blocked"))).not.toBe(friendErrorText("sendRequest", err("blocked")));
    expect(friendErrorText("lookup", err("not_found"))).not.toBe(friendErrorText("accept", err("not_found")));
  });
});

describe("group refusals", () => {
  for (const [route, codes] of Object.entries(GROUP_ROUTES)) {
    it(`${route}: every documented code has its own Chinese text, an unknown one is generic`, () => {
      for (const code of [...codes, ...SHARED]) {
        const text = groupErrorText(route, err(code));
        expect(text, `${route}/${code}`).toMatch(/[一-鿿]/);
        expect(text, `${route}/${code}`).not.toBe(GENERIC);
      }
      expect(groupErrorText(route, err("something_new"))).toBe(GENERIC);
    });
  }
  it("forbidden says what it means on each route", () => {
    expect(groupErrorText("add", err("forbidden"))).toContain("500");
    expect(groupErrorText("create", err("forbidden"))).toContain("500");
    expect(groupErrorText("rename", err("forbidden"))).toContain("创建者");
    expect(groupErrorText("remove", err("forbidden"))).toContain("创建者");
    expect(groupErrorText("add", err("already_member"))).toBe("对方已经在群里了。");
    expect(groupErrorText("add", err("rate_limited"))).toContain("太频繁");
  });
});
