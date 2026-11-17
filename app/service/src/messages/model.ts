import { z } from "zod";
import type { Tx } from "../db.ts";

export type MessageKind = "text" | "file" | "system";

/** Machine-readable system notices. `actorId` is whoever caused it; it is also stored as `sender_id`. */
export type SystemEvent =
  | { event: "group_created"; actorId: string; title: string; memberIds: string[] }
  | { event: "member_joined"; actorId: string; principalId: string }
  | { event: "member_left"; actorId: string; principalId: string; newCreatorId: string | null }
  | { event: "member_removed"; actorId: string; principalId: string }
  | { event: "group_renamed"; actorId: string; title: string }
  /** In an Agent's conversation: its owner started a new topic; nothing before it is shown to the model again. */
  | { event: "topic_reset"; actorId: string }
  /** In a group: a member stopped Agents calling each other (`POST …/agents/halt`) until a person writes again. */
  | { event: "agents_halted"; actorId: string }
  /**
   * In a group: the last `limit` messages that are not notices were all Agents', so the message of Agent `actorId` called
   * no other Agent; nor will any Agent's until a person writes.
   */
  | { event: "agent_chain_paused"; actorId: string; limit: number }
  /**
   * In a group: Agent `agentId` (also `actorId`) has cost its owner its `chainBudget` in replies other Agents called for
   * since a person last wrote; Agents' messages do not call it until a person writes again.
   */
  | { event: "agent_budget_reached"; actorId: string; agentId: string }
  | PairEvent;

/** Notices in a pair's direct conversation: `actorId` acted on `principalId`. */
export type PairEvent = {
  event: "friendship_ended" | "friendship_restored" | "blocked" | "unblocked";
  actorId: string;
  principalId: string;
};

/** A file message's attachment as stored in its body and shown on the wire (`attachments` row, frozen at send). */
export interface AttachmentRef {
  id: string;
  /** The sanitised display name; search matches it via `messages.body->'attachment'->>'name'`. */
  name: string;
  size: number;
  /** The server's sniffing verdict: safe to show in the browser (PNG, JPEG, WebP, GIF). */
  inline: boolean;
}

/**
 * `messages.body`. Text messages carry `text` (and `replyToSeq` when quoting); file messages carry
 * `attachment` and an optional caption in `text`; system notices carry a `SystemEvent` plus the rendered
 * `text`. An Agent's reply (`postAsAgent`) may add `reasoning` (non-empty), `stopped: true`, `truncated: true` and
 * `proposalId` (the `persona_proposals` row it made); its greeting `fixed: true`. Later kinds (task cards...) add
 * fields, so readers must not assume more than this.
 */
export type MessageBody = {
  text?: string;
  replyToSeq?: number;
  attachment?: AttachmentRef;
  event?: string;
  [field: string]: unknown;
};

export interface StoredMessage {
  /** `messages.id`, a bigint, as a string. Never exposed on the wire. */
  id: string;
  conversationId: string;
  seq: number;
  /** The author; for system notices, the principal whose action produced it (shown as `null` on the wire). */
  senderId: string;
  kind: MessageKind;
  body: MessageBody;
  clientTxn: string | null;
  createdAt: Date;
}

/** Columns of `messages m` in the shape `toStored` reads. */
export const MESSAGE_COLUMNS = "m.id, m.conversation_id, m.seq, m.sender_id, m.kind, m.body, m.client_txn, m.created_at";

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: string;
  sender_id: string;
  kind: MessageKind;
  body: MessageBody;
  client_txn: string | null;
  created_at: Date;
}

export function toStored(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    senderId: r.sender_id,
    kind: r.kind,
    body: r.body,
    clientTxn: r.client_txn,
    createdAt: r.created_at,
  };
}

/**
 * Appends a message with the next sequence number (`conversations.seq + 1`, gapless and unique). The
 * caller must already hold the conversation row lock and have checked permission in the same transaction.
 */
export async function insertMessage(
  t: Tx,
  conversationId: string,
  senderId: string,
  kind: MessageKind,
  body: MessageBody,
  clientTxn: string | null,
): Promise<StoredMessage> {
  const { rows } = await t.query<MessageRow>(
    `with next as (update conversations set seq = seq + 1 where id = $1 returning seq)
     insert into messages as m (conversation_id, seq, sender_id, kind, body, client_txn)
     select $1, next.seq, $2, $3, $4::jsonb, $5 from next
     returning ${MESSAGE_COLUMNS}`,
    [conversationId, senderId, kind, JSON.stringify(body), clientTxn],
  );
  if (!rows[0]) throw new Error(`insertMessage: conversation ${conversationId} does not exist`);
  return toStored(rows[0]);
}

/**
 * A persona proposal's status as its owner sees it. `stale`: stored so once a confirmation ran into it, and shown so
 * already while it is `open` but the Agent's persona has moved past the version it was made against.
 */
export const PROPOSAL_STATUSES = ["open", "confirmed", "discarded", "superseded", "stale"] as const;

/** A message as one reader receives it. Build it with `toWireFor` (src/messages/read.ts). */
export const wireMessageSchema = z.object({
  conversationId: z.string(),
  seq: z.number(),
  /** `null` for system notices. */
  senderId: z.string().nullable(),
  kind: z.enum(["text", "file", "system"]),
  /** Message text; for system notices the server-rendered sentence. */
  text: z.string(),
  attachment: z.object({ id: z.string(), name: z.string(), size: z.number(), inline: z.boolean() }).optional(),
  /** Present when quoting. Text and sender only when this reader can see the quoted message. */
  replyTo: z
    .union([
      z.object({
        seq: z.number(),
        visible: z.literal(true),
        senderId: z.string().nullable(),
        text: z.string(),
        /** What was quoted: a file message may have no caption, so `text` alone cannot say. */
        kind: z.enum(["text", "file"]),
        /** For a quoted file message: its file name. */
        attachmentName: z.string().optional(),
      }),
      z.object({ seq: z.number(), visible: z.literal(false) }),
    ])
    .optional(),
  /** For system notices: the `SystemEvent` (without `text`), so a client can re-render it. */
  system: z.looseObject({ event: z.string() }).optional(),
  /** An Agent's reply: the model's reasoning, when it gave any (never in previews, search or a later model call). */
  reasoning: z.string().optional(),
  /** An Agent's reply its owner stopped: the text is what had been generated by then. */
  stopped: z.literal(true).optional(),
  /** An Agent's reply that was cut: by the model's output limit, the reply time limit, or at 8 000 characters. */
  truncated: z.literal(true).optional(),
  /** An Agent's reply that proposed a persona (agents/persona.ts): shown to the Agent's owner only. */
  proposal: z
    .object({
      id: z.string(),
      status: z.enum(PROPOSAL_STATUSES),
      persona: z.string(),
      intro: z.string().optional(),
      field: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
});

export type WireMessage = z.infer<typeof wireMessageSchema>;
