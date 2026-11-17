import { claimAttachment, linkAttachment } from "../attachments/store.ts";
import { assertCanSend, lockForWrite, VISIBLE_JOIN, type WriteLock } from "../conversations/store.ts";
import type { Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { insertMessage, MESSAGE_COLUMNS, toStored, type MessageBody, type MessageRow, type StoredMessage } from "./model.ts";

/** The longest text a message holds, in characters: the send schema's limit (people's messages are refused above it; an
 * Agent's reply is cut there). */
export const MESSAGE_TEXT_MAX = 8000;

export interface SendInput {
  /** Already trimmed and validated: 0–`MESSAGE_TEXT_MAX` characters, and not empty unless `attachmentId` is given. */
  text?: string;
  /** The sender's own unsent upload in this conversation; makes a `file` message with `text` as caption. */
  attachmentId?: string;
  replyToSeq?: number;
  /** The client's retry key: one message per (conversation, sender, clientTxn). */
  clientTxn: string;
}

const invalid = () => new AppError(400, "invalid_request");

/**
 * Sends as `senderId` (always the session principal). Lock order: pair lock (direct), conversation row;
 * then, all in this transaction: membership, idempotency, permission, quote visibility, the attachment
 * (claimed with its row lock), seq assignment, and linking the attachment to the new message.
 *
 * A repeated `clientTxn` returns the stored message with `duplicate: true` and writes nothing — even if
 * sending is no longer allowed or its attachment is linked by now — provided the sender can still read
 * it; otherwise 409 `client_txn_reused`. `lock` is what the transaction holds (for the reply trigger).
 */
export async function sendMessage(
  t: Tx,
  conversationId: string,
  senderId: string,
  input: SendInput,
): Promise<{ message: StoredMessage; duplicate: boolean; lock: WriteLock }> {
  const lock = await lockForWrite(t, conversationId, senderId);

  const prior = await t.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from messages m where m.conversation_id = $1 and m.sender_id = $2 and m.client_txn = $3`,
    [conversationId, senderId, input.clientTxn],
  );
  if (prior.rows[0]) {
    const readable = await t.query(`select 1 from messages m ${VISIBLE_JOIN} where m.id = $2`, [senderId, prior.rows[0].id]);
    if (readable.rowCount === 0) throw new AppError(409, "client_txn_reused");
    return { message: toStored(prior.rows[0]), duplicate: true, lock };
  }

  if (input.attachmentId === undefined && !input.text) throw invalid();
  await assertCanSend(t, lock);

  if (input.replyToSeq !== undefined) {
    const quoted = await t.query(`select 1 from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 and m.seq = $3`, [
      senderId,
      conversationId,
      input.replyToSeq,
    ]);
    if (quoted.rowCount === 0) throw invalid();
  }

  const body: MessageBody = {};
  if (input.text) body.text = input.text;
  if (input.replyToSeq !== undefined) body.replyToSeq = input.replyToSeq;
  if (input.attachmentId !== undefined) {
    // Unknown, someone else's, another conversation's and already sent all look the same.
    const attachment = await claimAttachment(t, input.attachmentId, conversationId, senderId);
    if (!attachment) throw invalid();
    body.attachment = attachment;
  }

  const message = await insertMessage(t, conversationId, senderId, body.attachment ? "file" : "text", body, input.clientTxn);
  if (body.attachment && !(await linkAttachment(t, body.attachment.id, message.id))) throw invalid();
  return { message, duplicate: false, lock };
}
