import { db, addMessage, audit, getRoom } from "./db";
import { assertFamilyRunAllowed, familyRoomAccess } from "./family-store";
import type { Room } from "../shared/types";
import { mentionedAgents } from "../shared/execution";
import { assertLineScope, type LineScope } from "./line-access";

export const INPUT_INTERRUPT = "discussion-user-input";
const turns = new Map<string, AbortController>();
export function beginInputAwareTurn(runId: string, parent: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  if (parent.aborted) cancel();
  else parent.addEventListener("abort", cancel, { once: true });
  turns.set(runId, controller);
  return {
    signal: controller.signal,
    close: () => {
      parent.removeEventListener("abort", cancel);
      if (turns.get(runId) === controller) turns.delete(runId);
    },
  };
}
export function pendingInputs(runId: string) {
  return (
    db
      .prepare(
        "SELECT m.rowid AS seq,m.*,i.targets,i.handled,i.answered_by,i.scope_id,i.shared_to_line FROM discussion_inputs i JOIN messages m ON m.id=i.message_id WHERE i.run_id=? AND i.answered_by IS NULL ORDER BY m.rowid",
      )
      .all(runId) as any[]
  ).map((r) => ({
    ...r,
    targets: JSON.parse(r.targets) as string[],
    handled: JSON.parse(r.handled) as string[],
  }));
}
export function markInputsAnswered(
  ids: string[],
  agentId: string,
  messageId: string,
) {
  db.transaction(() => {
    for (const id of ids) {
      const row = db
        .prepare(
          "SELECT * FROM discussion_inputs WHERE message_id=? AND answered_by IS NULL",
        )
        .get(id) as any;
      if (!row) continue;
      const targets: string[] = JSON.parse(row.targets),
        handled: string[] = JSON.parse(row.handled);
      if (targets.length && !targets.includes(agentId)) continue;
      if (!handled.includes(agentId)) handled.push(agentId);
      db.prepare(
        "UPDATE discussion_inputs SET handled=?,answered_by=? WHERE message_id=?",
      ).run(
        JSON.stringify(handled),
        targets.every((t) => handled.includes(t)) ? messageId : null,
        id,
      );
    }
  })();
}
function conflict(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 409 });
}
export function appendDiscussionInput(input: {
  room: Room;
  runId: string;
  actor: string;
  author: string;
  content: string;
  clientId: string;
  lineScope?: LineScope;
  shareToLine?: boolean;
}) {
  assertFamilyRunAllowed(input.room.id, input.actor);
  const result = db.transaction(() => {
    const room = getRoom(input.room.id);
    const run = db
      .prepare("SELECT * FROM runs WHERE id=? AND room_id=?")
      .get(input.runId, input.room.id) as any;
    if (!room || room.archived || !run || run.mode !== "free")
      conflict("当前没有可加入的自由讨论，草稿已保留。");
    const storedScope: LineScope | null = JSON.parse(run.line_scope);
    if (input.lineScope) {
      assertLineScope(input.lineScope, room.id);
      if (!storedScope || storedScope.scopeId !== input.lineScope.scopeId)
        conflict("LINE 只能加入本次绑定发起的讨论。");
    } else {
      if (input.actor.startsWith("line:"))
        throw new Error("缺少 LINE 连接身份。");
      const member = db
        .prepare(
          "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
        )
        .get(room.workspaceId, input.actor) as any;
      if (
        !member ||
        member.role === "viewer" ||
        familyRoomAccess(room.id, input.actor) === false ||
        (familyRoomAccess(room.id, input.actor) === null &&
          room.visibility === "private" &&
          room.createdBy !== input.actor)
      )
        throw Object.assign(new Error("无权向这个群补充消息。"), {
          statusCode: 403,
        });
      if (storedScope && !input.shareToLine)
        conflict("请明确勾选将这条补充分享给 LINE 群。");
    }
    if (storedScope) assertLineScope(storedScope, room.id);
    if (
      !input.content.trim() ||
      input.content.length > 12000 ||
      JSON.stringify(input.content).length > 24000
    )
      throw new Error("补充内容最多 12,000 字符，请适当精简。");
    if (!input.clientId || input.clientId.length > 150)
      throw new Error("缺少有效消息标识。");
    const old = db
      .prepare(
        "SELECT m.id,m.content FROM discussion_inputs i JOIN messages m ON m.id=i.message_id WHERE i.run_id=? AND i.actor=? AND i.client_id=?",
      )
      .get(run.id, input.actor, input.clientId) as any;
    if (old) {
      if (old.content !== input.content)
        conflict("该消息标识已经用于另一条补充。");
      return { runId: run.id, messageId: old.id, duplicate: true };
    }
    if (!["queued", "running"].includes(run.status))
      conflict("这次讨论已经结束，补充未发送，草稿已保留。请重新确认后发送。");
    const participants: string[] = JSON.parse(run.participants);
    const targets = mentionedAgents(room.agents, input.content).map(
      (a) => a.id,
    );
    if (targets.some((t) => !participants.includes(t)))
      conflict("点名的伙伴不在本次讨论中，请修改点名。");
    const pending = pendingInputs(run.id);
    const cost = (content: string, author: string) =>
      JSON.stringify({ content, author }).length + 500;
    if (
      pending.length >= 10 ||
      pending.reduce(
        (n, m) => n + cost(m.content, m.author),
        cost(input.content, input.author),
      ) > 16000
    )
      conflict(
        "待回应的补充较多或过长，请等待伙伴回应，或精简后再发送。草稿已保留。",
      );
    const msg = addMessage({
      roomId: room.id,
      runId: run.id,
      role: "user",
      agentId: null,
      author: input.author,
      model: null,
      content: input.content,
      status: "complete",
      source: input.lineScope ? "line" : "web",
    });
    db.prepare(
      "INSERT INTO discussion_inputs(message_id,run_id,actor,client_id,targets,scope_id,shared_to_line) VALUES(?,?,?,?,?,?,?)",
    ).run(
      msg.id,
      run.id,
      input.actor,
      input.clientId,
      JSON.stringify(targets),
      storedScope?.scopeId || null,
      storedScope && !input.lineScope ? 1 : 0,
    );
    audit(room.workspaceId, input.actor, "discussion.input", msg.id);
    return { runId: run.id, messageId: msg.id, duplicate: false };
  })();
  if (!result.duplicate) turns.get(result.runId)?.abort(INPUT_INTERRUPT);
  return result;
}
