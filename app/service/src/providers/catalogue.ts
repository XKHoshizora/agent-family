import { z } from "zod";
import providerFile from "./provider-catalog.json" with { type: "json" };

/**
 * The catalogue's providers by the host their API answers at (provider-catalog.json, written with model-catalog.json by
 * `npm run catalog:update`; never fetched at run time): what `POST /api/providers/:id/models/list` offers when the
 * provider's own address has no model list (README "Model providers").
 */

const catalogProvider = z.strictObject({
  id: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1),
  models: z.array(z.string().min(1)).min(1),
});

/** Host name (lower case) → the model ids of every catalogue provider at that host, in the snapshot's order, each once. */
const BY_HOST = new Map<string, string[]>();
for (const provider of z.array(catalogProvider).parse(providerFile)) {
  for (const host of provider.hosts) {
    const ids = BY_HOST.get(host.toLowerCase()) ?? [];
    for (const id of provider.models) if (!ids.includes(id)) ids.push(id);
    BY_HOST.set(host.toLowerCase(), ids);
  }
}

/**
 * The model ids the catalogue lists for the providers whose API is at `baseUrl`'s host — the exact host name, port and
 * path aside (`https://api.deepseek.com/v1` is `api.deepseek.com`) — or null when it knows none there.
 */
export function catalogueModels(baseUrl: string): string[] | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  return BY_HOST.get(host)?.slice() ?? null;
}
