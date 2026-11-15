import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError, notFound } from "../errors.ts";
import { appOriginCheck } from "../origin.ts";
import { CLOSE_CODES, type Hub } from "./hub.ts";
import type { TicketOwner, TicketStore } from "./tickets.ts";

/** Inbound frames (messages) larger than this close the socket with 1009. */
export const MAX_FRAME_BYTES = 4096;

const pingMessage = z.strictObject({ type: z.literal("ping") });

/** The only inbound application message: `{"type":"ping"}` as a small text frame. */
function isPing(data: unknown): boolean {
  if (!Buffer.isBuffer(data) || data.length > 64) return false;
  try {
    return pingMessage.safeParse(JSON.parse(data.toString("utf8"))).success;
  } catch {
    return false;
  }
}

/**
 * `GET /api/ws?ticket=…`. Authentication is by ticket only (the session cookie is never consulted here),
 * and only for upgrades whose Origin is exactly the app's. Framing, masking, UTF-8 and the frame size cap
 * are enforced by `ws`: a violating frame gets a close frame (1002, 1007, 1009) and ends that socket only.
 */
export async function registerWebSocketRoute(app: FastifyInstance, hub: Hub, tickets: TicketStore): Promise<void> {
  await app.register(fastifyWebsocket, {
    options: { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false },
    // Protocol errors reach this after `ws` has sent its close frame (the socket is CLOSING and ends by
    // itself); anything still open here failed in our own code and is cut off.
    errorHandler(err, socket, req) {
      req.log.info({ err }, "websocket error");
      if (socket.readyState === socket.OPEN) socket.terminate();
    },
  });

  const fromApp = appOriginCheck(app.deps.config.appOrigin);
  const owners = new WeakMap<FastifyRequest, TicketOwner>();

  app.withTypeProvider<ZodTypeProvider>().route({
    method: "GET",
    url: "/api/ws",
    websocket: true,
    schema: {
      params: z.object({}),
      querystring: z.object({ ticket: z.string().min(1).max(128) }),
    },
    preHandler: async (req) => {
      // A plain GET is not an upgrade and must not spend the ticket.
      if (!req.ws) throw notFound();
      // Browsers always send Origin on a WebSocket handshake; anything else is cross-site or not a browser.
      if (!fromApp(req.headers.origin)) throw new AppError(403, "forbidden");
      const owner = tickets.redeem(req.query.ticket);
      if (!owner) throw new AppError(401, "unauthenticated");
      owners.set(req, owner);
    },
    handler: (socket, req) => {
      const owner = owners.get(req);
      if (!owner) return void socket.terminate();
      const conn = hub.attach(socket, owner);
      // `ws` calls this from the socket's data handler: anything thrown here would escape as an uncaught
      // exception and take the process down, so nothing may.
      socket.on("message", (data, isBinary) => {
        try {
          if (isBinary) return hub.drop(conn, CLOSE_CODES.unsupportedData, "binary_not_accepted");
          if (isPing(data)) hub.send(conn, { type: "pong" });
          // Every other inbound message is ignored.
        } catch (err) {
          req.log.error({ err }, "websocket message handling failed");
          socket.terminate();
        }
      });
      hub.confirmSession(conn).catch((err) => {
        req.log.error({ err }, "websocket session check failed");
        hub.drop(conn, CLOSE_CODES.internalError, "internal_error");
      });
    },
  });
}
