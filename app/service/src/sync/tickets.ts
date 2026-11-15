import { randomBytes } from "node:crypto";

/** How long a WebSocket ticket can be redeemed after it was issued. */
export const TICKET_TTL_MS = 30_000;

/** Who a ticket opens a socket for: the principal and the session that asked for it. */
export interface TicketOwner {
  principalId: string;
  sessionId: string;
}

/**
 * Single-use, short-lived WebSocket tickets, kept in this process only (so the service must run as a
 * single instance; see README). A ticket is 256 random bits; it dies when redeemed, when it expires, or
 * when the session it was issued to ends.
 */
export interface TicketStore {
  issue(owner: TicketOwner): string;
  /** The owner, exactly once and only within the TTL; null otherwise. Always consumes the ticket. */
  redeem(ticket: string): TicketOwner | null;
  /** Drops every unredeemed ticket of the session (sign-out, password reset). */
  revokeSession(sessionId: string): void;
}

export function createTicketStore(): TicketStore {
  const tickets = new Map<string, TicketOwner & { expiresAt: number }>();

  const sweep = (now: number): void => {
    for (const [key, t] of tickets) if (t.expiresAt <= now) tickets.delete(key);
  };

  return {
    issue(owner) {
      const now = Date.now();
      sweep(now); // bounded by the issue rate limit, so a scan per issue stays small
      const ticket = randomBytes(32).toString("base64url");
      tickets.set(ticket, { principalId: owner.principalId, sessionId: owner.sessionId, expiresAt: now + TICKET_TTL_MS });
      return ticket;
    },
    redeem(ticket) {
      const t = tickets.get(ticket);
      if (!t) return null;
      tickets.delete(ticket);
      if (t.expiresAt <= Date.now()) return null;
      return { principalId: t.principalId, sessionId: t.sessionId };
    },
    revokeSession(sessionId) {
      for (const [key, t] of tickets) if (t.sessionId === sessionId) tickets.delete(key);
    },
  };
}
