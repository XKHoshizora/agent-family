import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogReadme, formatCatalog, reduceCatalog } from "../scripts/update-model-catalog.mjs";

/**
 * The vendored models.dev snapshot (src/providers/model-catalog.json): how the update script reduces the two catalogue
 * files (a fixture here: no network in tests), and that the committed snapshot is what `modelHints` expects.
 */

const effort = (...values: string[]) => [{ type: "effort", values }];
const MODELS = {
  "openai/GPT-Next": { id: "openai/GPT-Next", name: "GPT Next", reasoning: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 400000, output: 128000 } },
  "openai/o-mini": { name: "o mini", reasoning: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 200000 } },
  "anthropic/claude-x": { name: "Claude X", reasoning: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 1000000 } },
  "google/gemini-x": { name: "Gemini X", reasoning: true, modalities: { input: ["text", "image", "pdf", "audio", "video"], output: ["text"] }, limit: { context: 1048576 } },
  "minimax/MiniMax-X": { name: "MiniMax X", reasoning: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 0 } },
  "acme/thinker": { name: "Thinker", reasoning: true, modalities: { input: ["text"], output: ["text"] } },
  "acme/shy": { name: "Shy", reasoning: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 8000 } },
  "acme/plain": { name: "  Plain  ", reasoning: false, modalities: { input: ["text"], output: ["text"] }, limit: { context: 32768.5 } },
  "acme/embed-x": { name: "Embed X", type: "embedding", reasoning: false, modalities: { input: ["text"], output: ["text"] }, limit: { context: 8192 } },
  "acme/painter": { name: "Painter", type: "image", reasoning: false, modalities: { input: ["text", "image"], output: ["image"] } },
  "acme/ears": { name: "Ears", reasoning: false, modalities: { input: ["audio"], output: ["text"] } },
  "other/plain": { name: "Other\nplain", reasoning: false, modalities: { input: ["text"], output: ["text"] } },
  "acme/broken": "not an entry",
};
const API = {
  openai: { models: { "GPT-Next": { reasoning_options: effort("none", "minimal", "low", "medium", "high", "xhigh", "max") }, "o-mini": { reasoning_options: effort("high", "low", "medium") } } },
  anthropic: { models: { "claude-x": { reasoning_options: effort("low", "medium", "high", "xhigh", "max") } } },
  google: { models: { "gemini-x": { reasoning_options: [{ type: "budget_tokens", min: 128, max: 32768 }] } } },
  minimax: { models: { "MiniMax-X": { reasoning_options: [{ type: "toggle" }] } } },
  acme: { models: { shy: { reasoning_options: effort("none", "minimal", "turbo") }, plain: { reasoning_options: effort("low") } } },
  // Not the lab's own entry: another provider reselling the lab's model says nothing about it.
  resold: { models: { thinker: { reasoning_options: effort("low") } } },
};

