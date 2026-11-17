// Writes src/providers/model-catalog.json, the reduced snapshot of the models.dev catalogue that `modelHints`
// (src/providers/hints.ts) looks model names up in, and its README (source, date, licence, entry count). Run by hand,
// `npm run catalog:update`: it downloads https://models.dev/models.json and https://models.dev/api.json, parses them
// as JSON (nothing in them is ever run) and keeps only what the snapshot needs. `npm run catalog:update -- <models.json>
// <api.json>` reads saved copies instead. The service itself never fetches the catalogue.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MODELS_URL = "https://models.dev/models.json";
export const API_URL = "https://models.dev/api.json";
/** Our own thinking levels above `none`, in order (src/config.ts `REASONING_LEVELS`). */
export const LEVELS = ["low", "medium", "high", "xhigh", "max"];
/**
 * The catalogue's `type` of models that do not chat. Their modalities alone would not say so: an embedding model or a
 * reranker takes text and answers "text" (numbers), and a realtime model talks over its own socket API.
 */
const NOT_CHAT_TYPES = new Set(["embedding", "reranking", "speech", "transcription", "image", "video", "realtime"]);
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const CONTROL = /\p{Cc}/u;

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The thinking levels a first-party entry of api.json offers: the values of its `effort` option that are our levels,
 * in our order; none (undefined) for no entry, no `effort` option (a `toggle` or `budget_tokens` one: the gateway maps
 * any level onto those), or nothing left of it.
 */
export function levelsOf(entry) {
  const effort = (Array.isArray(entry?.reasoning_options) ? entry.reasoning_options : []).find((o) => o?.type === "effort");
  if (!effort) return undefined;
  const values = new Set(strings(effort.values));
  const levels = LEVELS.filter((level) => values.has(level));
  return levels.length > 0 ? levels : undefined;
}

/**
 * The snapshot: for each canonical model `lab/model-id` of models.json, `{id, lab, name, vision, pdf, reasoning, chat,
 * contextTokens?, reasoningLevels?}`, sorted by id (then lab). `id` is the key's last segment in lower case; two labs
 * may share it (both are kept). `reasoningLevels` comes from the lab's own entry in api.json (`api[lab].models[id]`).
 */
export function reduceCatalog(models, api = {}) {
  if (!isObject(models)) throw new Error("models.json: expected an object of models keyed lab/model-id");
  const out = [];
  for (const [key, entry] of Object.entries(models)) {
    if (!isObject(entry)) continue;
    const parts = key.split("/");
    const id = parts[parts.length - 1].trim().toLowerCase();
    if (!id || CONTROL.test(id)) continue;
    const lab = parts.length > 1 ? parts[0] : "";
    const input = strings(entry.modalities?.input);
    const output = strings(entry.modalities?.output);
    const label = typeof entry.name === "string" ? entry.name.trim() : "";
    const reduced = {
      id,
      lab,
      name: label && !CONTROL.test(label) && [...label].length <= 100 ? label : id,
      vision: input.includes("image"),
      pdf: input.includes("pdf"),
      reasoning: entry.reasoning === true,
      chat: input.includes("text") && output.includes("text") && !NOT_CHAT_TYPES.has(entry.type),
    };
    const context = entry.limit?.context;
    if (Number.isInteger(context) && context > 0) reduced.contextTokens = context;
    const levels = reduced.reasoning ? levelsOf(api?.[lab]?.models?.[parts.slice(1).join("/")]) : undefined;
    if (levels) reduced.reasoningLevels = levels;
    out.push(reduced);
  }
  return out.sort((a, b) => (a.id === b.id ? (a.lab < b.lab ? -1 : a.lab > b.lab ? 1 : 0) : a.id < b.id ? -1 : 1));
}

/** The snapshot as written: one entry per line, so that an update reads as a diff of models. */
export const formatCatalog = (entries) => `[\n${entries.map((e) => `  ${JSON.stringify(e)}`).join(",\n")}\n]\n`;

const LICENCE = `MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** The snapshot's README: where it came from, when, under what licence, how many entries. */
export function catalogReadme({ fetched, count }) {
  return `# model-catalog.json

A reduced snapshot of the [models.dev](https://models.dev) model catalogue (repository anomalyco/models.dev): what
\`modelHints\` (\`hints.ts\`) knows about a model by its id. Generated by \`npm run catalog:update\`
(\`scripts/update-model-catalog.mjs\`); do not edit it by hand. The service reads it from here and never fetches the
catalogue itself.

- Source: ${MODELS_URL} (the canonical models) and ${API_URL} (each lab's own entry, for its thinking levels; not kept)
- Fetched: ${fetched}
- Licence: MIT (below)
- Entries: ${count}

Each entry: \`id\` (the model id, lower case), \`lab\`, \`name\` (its display name), \`vision\` (takes images), \`pdf\` (takes
PDFs), \`reasoning\`, \`chat\` (takes and answers text, and is not an embedding, reranking, speech, transcription, image,
video or realtime model), \`contextTokens\` (when the catalogue gives one) and \`reasoningLevels\` (the lab's \`effort\`
values among \`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\`, when it has them).

## Licence of the catalogue data

${LICENCE}`;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { accept: "application/json" } });
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_DOWNLOAD_BYTES) throw new Error(`${url}: larger than expected`);
  return text;
}

async function main() {
  const [modelsFile, apiFile] = process.argv.slice(2);
  if (Boolean(modelsFile) !== Boolean(apiFile)) throw new Error("give both saved files (models.json and api.json), or neither");
  const models = JSON.parse(modelsFile ? readFileSync(modelsFile, "utf8") : await download(MODELS_URL));
  const api = JSON.parse(apiFile ? readFileSync(apiFile, "utf8") : await download(API_URL));
  const entries = reduceCatalog(models, api);
  if (entries.length < 100) throw new Error(`only ${entries.length} models: not writing a snapshot that small`);
  const fetched = (modelsFile ? statSync(modelsFile).mtime : new Date()).toISOString().slice(0, 10);
  const dir = new URL("../src/providers/", import.meta.url);
  writeFileSync(new URL("model-catalog.json", dir), formatCatalog(entries));
  writeFileSync(new URL("model-catalog.README.md", dir), catalogReadme({ fetched, count: entries.length }));
  console.log(`model-catalog.json: ${entries.length} models (${entries.filter((e) => e.reasoningLevels).length} with their thinking levels), fetched ${fetched}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
