import { assertCanSend, lockForWrite, VISIBLE_JOIN } from "../conversations/store.ts";
import type { Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { insertMessage, MESSAGE_COLUMNS, toStored, type MessageBody, type MessageRow, type StoredMessage } from "./model.ts";

export interface SendInput {
  /** Already trimmed and validated (1–8000 characters). */
  text?: string;
  /** Not accepted yet: the attachments task enables it. */
  attachmentId?: string;
  replyToSeq?: number;
  /** The client's retry key: one message per (conversation, sender, clientTxn). */
  clientTxn: string;
}

const invalid = () => new AppError(400, "invalid_request");

/**
 * Sends as `senderId` (always the session principal). Lock order: pair lock (direct), conversation row;
 * then, all in this transaction: membership, idempotency, permission, quote visibility, seq assignment.
 *
 * A repeated `clientTxn` returns the stored message with `duplicate: true` and writes nothing — even if
 * sending is no longer allowed — provided the sender can still read it; otherwise 409 `client_txn_reused`.
 */
export async function sendMessage(
  t: Tx,
  conversationId: string,
  senderId: string,
  input: SendInput,
): Promise<{ message: StoredMessage; duplicate: boolean }> {
  const lock = await lockForWrite(t, conversationId, senderId);

  const prior = await t.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from messages m where m.conversation_id = $1 and m.sender_id = $2 and m.client_txn = $3`,
    [conversationId, senderId, input.clientTxn],
  );
  if (prior.rows[0]) {
    const readable = await t.query(`select 1 from messages m ${VISIBLE_JOIN} where m.id = $2`, [senderId, prior.rows[0].id]);
    if (readable.rowCount === 0) throw new AppError(409, "client_txn_reused");
    return { message: toStored(prior.rows[0]), duplicate: true };
  }

  if (input.attachmentId !== undefined || input.text === undefined) throw invalid();
  await assertCanSend(t, lock);

  if (input.replyToSeq !== undefined) {
    const quoted = await t.query(`select 1 from messages m ${VISIBLE_JOIN} where m.conversation_id = $2 and m.seq = $3`, [
      senderId,
      conversationId,
      input.replyToSeq,
    ]);
    if (quoted.rowCount === 0) throw invalid();
  }

  const body: MessageBody = { text: input.text };
  if (input.replyToSeq !== undefined) body.replyToSeq = input.replyToSeq;
  const message = await insertMessage(t, conversationId, senderId, "text", body, input.clientTxn);
  return { message, duplicate: false };
}
