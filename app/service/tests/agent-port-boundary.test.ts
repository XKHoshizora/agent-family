import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The worker and everything under `src/agents/runtime/` reach the database only through `AgentPort` (README "Agents
 * and runs"): no file there may import `db.ts`, `pg` or any `store.ts` — not even for a type. A static check of every
 * import, export-from, dynamic import and require in the directory.
 */

const RUNTIME = fileURLToPath(new URL("../src/agents/runtime/", import.meta.url));

/** Every module specifier `source` names. */
function importsOf(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/g, // import … from "x", import type … from "x", export … from "x"
    /\bimport\s*["']([^"']+)["']/g, // import "x"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // import("x")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("x")
  ];
  return patterns.flatMap((p) => [...source.matchAll(p)].map((m) => m[1]!));
}

/** Whether a specifier is one the runtime may not import. */
function forbidden(specifier: string): boolean {
  return specifier === "pg" || specifier.startsWith("pg/") || /(^|\/)(db|store)(\.[cm]?[jt]s)?$/.test(specifier);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(path.join(dir, e.name)) : /\.[cm]?[jt]s$/.test(e.name) ? [path.join(dir, e.name)] : [],
  );
}

describe("the agent runtime's boundary", () => {
  it("the check finds every way of importing the database or a store", () => {
    const caught = [
      `import { tx } from "../../db.ts";`,
      `import type { Tx } from '../../db.ts';`,
      `import pg from "pg";`,
      `import { Pool } from "pg/lib/index.js";`,
      `import { lockAgent } from "../store.ts";`,
      `import {\n  readOwnedAgent,\n  type AgentRow,\n} from "../store.ts";`,
      `export * from "../../accounts/store.ts";`,
      `export { lockAccount } from "../../accounts/store.js";`,
      `import "../../db.ts";`,
      `const m = await import("../../providers/store.ts");`,
      `const pg = require("pg");`,
    ];
    for (const source of caught) expect([source, importsOf(source).some(forbidden)]).toEqual([source, true]);
    const allowed = [
      `import type { ModelCall } from "../../models/gateway.ts";`,
      `import { ReplyStream } from "./stream.ts";`,
      `import { hasVisibleText } from "../../schemas.ts";`,
      `import type { AgentPort } from "./port.ts";`,
      `// mentions db.ts and store.ts in a comment only`,
    ];
    for (const source of allowed) expect([source, importsOf(source).some(forbidden)]).toEqual([source, false]);
  });

  it("no file under src/agents/runtime/ imports db.ts, pg or a store.ts", () => {
    const files = filesUnder(RUNTIME);
    const names = files.map((f) => path.relative(RUNTIME, f).replaceAll("\\", "/"));
    for (const expected of ["port.ts", "worker.ts", "stream.ts", "prompt.ts", "context.ts"]) expect(names).toContain(expected);
    const offending = files.flatMap((f) =>
      importsOf(readFileSync(f, "utf8"))
        .filter(forbidden)
        .map((spec) => `${path.relative(RUNTIME, f)}: ${spec}`),
    );
    expect(offending).toEqual([]);
  });

  it("a run's shared ends (UNAVAILABLE, BUSY) are defined once, in runtime/port.ts, and used from there", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    // A constant spelling out a failed run's error inline: `{ status: "failed", error: "<code>" }` bound to a name.
    const definitions = filesUnder(src).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/\bconst\s+(\w+)\b[^=;\n]*=\s*\{\s*status:\s*"failed",\s*error:\s*"(provider_unavailable|busy)"/g)].map(
        (m) => `${path.relative(src, f).replaceAll("\\", "/")}: ${m[1]} = ${m[2]}`,
      ),
    );
    expect(definitions.sort()).toEqual(["agents/runtime/port.ts: BUSY = busy", "agents/runtime/port.ts: UNAVAILABLE = provider_unavailable"]);
  });
});
