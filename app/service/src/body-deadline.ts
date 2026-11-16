import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Whether the request's head announces a body (a length above zero, or a chunked one). */
function announcesBody(headers: IncomingHttpHeaders): boolean {
  const length = headers["content-length"];
  return headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
}

const lifts = new WeakMap<FastifyRequest, () => void>();

/**
 * The body deadline: a request must have arrived whole `ms` after its head did, or its connection is closed without
 * an answer — so a client trickling a body in cannot hold a connection for long on any route (also an unknown one,
 * and also after the request was answered: an unread body keeps a connection busy until it is in). Requests without
 * a body, bodies that arrive in time and the connection a request leaves open afterwards are not affected; neither is
 * a WebSocket (its upgrade has no body). The two uploads lift it (`liftBodyDeadline`) once they let a body in.
 */
export function registerBodyDeadline(app: FastifyInstance, ms: number): void {
  app.addHook("onRequest", async (req) => {
    const raw = req.raw;
    if (raw.complete || !announcesBody(raw.headers)) return;
    const timer = setTimeout(() => {
      if (raw.complete) return;
      req.log.info("request body too slow: connection closed");
      // Destroying an unfinished request destroys its socket (as the upload deadlines do, attachments/routes.ts).
      raw.destroy();
    }, ms);
    timer.unref();
    const disarm = () => clearTimeout(timer);
    lifts.set(req, disarm);
    raw.once("end", disarm);
    raw.once("close", disarm);
  });
}

/**
 * For an upload that has been let in (signed in, allowed, about to read its body): from here its own deadlines and
 * the server-wide timeouts govern how long its body may take, not the body deadline.
 */
export function liftBodyDeadline(req: FastifyRequest): void {
  lifts.get(req)?.();
}
