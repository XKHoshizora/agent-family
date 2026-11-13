import { db } from "./db";
import type { Mode } from "../shared/types";
import { discussionSettings } from "./discussion";
import type { DiscussionSettings } from "../shared/types";
export type LineScope = {
  groupId: string;
  channelId: string;
  scopeId: string;
  afterSequence: number;
  shareTools: boolean;
  mode: Mode;
  discussion?: DiscussionSettings;
};
export function lineScopeFor(
  groupId: string,
  channelId: string,
  roomId: string,
): LineScope {
  const b = db
    .prepare(
      "SELECT b.* FROM line_bindings b JOIN line_channels c ON c.id=b.channel_id WHERE b.group_id=? AND b.channel_id=? AND b.room_id=? AND c.enabled=1",
    )
    .get(groupId, channelId, roomId) as any;
  if (!b) throw new Error("LINE 连接已解除或停用。");
  return {
    groupId,
    channelId,
    scopeId: b.scope_id,
    afterSequence: b.context_after,
    shareTools: !!b.share_tools,
    mode: b.mode,
    discussion: discussionSettings(JSON.parse(b.discussion || "null")),
  };
}
export function assertLineScope(scope: LineScope, roomId: string) {
  const current = lineScopeFor(scope.groupId, scope.channelId, roomId);
  if (current.scopeId !== scope.scopeId)
    throw new Error("LINE 共享范围已变更，请重新发送。");
  return current;
}
