import { describe, expect, it } from "vitest";
import { agentErrorText, friendErrorText, groupErrorText, noQuotaText, providerErrorText, replyErrorText, runFailureText } from "../src/data/errorTexts.js";

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

// ───────── Agents, replies and providers (batch 2A): every code app/service/README.md documents for each route.
const AGENT_ROUTES = {
  create: ["handle_taken", "agent_limit", "invalid_request", "rate_limited"],
  edit: ["agent_deleted", "not_found", "invalid_request", "rate_limited"],
  pause: ["agent_deleted", "not_found", "rate_limited"],
  resume: ["agent_deleted", "not_found", "rate_limited"],
  delete: ["not_found", "rate_limited"],
  avatar: ["invalid_request", "too_large", "agent_deleted", "not_found", "rate_limited"],
  draft: ["invalid_request", "no_quota", "context_too_small", "rate_limited", "provider_rejected", "provider_unavailable", "address_not_allowed", "busy"],
  confirm: ["not_found", "agent_deleted", "stale_proposal", "invalid_request", "rate_limited"],
  discard: ["not_found", "agent_deleted", "stale_proposal", "rate_limited"],
};
const REPLY_ROUTES = {
  stop: ["not_found", "rate_limited"],
  retry: ["busy_run", "agent_paused", "agent_deleted", "invalid_request", "not_found", "rate_limited"],
  dismiss: ["not_found", "rate_limited"],
  topic: ["cannot_send", "not_found", "rate_limited"],
};
const PROVIDER_ROUTES = {
  create: ["provider_limit", "name_taken", "invalid_request", "rate_limited"],
  edit: ["name_taken", "invalid_request", "not_found", "rate_limited"],
  delete: ["provider_in_use", "not_found", "rate_limited"],
  test: ["provider_rejected", "provider_unavailable", "address_not_allowed", "not_found", "rate_limited"],
  list: ["provider_rejected", "provider_unavailable", "address_not_allowed", "not_found", "rate_limited"],
};

for (const [label, textOf, routes] of [
  ["Agent", agentErrorText, AGENT_ROUTES],
  ["reply", replyErrorText, REPLY_ROUTES],
  ["provider", providerErrorText, PROVIDER_ROUTES],
]) {
  describe(`${label} refusals`, () => {
    for (const [route, codes] of Object.entries(routes)) {
      it(`${route}: every documented code has its own Chinese text, an unknown one is generic`, () => {
        for (const code of [...codes, ...SHARED]) {
          const text = textOf(route, err(code));
          expect(text, `${route}/${code}`).toMatch(/[一-鿿]/);
          expect(text, `${route}/${code}`).not.toBe(GENERIC);
        }
        expect(textOf(route, err("something_new"))).toBe(GENERIC);
        expect(textOf(route, undefined)).toBe(GENERIC);
      });
    }
  });
}

