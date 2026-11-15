import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTH_BASE_PATH, AUTH_ENDPOINTS } from "../src/auth/auth.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * README.md is the client contract: its route reference has one heading per route (`#### \`METHOD /path\``),
 * and that list must be exactly what the app serves (`app.routeList`, with the Better Auth mount's wildcard
 * replaced by the endpoints it lets through). A route added, removed or renamed without the README fails here.
 */

const { app } = useApp();
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** The route headings of the README, in order. */
function documentedRoutes(): string[] {
  return [...README.matchAll(/^#{2,4} `([A-Z]+) (\/[^`\s]*)`[ \t]*$/gm)].map((m) => `${m[1]} ${m[2]}`);
}

/** What the app serves: every declared route (not the HEADs Fastify derives from GETs), the auth mount expanded. */
function servedRoutes(): string[] {
  const served = app.routeList.filter((r) => !r.derived && r.url !== `${AUTH_BASE_PATH}/*`).map((r) => `${r.method} ${r.url}`);
  const auth = AUTH_ENDPOINTS.map((e) => {
    const [method, path] = e.split(" ");
    return `${method} ${AUTH_BASE_PATH}${path}`;
  });
  return [...served, ...auth];
}

describe("README route reference", () => {
  it("has one heading for every route the app serves, and none for anything else", () => {
    const documented = documentedRoutes();
    const duplicates = documented.filter((r, i) => documented.indexOf(r) !== i);
    expect(duplicates).toEqual([]);
    const served = servedRoutes();
    expect(served.length).toBeGreaterThan(30);
    expect({ undocumented: served.filter((r) => !documented.includes(r)), notServed: documented.filter((r) => !served.includes(r)) }).toEqual({
      undocumented: [],
      notServed: [],
    });
  });

  it("every HEAD the README does not list is one Fastify derived from a GET (the README's rule for HEAD)", () => {
    const gets = new Set(app.routeList.filter((r) => r.method === "GET").map((r) => r.url));
    for (const r of app.routeList.filter((x) => x.method === "HEAD" && x.derived)) expect([r.url, gets.has(r.url)]).toEqual([r.url, true]);
    expect(README).toContain("Every `GET` route also answers `HEAD`");
  });
});
