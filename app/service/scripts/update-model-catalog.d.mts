// Types of update-model-catalog.mjs, for the tests that import its pure functions.
export interface CatalogEntry {
  id: string;
  lab: string;
  name: string;
  vision: boolean;
  pdf: boolean;
  reasoning: boolean;
  chat: boolean;
  contextTokens?: number;
  reasoningLevels?: string[];
}
export const MODELS_URL: string;
export const API_URL: string;
export const LEVELS: string[];
export function levelsOf(entry: unknown): string[] | undefined;
export function reduceCatalog(models: unknown, api?: unknown): CatalogEntry[];
export function formatCatalog(entries: CatalogEntry[]): string;
export function catalogReadme(facts: { fetched: string; count: number }): string;
