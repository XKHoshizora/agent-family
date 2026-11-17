// @vitest-environment jsdom
// Every link of the third review that forged, hid or reversed the old "（实际指向 host）" note, against the round-3 rule:
// nothing is detected any more; every link is followed by its real host (taken from the parsed target only), unless its
// visible text is exactly that address or host; bidirectional controls are gone before anything is shown.
import "./markdown-ready.js";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AgentText } from "../src/pages/AgentChatBits.jsx";
import { shownHost } from "../src/ui/markdownTree.js";
import { LINK_CASES } from "./hostile-links.js";
import { settle } from "./markdown-worker.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function show(text) {
  const { container } = render(
    <div className="bubble">
      <AgentText text={text} />
    </div>,
  );
  await settle();
  return container.firstChild;
}

/** The only case whose text is its link's address exactly (host and port): no host after it. */
const TEXT_IS_THE_ADDRESS = new Set(["port in text same host"]);

describe("the third review's link forgeries: every link shows its real host", () => {
  it.each(LINK_CASES)("%s", async (label, text) => {
    const errors = vi.spyOn(console, "error");
    const bubble = await show(text);
    const links = [...bubble.querySelectorAll("a")];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      const href = a.getAttribute("href");
      const host = a.nextElementSibling?.matches(".md-host") ? a.nextElementSibling.textContent : null;
      if (TEXT_IS_THE_ADDRESS.has(label)) expect(host).toBeNull();
      else expect(host, `${a.textContent} → ${href}`).toBe(`（${shownHost(href)}）`);
      // The host shown is the parsed target's, Punycode, never more than 40 characters; the tooltip is the address.
      if (host) expect(host.length).toBeLessThanOrEqual(42);
      expect(a.getAttribute("title")).toBe(href);
      expect(a.closest(".md-link").getAttribute("dir")).toBe("auto");
    }
    expect(bubble.textContent).not.toMatch(/[‪-‮⁦-⁩‎‏؜]/);
    expect(errors).not.toHaveBeenCalled();
  });

  it("the homograph cases show the target's Punycode host", async () => {
    const bubble = await show("[bank.example](https://bаnk.example/) https://аррlе.com/login");
    const punycode = ["https://bаnk.example/", "https://аррlе.com/"].map((url) => new URL(url).host);
    expect(punycode.every((host) => host.startsWith("xn--"))).toBe(true);
    expect([...bubble.querySelectorAll(".md-host")].map((el) => el.textContent)).toEqual(punycode.map((host) => `（${host}）`));
  });

  it("a long target host shows its end, where its registrable part is", async () => {
    const host = "bank.example.secure-login.account-verify.session-0123456789.evil.example";
    const bubble = await show(`[bank.example](https://${host}/)`);
    expect(bubble.querySelector(".md-host").textContent).toBe(`（…${host.slice(-39)}）`);
    expect(host.slice(-39)).toMatch(/evil\.example$/);
  });
});