describe("the sentences batch 2A names", () => {
  const NOW = new Date(2026, 10, 16, 12, 0).getTime();
  it("each code reads as what it means", () => {
    expect(agentErrorText("create", err("agent_limit"))).toBe("你的 Agent 数量已达到当前档位的上限。");
    expect(agentErrorText("create", err("handle_taken"))).toBe("这个账号名已被占用，请换一个。");
    expect(agentErrorText("edit", err("agent_deleted"))).toBe("这个 Agent 已删除。");
    expect(replyErrorText("retry", err("agent_paused"))).toBe("这个 Agent 已暂停，恢复后才能重试。");
    expect(replyErrorText("retry", err("busy_run"))).toBe("它正在回复，请等这次回复结束。");
    expect(agentErrorText("confirm", err("stale_proposal"))).toBe("这份提议已失效，请让它重新生成提议。");
    expect(agentErrorText("draft", err("context_too_small"))).toContain("上下文");
    expect(providerErrorText("create", err("provider_limit"))).toBe("最多只能添加 10 个模型供应商。");
    expect(providerErrorText("create", err("name_taken"))).toBe("你已经有一个同名的供应商了，请换个名称。");
    expect(providerErrorText("test", err("address_not_allowed"))).toBe("这个接口地址不被允许：需要是 https 开头的公网地址。");
    // A saved key that can no longer be opened is answered provider_rejected too: the sentence asks for the key again.
    expect(providerErrorText("test", err("provider_rejected"))).toBe("供应商拒绝了这个密钥，或已保存的密钥无法再使用。请重新填写密钥并保存，然后再试。");
    expect(providerErrorText("list", err("provider_rejected"))).toBe("供应商拒绝了这个密钥，或已保存的密钥无法再使用。请重新填写密钥并保存，然后再试。");
    expect(providerErrorText("test", err("provider_unavailable"))).toBe("暂时连不上供应商，或它没有给出可用的回答，请稍后再试。");
    expect(agentErrorText("draft", err("busy", 503))).toBe("服务现在有点忙，请稍后再试。");
    // A 404 on the reply routes is "not yours / not here", never "it has ended".
    for (const route of ["stop", "retry", "dismiss", "topic"]) expect(replyErrorText(route, err("not_found", 404))).toBe("找不到要操作的内容，它可能已经不存在了。");
    expect(replyErrorText("stop", err("no_run", 0))).toBe("现在没有正在进行的回复。");
  });

  it("provider_in_use names the Agents that use it", () => {
    const inUse = { code: "provider_in_use", status: 409, agents: [{ id: "a", name: "小助手" }, { id: "b", name: "写作助手" }] };
    expect(providerErrorText("delete", inUse)).toBe("还有 Agent 在使用这个供应商：小助手、写作助手。请先给它们换一个模型。");
    expect(providerErrorText("delete", { code: "provider_in_use", status: 409 })).toBe("还有 Agent 在使用这个供应商，请先给它们换一个模型。");
  });

  it("测试连接: the provider's status is added when there is one; 404 or 405 means it has no model list", () => {
    const tested = (code, upstreamStatus) => providerErrorText("test", { code, status: 200, reason: null, upstreamStatus });
    expect(tested("provider_unavailable", "500")).toBe("暂时连不上供应商，或它没有给出可用的回答，请稍后再试。（供应商返回的状态码：500）");
    expect(tested("provider_rejected", "403")).toBe("供应商拒绝了这个密钥，或已保存的密钥无法再使用。请重新填写密钥并保存，然后再试。（供应商返回的状态码：403）");
    for (const status of ["404", "405"]) {
      expect(tested("provider_unavailable", status)).toBe(
        `这个供应商没有提供模型列表（状态码 ${status}），所以没能确认密钥是否可用。对话可能仍然可以使用，模型名称需要手动添加。`,
      );
    }
    expect(tested("provider_unavailable", undefined)).toBe("暂时连不上供应商，或它没有给出可用的回答，请稍后再试。");
    // Only a status number is ever added: anything else the answer might carry is not shown.
    expect(tested("provider_unavailable", "<b>oops</b>")).toBe("暂时连不上供应商，或它没有给出可用的回答，请稍后再试。");
    expect(tested("address_not_allowed", undefined)).toBe("这个接口地址不被允许：需要是 https 开头的公网地址。");
  });

  it("同步模型 (the model list) says what 测试连接 says, the provider's status and the missing model list included", () => {
    for (const [code, upstreamStatus] of [["provider_unavailable", "500"], ["provider_rejected", "401"], ["provider_unavailable", "404"], ["provider_unavailable", "405"], ["provider_unavailable", undefined], ["address_not_allowed", undefined]]) {
      const error = { code, status: 200, reason: null, upstreamStatus };
      expect([code, upstreamStatus, providerErrorText("list", error)]).toEqual([code, upstreamStatus, providerErrorText("test", error)]);
    }
  });

  it("no_quota: the free allowance and the balance are used up (with when it comes back), or the balance alone", () => {
    const tonight = new Date(2026, 10, 17, 0, 0).toISOString();
    expect(noQuotaText({ reason: "free_and_balance", resetsAt: tonight }, NOW)).toBe("今天的免费额度和余额都已用完，免费额度将在明天 00:00 重置。");
    expect(noQuotaText({ reason: "free_and_balance", resetsAt: new Date(2026, 10, 16, 16, 0).toISOString() }, NOW)).toBe("今天的免费额度和余额都已用完，免费额度将在今天 16:00 重置。");
    expect(noQuotaText({ reason: "free_and_balance", resetsAt: new Date(2026, 10, 20, 8, 5).toISOString() }, NOW)).toBe("今天的免费额度和余额都已用完，免费额度将在 11月20日 08:05 重置。");
    expect(noQuotaText({ reason: "free_and_balance" }, NOW)).toBe("今天的免费额度和余额都已用完，免费额度会在每天零点重置。");
    expect(noQuotaText({ reason: "balance" }, NOW)).toBe("余额不足：这个模型需要余额才能使用。");
    expect(agentErrorText("draft", { code: "no_quota", status: 402, reason: "balance" }, NOW)).toBe("余额不足：这个模型需要余额才能使用。");
  });

  it("a run's failure, for the status line under the conversation", () => {
    const tonight = new Date(2026, 10, 17, 0, 0).toISOString();
    const failed = (error, fields = {}) => ({ id: "r", status: "failed", error, retryable: true, ...fields });
    const texts = ["provider_rejected", "provider_unavailable", "address_not_allowed", "context_too_small", "busy"].map((code) => runFailureText(failed(code), NOW));
    for (const text of texts) expect(text).toMatch(/[一-鿿]/);
    expect(new Set(texts).size).toBe(texts.length);
    expect(runFailureText(failed("no_quota", { resetsAt: tonight }), NOW)).toBe("今天的免费额度和余额都已用完，免费额度将在明天 00:00 重置。");
    expect(runFailureText(failed("no_quota"), NOW)).toBe("余额不足：这个模型需要余额才能使用。");
    expect(runFailureText(failed("busy"), NOW)).toContain("没有扣费");
    expect(runFailureText(failed("something_new"), NOW)).toBe("这次没有回复成功。");
    expect(runFailureText({ id: "r", status: "cancelled", error: "agent_paused" }, NOW)).toBe("它已暂停，这次回复已取消。");
    expect(runFailureText({ id: "r", status: "cancelled", error: "agent_deleted" }, NOW)).toBe("它已删除，这次回复已取消。");
    // Nothing failed: a new topic left the reply nothing to answer; a finished or stopped reply; no run.
    expect(runFailureText({ id: "r", status: "cancelled" }, NOW)).toBe("");
    expect(runFailureText({ id: "r", status: "done" }, NOW)).toBe("");
    expect(runFailureText({ id: "r", status: "stopped" }, NOW)).toBe("");
    expect(runFailureText(null, NOW)).toBe("");
  });

  it("every error a failed run can carry has its own sentence (none falls back to the generic one)", () => {
    const failed = (error) => ({ id: "r", status: "failed", error, retryable: true });
    const codes = ["no_quota", "provider_rejected", "provider_unavailable", "address_not_allowed", "context_too_small", "busy", "rate_limited", "agent_paused", "agent_deleted"];
    const texts = codes.map((code) => runFailureText(failed(code), NOW));
    for (const [i, text] of texts.entries()) expect(text, codes[i]).not.toBe("这次没有回复成功。");
    expect(new Set(texts).size).toBe(codes.length);
    expect(runFailureText(failed("rate_limited"), NOW)).toBe("发得太快了，请稍后重试。");
    expect(runFailureText(failed("agent_paused"), NOW)).toBe("它已暂停，这次没有回复。");
    expect(runFailureText(failed("agent_deleted"), NOW)).toBe("它已删除，这次没有回复。");
  });

  it("a site model's key or address is not the owner's to check: its own sentence; a provider's (or unknown) as before", () => {
    const failed = (error) => ({ id: "r", status: "failed", error, retryable: false });
    const SITE = "站点提供的这个模型暂时用不了，请稍后重试，或换一个模型。";
    for (const code of ["provider_rejected", "provider_unavailable", "address_not_allowed"]) {
      expect(runFailureText(failed(code), NOW, "site"), code).toBe(SITE);
      expect(runFailureText(failed(code), NOW, "provider"), code).toBe(runFailureText(failed(code), NOW));
      expect(runFailureText(failed(code), NOW, null), code).not.toBe(SITE);
    }
    expect(runFailureText(failed("provider_rejected"), NOW, "provider")).toBe("供应商拒绝了密钥，这次没有回复。请到设置里检查密钥。");
    // The other codes read the same whatever the model.
    for (const code of ["context_too_small", "busy", "rate_limited", "no_quota"]) {
      expect(runFailureText(failed(code), NOW, "site"), code).toBe(runFailureText(failed(code), NOW, "provider"));
    }
  });
});
