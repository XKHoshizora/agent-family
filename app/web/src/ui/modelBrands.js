// Which brand a model is, by its name or id, for the mark before it in the model picker (src/ui/ModelBrand.jsx draws it).

/** The brands with a mark of their own (src/assets/model-brands/<brand>.svg); tests/model-brands.test.jsx keeps the two in step. */
export const BRANDS = Object.freeze(["openai", "claude", "deepseek", "gemini", "qwen", "moonshot", "zhipu", "doubao", "minimax", "mistral", "meta", "grok"]);

// [how the name starts, brand]. The name is lower-cased and anything up to its last "/" ("openai/gpt-4o",
// "models/gemini-1.5-pro") is dropped; then its start is matched by one pass over these anchored patterns, so a name is
// read in time linear in its length, and a brand appears only where the name begins with it ("my-gpt" is none).
const RULES = [
  [/^(?:gpt|chatgpt|o[134](?![a-z0-9]))/, "openai"],
  [/^claude/, "claude"],
  [/^deepseek/, "deepseek"],
  [/^(?:gemini|gemma)/, "gemini"],
  [/^(?:qwen|qwq)/, "qwen"],
  [/^(?:kimi|moonshot)/, "moonshot"],
  [/^(?:glm|zhipu)/, "zhipu"],
  [/^doubao/, "doubao"],
  [/^(?:minimax|abab)/, "minimax"],
  [/^(?:mistral|mixtral|codestral)/, "mistral"],
  [/^(?:meta-)?llama/, "meta"],
  [/^grok/, "grok"],
];

/** The brand of a model's name or id (one of BRANDS), or null: then the generic mark is shown, never a guess. */
export function brandOf(nameOrId) {
  if (typeof nameOrId !== "string" || nameOrId.length === 0 || nameOrId.length > 300) return null;
  const lower = nameOrId.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  for (const [pattern, brand] of RULES) if (pattern.test(base)) return brand;
  return null;
}
