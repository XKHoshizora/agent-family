import type { FastifyInstance } from "fastify";
import { matrixOptions } from "./matrix-account";

/** Keep the upstream chat client primary; workbench URLs stay on this origin. */
export function registerChatEntry(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD") return;
    const url = new URL(req.url, "http://local.invalid");
    if (url.pathname !== "/" && url.pathname !== "/chat") return;
    const options = matrixOptions();
    if (!options) return;
    // Do not forward invitation/setup parameters to another application.
    const destination = url.search
      ? `/workbench${url.search}`
      : options.elementUrl;
    return reply.header("Cache-Control", "no-store").redirect(destination);
  });
}
