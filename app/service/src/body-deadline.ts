import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Whether the request's head announces a body (a length above zero, or a chunked one). */
function announcesBody(headers: IncomingHttpHeaders): boolean {
  const length = headers["content-length"];
  return headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
}

const lifts = new WeakMap<IncomingMessage, () => void>();

/**
 * The body deadline: a request must have arrived whole `ms` after its head did, or its connection is closed without
 * an answer — so a client trickling a body in cannot hold a connection for long, whatever happens to the request:
 * answered by a route, refused by a hook (a foreign `Origin`), by the router (an undecodable path, an over-long
 * parameter) or not found, and also after the answer went out (an unread body keeps a connection busy until it is
 * in). It is armed on the HTTP server's own `request` event, so nothing in Fastify runs before it. Requests without
 * a body, bodies that arrive in time and the connection a request leaves open afterwards are not affected; neither
 * is a WebSocket (an upgrade is not a `request` event). The two uploads lift it (`liftBodyDeadline`) once they let a
 * body in. Requests made with `app.inject` never reach the server and are not armed.
 */
export function registerBodyDeadline(app: FastifyInstance, ms: number): void {
  app.server.on("request", (raw: IncomingMessage) => {
    if (raw.complete || !announcesBody(raw.headers)) return;
    const timer = setTimeout(() => {
      if (raw.complete) return;
      app.log.info({ method: raw.method }, "request body too slow: connection closed");
      // Destroying an unfinished request destroys its socket (as the upload deadlines do, attachments/routes.ts).
      raw.destroy();
    }, ms);
    timer.unref();
    const disarm = () => clearTimeout(timer);
    lifts.set(raw, disarm);
    raw.once("end", disarm);
    raw.once("close", disarm);
  });
}

/**
 * For an upload that has been let in (signed in, allowed, about to read its body): from here its own deadlines and
 * the server-wide timeouts govern how long its body may take, not the body deadline.
 */
export function liftBodyDeadline(req: FastifyRequest): void {
  lifts.get(req.raw)?.();
}
