import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { StoredMessage } from "../messages/model.ts";

export type MessagesListener = (messages: StoredMessage[]) => void | Promise<void>;
export type MembershipListener = (conversationId: string, principalIds: string[]) => void | Promise<void>;

/** What a committed write announces. */
export interface Change {
  /** Every stored message, system notices included. */
  messages: StoredMessage[];
  /**
   * Conversations whose members, title, creator, open state or sendability changed, each with everyone
   * affected: members before and after the change (so someone who just left is included).
   */
  conversations: Array<{ conversationId: string; principalIds: string[] }>;
}

/** Per-app registry of conversation listeners (on `Deps`), in the style of `SocialEvents`. */
export interface ConversationEvents {
  onMessages(fn: MessagesListener): () => void;
  onMembershipChanged(fn: MembershipListener): () => void;
  /** Call only after the transaction has committed. Never throws; listener failures are logged. */
  publish(change: Change, log: Pick<FastifyBaseLogger, "error">): void;
}

function listeners<A extends unknown[]>(label: string) {
  const fns = new Set<(...args: A) => void | Promise<void>>();
  return {
    on(fn: (...args: A) => void | Promise<void>): () => void {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    emit(log: Pick<FastifyBaseLogger, "error">, args: () => A): void {
      for (const fn of [...fns]) {
        try {
          Promise.resolve(fn(...args())).catch((err) => log.error({ err }, `${label} listener failed`));
        } catch (err) {
          log.error({ err }, `${label} listener failed`);
        }
      }
    },
  };
}

export function createConversationEvents(): ConversationEvents {
  const messages = listeners<[StoredMessage[]]>("messages");
  const membership = listeners<[string, string[]]>("membership");
  return {
    onMessages: messages.on,
    onMembershipChanged: membership.on,
    publish(change, log) {
      // Each listener gets its own arrays, so one cannot disturb what the next one sees.
      if (change.messages.length > 0) messages.emit(log, () => [[...change.messages]]);
      for (const c of change.conversations) membership.emit(log, () => [c.conversationId, [...c.principalIds]]);
    },
  };
}

/** Subscribe to every stored message (after commit). Returns unsubscribe. */
export function onMessages(app: FastifyInstance, fn: MessagesListener): () => void {
  return app.deps.conversations.onMessages(fn);
}

/** Subscribe to joins, leaves, removals, creator changes, renames, closing and direct-chat sendability flips. */
export function onMembershipChanged(app: FastifyInstance, fn: MembershipListener): () => void {
  return app.deps.conversations.onMembershipChanged(fn);
}
