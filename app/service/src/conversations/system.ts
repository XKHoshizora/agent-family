import type { Queryable, Tx } from "../db.ts";
import { insertMessage, type StoredMessage, type SystemEvent } from "../messages/model.ts";

const LISTED_NAMES = 10;

function idsIn(e: SystemEvent): string[] {
  const ids = [e.actorId];
  if ("principalId" in e) ids.push(e.principalId);
  if ("newCreatorId" in e && e.newCreatorId) ids.push(e.newCreatorId);
  if ("memberIds" in e) ids.push(...e.memberIds.slice(0, LISTED_NAMES));
  return ids;
}

/** The Chinese sentence for a notice, with display names as they are now. Clients may re-render from the event. */
export async function renderNotice(q: Queryable, e: SystemEvent): Promise<string> {
  const { rows } = await q.query<{ id: string; display_name: string }>(
    "select id, display_name from principals where id = any($1::uuid[])",
    [idsIn(e)],
  );
  const names = new Map(rows.map((r) => [r.id, r.display_name]));
  const n = (id: string) => names.get(id) ?? "某人";
  switch (e.event) {
    case "group_created": {
      const listed = e.memberIds.slice(0, LISTED_NAMES).map(n).join("、");
      const more = e.memberIds.length > LISTED_NAMES ? `等${e.memberIds.length}人` : "";
      return `${n(e.actorId)}创建了群聊「${e.title}」，并邀请${listed}${more}加入`;
    }
    case "member_joined":
      return `${n(e.actorId)}邀请${n(e.principalId)}加入了群聊`;
    case "member_left":
      return `${n(e.principalId)}退出了群聊${e.newCreatorId ? `，${n(e.newCreatorId)}成为新的创建者` : ""}`;
    case "member_removed":
      return `${n(e.actorId)}将${n(e.principalId)}移出了群聊`;
    case "group_renamed":
      return `${n(e.actorId)}将群名改为「${e.title}」`;
    case "friendship_ended":
      return `${n(e.actorId)}解除了与${n(e.principalId)}的好友关系，双方不能再发送新消息，已有历史不受影响`;
    case "friendship_restored":
      return `${n(e.actorId)}和${n(e.principalId)}重新成为好友，可以继续发送消息`;
    case "blocked":
      return `${n(e.actorId)}拉黑了${n(e.principalId)}，只能由对方解除。双方不能再发送新消息，已有历史不受影响`;
    case "unblocked":
      return `${n(e.actorId)}解除了对${n(e.principalId)}的拉黑`;
  }
}

/**
 * Appends a system notice. Always allowed, even where nobody may send. The caller must hold the
 * conversation row lock (and, in a direct conversation, the pair lock before it).
 */
export async function appendSystem(t: Tx, conversationId: string, e: SystemEvent): Promise<StoredMessage> {
  const text = await renderNotice(t, e);
  return insertMessage(t, conversationId, e.actorId, "system", { ...e, text }, null);
}
