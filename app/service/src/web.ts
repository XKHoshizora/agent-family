import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";
import { notFound } from "./errors.ts";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Set on the web client's route, so `app.routeList` (the API) can leave it out. */
    webClient?: boolean;
  }
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Vite writes its content-hashed files here; they never change under the same name. */
const HASHED_DIR = "assets";

function pageHeaders(appOrigin: string): Record<string, string> {
  return {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...(new URL(appOrigin).protocol === "https:" ? { "strict-transport-security": "max-age=15552000" } : {}),
  };
}

/**
 * The path the request names, relative to the web root, as clean segments: empty and `.` segments dropped,
 * and null for anything that could leave the root or reach a dotfile (`..`, a name starting with `.`, a
 * backslash, a NUL). Null and "no such file" are answered alike.
 */
function segmentsOf(wildcard: string): string[] | null {
  const segments: string[] = [];
  for (const s of wildcard.split("/")) {
    if (s === "" || s === ".") continue;
    if (s.startsWith(".") || s.includes("\\") || s.includes("\0")) return null;
    segments.push(s);
  }
  return segments;
}

/**
 * Serves the built web client (`WEB_DIST`) from the same origin as the API: files from the directory, and
 * `index.html` for any other GET/HEAD outside `/api/` so the client's own router can take the path. Nothing
 * under `/api/` ever falls back: an unknown API route stays a JSON 404. The route is one wildcard, not a
 * route per file, and is kept out of `app.routeList`, which lists the API (README and fuzz suites walk it).
 */
export async function registerWebClient(app: FastifyInstance): Promise<void> {
  const root = app.deps.config.webDist;
  if (root === undefined) return;
  let hasIndex = false;
  try {
    hasIndex = statSync(path.join(root, "index.html")).isFile();
  } catch {
    // reported below
  }
  if (!hasIndex) throw new Error(`Invalid configuration: WEB_DIST (${root}) must be a directory containing index.html`);

  const headers = pageHeaders(app.deps.config.appOrigin);
  // serve:false: only `reply.sendFile` (ranges, ETag, HEAD, content types); the route below decides what is sent.
  // dotfiles: the plugin's default is to serve them; Cache-Control is set here, not by the plugin.
  await app.register(fastifyStatic, { root, serve: false, dotfiles: "ignore", cacheControl: false, index: false });

  const sendPage = (reply: FastifyReply, file: string) => {
    const hashed = file.startsWith(`${HASHED_DIR}/`);
    void reply.headers({ ...headers, "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" });
    return reply.sendFile(file);
  };

  app.route<{ Params: { "*": string } }>({
    method: "GET", // Fastify derives the HEAD
    url: "/*",
    config: { webClient: true },
    handler: async (req, reply) => {
      const wildcard = req.params["*"];
      // Decided on the first real segment, before any other rule: `/api/..`, `/api/.x` are API paths too.
      if (wildcard.split("/").find((s) => s !== "" && s !== ".") === "api") throw notFound();
      const segments = segmentsOf(wildcard);
      if (segments !== null && segments.length > 0) {
        const info = await stat(path.join(root, ...segments)).catch(() => null);
        if (info?.isFile()) return sendPage(reply, segments.join("/"));
      }
      return sendPage(reply, "index.html");
    },
  });
}