describe("reduceCatalog (the update script)", () => {
  const reduced = reduceCatalog(MODELS, API);
  const byKey = new Map(reduced.map((e) => [`${e.lab}/${e.id}`, e]));

  it("keeps id, lab, display name, vision, pdf, reasoning, chat and the context; sorted by id, then lab", () => {
    expect(reduced.map((e) => `${e.lab}/${e.id}`)).toEqual([
      "anthropic/claude-x",
      "acme/ears",
      "acme/embed-x",
      "google/gemini-x",
      "openai/gpt-next",
      "minimax/minimax-x",
      "openai/o-mini",
      "acme/painter",
      "acme/plain",
      "other/plain",
      "acme/shy",
      "acme/thinker",
    ]);
    expect(byKey.get("openai/gpt-next")).toEqual({
      id: "gpt-next",
      lab: "openai",
      name: "GPT Next",
      vision: true,
      pdf: true,
      reasoning: true,
      chat: true,
      contextTokens: 400000,
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    // A context that is no positive whole number is left out; so is a display name that is not one line.
    expect(byKey.get("minimax/minimax-x")).not.toHaveProperty("contextTokens");
    expect(byKey.get("acme/thinker")).not.toHaveProperty("contextTokens");
    expect(byKey.get("acme/plain")).toEqual({ id: "plain", lab: "acme", name: "Plain", vision: false, pdf: false, reasoning: false, chat: true });
    expect(byKey.get("other/plain")!.name).toBe("plain");
  });

  it("chat: takes and answers text, and is not an embedding, image, … model by the catalogue's type", () => {
    expect([...byKey.values()].filter((e) => !e.chat).map((e) => e.id)).toEqual(["ears", "embed-x", "painter"]);
    expect(byKey.get("acme/painter")).toMatchObject({ vision: true, chat: false });
  });

  it("thinking levels: the lab's own effort values among ours, in our order; none for toggle, budget_tokens, no entry or nothing left", () => {
    expect(byKey.get("openai/gpt-next")!.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]); // none and minimal dropped
    expect(byKey.get("openai/o-mini")!.reasoningLevels).toEqual(["low", "medium", "high"]); // put in order
    expect(byKey.get("anthropic/claude-x")!.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const key of ["google/gemini-x", "minimax/minimax-x", "acme/shy", "acme/thinker", "acme/plain"]) expect([key, byKey.get(key)]).not.toHaveProperty([1, "reasoningLevels"]);
    // (acme/plain: levels given, but the model does not reason.)
  });

  it("refuses what is not a catalogue; reads without api.json too", () => {
    for (const bad of [null, [], "x", 1]) expect(() => reduceCatalog(bad)).toThrow();
    expect(reduceCatalog({ "a/b": { name: "B", reasoning: true, modalities: { input: ["text"], output: ["text"] } } })).toEqual([
      { id: "b", lab: "a", name: "B", vision: false, pdf: false, reasoning: true, chat: true },
    ]);
  });

  it("writes one entry per line, and a README with the source, date, licence and count", () => {
    const text = formatCatalog(reduced);
    expect(JSON.parse(text)).toEqual(reduced);
    expect(text.split("\n")).toHaveLength(reduced.length + 3);
    const readme = catalogReadme({ fetched: "2026-11-17", count: 12 });
    for (const part of ["https://models.dev/models.json", "Fetched: 2026-11-17", "Licence: MIT", "Entries: 12", "Copyright (c) 2025 models.dev"]) expect(readme).toContain(part);
  });
});

describe("the committed snapshot", () => {
  const text = readFileSync(new URL("../src/providers/model-catalog.json", import.meta.url), "utf8");
  const catalog = JSON.parse(text) as ReturnType<typeof reduceCatalog>;
  const LEVELS = ["low", "medium", "high", "xhigh", "max"];

  it("is a sorted list of more than 300 well-formed entries, written as the script writes it", () => {
    expect(catalog.length).toBeGreaterThan(300);
    expect(text).toBe(formatCatalog(catalog));
    for (const [i, e] of catalog.entries()) {
      expect([i, Object.keys(e).filter((k) => !["id", "lab", "name", "vision", "pdf", "reasoning", "chat", "contextTokens", "reasoningLevels"].includes(k))]).toEqual([i, []]);
      expect([e.id, e.id === e.id.toLowerCase() && e.id.length > 0, typeof e.name, typeof e.vision, typeof e.pdf, typeof e.reasoning, typeof e.chat]).toEqual([e.id, true, "string", "boolean", "boolean", "boolean", "boolean"]);
      if (e.contextTokens !== undefined) expect([e.id, Number.isInteger(e.contextTokens) && e.contextTokens > 0]).toEqual([e.id, true]);
      if (e.reasoningLevels !== undefined) {
        expect([e.id, e.reasoning, e.reasoningLevels.length > 0, LEVELS.filter((l) => e.reasoningLevels!.includes(l))]).toEqual([e.id, true, true, e.reasoningLevels]);
      }
      if (i > 0) expect([catalog[i - 1]!.id, e.id, catalog[i - 1]!.id <= e.id]).toEqual([catalog[i - 1]!.id, e.id, true]);
    }
  });

  it("has the models the hints are checked against, and its README says how many", () => {
    const ids = new Set(catalog.map((e) => e.id));
    for (const id of ["gpt-6-sol", "claude-sonnet-5-5", "gemini-2.5-pro"]) expect([id, ids.has(id)]).toEqual([id, true]);
    expect(catalog.find((e) => e.id === "gpt-6-sol")).toMatchObject({ lab: "openai", reasoning: true, reasoningLevels: LEVELS });
    const readme = readFileSync(new URL("../src/providers/model-catalog.README.md", import.meta.url), "utf8");
    expect(readme).toContain(`Entries: ${catalog.length}`);
    expect(readme).toContain("Licence: MIT");
  });
});
