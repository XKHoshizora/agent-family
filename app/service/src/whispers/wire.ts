import { z } from "zod";
import { WHISPER_ACTIONS, WHISPER_KINDS, WHISPER_STATUSES, type Whisper, type WhisperAction, type WhisperKind, type WhisperStatus } from "./store.ts";

/**
 * A whisper as its owner receives it — and nobody else ever does (README "Whispers"): in the `whisper` push, `GET /api/sync`'s
 * and catch-up's `whispers`, the list route and an answer. `text`, `actions` and `detail` are its body's; nothing else of
 * the body, and not its owner (the reader) or when it was answered, leaves the service.
 */
export interface WireWhisper {
  id: string;
  conversationId: string;
  agentId: string;
  /** It shows after the message with this seq (several there: by `createdAt`). */
  afterSeq: number;
  kind: WhisperKind;
  text: string;
  actions: WhisperAction[];
  status: WhisperStatus;
  createdAt: string;
  /** Raised at every change of its status (migration 057): of two copies, a client keeps the one with the higher. */
  revision: number;
  detail?: unknown;
}

export const wireWhisperSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  agentId: z.string(),
  afterSeq: z.number(),
  kind: z.enum(WHISPER_KINDS),
  text: z.string(),
  actions: z.array(z.enum(WHISPER_ACTIONS)),
  status: z.enum(WHISPER_STATUSES),
  createdAt: z.string(),
  revision: z.number(),
  detail: z.unknown().optional(),
});

export const toWireWhisper = (w: Whisper): WireWhisper => ({
  id: w.id,
  conversationId: w.conversationId,
  agentId: w.agentId,
  afterSeq: w.afterSeq,
  kind: w.kind,
  text: w.body.text,
  actions: [...w.body.actions],
  status: w.status,
  createdAt: w.createdAt.toISOString(),
  revision: w.revision,
  ...(w.body.detail === undefined ? {} : { detail: w.body.detail }),
});
