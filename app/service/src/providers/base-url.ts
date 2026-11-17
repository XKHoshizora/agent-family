import type { Protocol } from "../config.ts";
import { normaliseBaseUrl } from "./guard.ts";

/**
 * What a provider's typed address is stored as (README "Model providers", `baseUrl`). The web form shows the same rule
 * as a live preview (app/web/src/pages/Providers.jsx `storedBaseUrl`); the two test files share one table of cases.
 */

/** A path segment that names an API version: `v1`, `v2`, `v4`, `v1beta`, `v1beta1`, `v1alpha2`… (the whole segment). */
const VERSION_SEGMENT = /^v\d+(?:[a-z]+\d*)?$/;

/** The version appended to an address that names none, per protocol. */
export const DEFAULT_VERSION: Readonly<Record<Protocol, string>> = {
  openai_chat: "v1",
  openai_responses: "v1",
  anthropic: "v1",
  gemini: "v1beta",
};

/**
 * The base URL stored for what the owner typed, or null when it may not be one. Trimmed; checked and normalised as
 * `normaliseBaseUrl` does (https, no credentials, a plain host, a sane port; host lower-cased, default port, query,
 * fragment and trailing `/` dropped). Then: typed with a trailing `#`, the address is used as typed (the `#` taken
 * off, nothing added); else, unless a segment of its path already names a version (`/v\d+([a-z]+\d*)?`), the protocol's
 * version is appended (`/v1`; `/v1beta` for Gemini). Whether an address may be one does not depend on the protocol.
 */
export function providerBaseUrl(protocol: Protocol, typed: string, allowInsecureLocal = false): string | null {
  const raw = typed.trim();
  const asTyped = raw.endsWith("#");
  const base = normaliseBaseUrl(asTyped ? raw.slice(0, -1) : raw, allowInsecureLocal);
  if (base === null || asTyped) return base;
  const segments = new URL(base).pathname.split("/");
  return segments.some((s) => VERSION_SEGMENT.test(s)) ? base : `${base}/${DEFAULT_VERSION[protocol]}`;
}
