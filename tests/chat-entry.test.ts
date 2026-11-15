import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
vi.mock("../server/matrix-account", () => ({
  matrixOptions: () =>
    process.env.TEST_CHAT_ENTRY === "enabled"
      ? { elementUrl: "https://chat.example.test/" }
      : null,
}));
import { registerChatEntry } from "../server/chat-entry";

afterEach(() => vi.unstubAllEnvs());
async function request(
  url: string,
  enabled = true,
  method: "GET" | "HEAD" = "GET",
) {
  vi.stubEnv("TEST_CHAT_ENTRY", enabled ? "enabled" : "disabled");
  const app = Fastify();
  registerChatEntry(app);
  app.get("/*", () => "workbench");
  try {
    return await app.inject({ url, method });
  } finally {
    await app.close();
  }
}
describe("upstream chat entry", () => {
  it("opens Element from the primary URL and the chat shortcut", async () => {
    for (const url of ["/", "/chat"]) {
      const r = await request(url);
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe("https://chat.example.test/");
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });
  it("keeps invitation parameters on the original origin", async () => {
    const r = await request(
      "/?invite=private-token&next=https%3A%2F%2Fevil.test",
    );
    expect(r.headers.location).toBe(
      "/workbench?invite=private-token&next=https%3A%2F%2Fevil.test",
    );
  });
  it("does not redirect workbench, APIs or unconfigured installations", async () => {
    for (const url of ["/workbench", "/workbench?invite=x", "/api/health"]) {
      expect((await request(url)).statusCode).toBe(200);
    }
    expect((await request("/", false)).body).toBe("workbench");
  });
  it("supports HEAD without changing the destination", async () => {
    expect((await request("/", true, "HEAD")).headers.location).toBe(
      "https://chat.example.test/",
    );
  });
});
