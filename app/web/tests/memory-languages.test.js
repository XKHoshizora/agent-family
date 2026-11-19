// The languages the palace can be written in: the web's mirror of the service's one table (app/service/src/memory/language.ts
// `MEMORY_LANGUAGES`). The codes and the names must match it exactly: a change on one side is a change on the other.
import { describe, expect, it } from "vitest";
import { MEMORY_LANGUAGES, isMemoryLanguage, languageName } from "../src/data/memoryLanguages.js";

describe("the memory languages", () => {
  it("are these fourteen codes in this order, each named in itself", () => {
    expect(MEMORY_LANGUAGES).toEqual([
      ["zh-Hans", "简体中文"],
      ["zh-Hant", "繁體中文"],
      ["ja", "日本語"],
      ["en", "English"],
      ["ko", "한국어"],
      ["fr", "Français"],
      ["de", "Deutsch"],
      ["es", "Español"],
      ["pt", "Português"],
      ["ru", "Русский"],
      ["it", "Italiano"],
      ["vi", "Tiếng Việt"],
      ["th", "ไทย"],
      ["id", "Bahasa Indonesia"],
    ]);
  });

  it("know a code and name it; anything else is none", () => {
    expect(isMemoryLanguage("ja")).toBe(true);
    for (const bad of ["xx", "", "EN", "zh", null, undefined, 3]) expect([bad, isMemoryLanguage(bad)]).toEqual([bad, false]);
    expect(languageName("ko")).toBe("한국어");
    expect(languageName("auto")).toBe("");
  });
});
