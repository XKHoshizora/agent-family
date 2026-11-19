// The languages the memory palace can be written in, each named in itself: the web's mirror of the service's one table
// (app/service/src/memory/language.ts `MEMORY_LANGUAGES`). The codes must match it; tests/memory-languages.test.js pins both.

export const MEMORY_LANGUAGES = [
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
];

/** Whether `code` is one of the languages. */
export const isMemoryLanguage = (code) => typeof code === "string" && MEMORY_LANGUAGES.some(([c]) => c === code);

/** The language's own name; empty for anything that is not one. */
export const languageName = (code) => MEMORY_LANGUAGES.find(([c]) => c === code)?.[1] ?? "";
