import type { ProactiveConfig } from "../../config.ts";
import type { Queryable } from "../../db.ts";
import { MAX_CHOICE_OPTIONS, type Question } from "../../judge/client.ts";
import { blockedEitherWay } from "../../social/relations.ts";
import { mentionedHandles } from "../mentions.ts";
import { labelName, oneLine } from "../runtime/prompt.ts";
import type { Listener } from "./listeners.ts";
import { judgedUpTo } from "./state.ts";

/**
 * What a proactive judgement is about (batch 2D, "Who is asked, and how"), read without writing: whether a message is
 * still one to judge (`judgeable`), which Agents may answer it unasked (`optionsFor`), and what the judgement model is
 * shown and asked about them (`requestFor`). The model is shown only the group's last messages that every option may see
 * and each option's name, intro and field — never a persona, never anything of another conversation.
 */

/** The most Agents one judgement offers: a choice holds at most `MAX_CHOICE_OPTIONS` options, and one is `nobody`. */
export const MAX_AGENT_OPTIONS = MAX_CHOICE_OPTIONS - 1;

/** The most characters of an option's description. */
const DESCRIPTION_CHARS = 200;

/** The choice question's key, and its option that is no Agent. */
export const PICK = "pick";
export const NOBODY = "nobody";

/**
 * What a line of the transcript opens with when it is new: sent after the options were last judged in the group with an
 * answer (`judgedUpTo`). The latest message always is.
 */
export const NEW_MARK = "【新】";

const PICK_INSTRUCTIONS = "群里有几个 AI 助手。记录里标着“（Agent）”的是它们说过的话。最新这条消息如果需要某个 AI 助手主动来回答，应该由谁回答？";
const NOBODY_DESCRIPTION = "不需要任何 AI 助手回答：真人之间的闲聊、客套、道谢，已经有人回答了，或者不属于上面任何一位擅长的事";
const quietInstructions = (name: string): string =>
  `群里有一个 AI 助手「${name}」。记录里标着“${name}（Agent）”的是它说过的话。开头标着${NEW_MARK}的是刚发的消息。在这些${NEW_MARK}消息里，有人在让${name}别再说话、安静一点，或者表示它打扰到大家了，而且在那之后没有人又让它继续说。没有标${NEW_MARK}的旧消息不算。`;

const hearsayInstructions = (name: string): string =>
  `群里有一位成员叫「${name}」。在标着${NEW_MARK}的消息里，有人（不是${name}自己）说了一件关于${name}本人的、以后还用得上的事：做过什么、打算做什么、有什么没做完、喜欢或不喜欢什么、安排或情况。只是打招呼、叫他、@ 他、顺口提到名字、开玩笑、泛泛的评价，都不算。消息可能是任何语言。`;
const ownInstructions = (name: string): string =>
  `群里有一位成员叫「${name}」。在标着${NEW_MARK}的消息里，${name}自己说了一件关于自己的、以后还用得上的事：喜欢或不喜欢什么、习惯、安排、情况，或者要别人记住的事。只是闲聊、接话、提问、对别人的事发表看法，都不算。消息可能是任何语言。`;

/** An Agent the judgement may pick. */
export interface Option {
  /** `a1`, `a2`, … in Agent id order. */
  key: string;
  agentId: string;
  /** The seq it joined the group at, in its current stay. */
  joinedSeq: number;
  /** Its option's description, and the name in it (a label's name, `labelName`). */
  name: string;
  description: string;
}

/** The key of option `o`'s quiet question. */
export const quietKey = (o: Pick<Option, "key">): string => `q_${o.key}`;

/** The keys of listener `l`'s two questions: what others said about the owner, and what the owner said about themselves. */
export const hearsayKey = (l: Pick<Listener, "key">): string => l.key;
export const ownKey = (l: Pick<Listener, "key">): string => `${l.key}o`;

/** The first `chars` characters of `text` once it is on one line (`oneLine`). */
const cut = (text: string, chars: number): string => Array.from(oneLine(text)).slice(0, chars).join("");

/**
 * The sender of the message at `seq` when it is one to judge (design rule 3): the conversation is an open group, the
 * message is its latest that is not a notice, a person sent it, Agents were not halted at or after it (a halt keeps them
 * out until a person writes again, rule 13), and its text (a file's caption) names no Agent by `@handle` — any Agent,
 * in the group or not: whoever names an Agent asked that one, and none other answers in its place. Null otherwise.
 */
export async function judgeable(q: Queryable, conversationId: string, seq: number): Promise<{ senderId: string } | null> {
  const { rows } = await q.query<{ type: string; closed: boolean; halted: string | null; seq: string | null; sender_id: string | null; kind: string | null; text: string | null }>(
    `select c.type, c.closed_at is not null as closed, c.agents_halted_seq::text as halted, m.seq::text as seq, m.sender_id, p.kind, m.body ->> 'text' as text
       from conversations c
       left join lateral (select x.seq, x.sender_id, x.body from messages x
                           where x.conversation_id = c.id and x.kind <> 'system' order by x.seq desc limit 1) m on true
       left join principals p on p.id = m.sender_id
      where c.id = $1`,
    [conversationId],
  );
  const r = rows[0];
  if (!r || r.type !== "group" || r.closed || r.seq === null || Number(r.seq) !== seq || r.kind !== "human" || r.sender_id === null) return null;
  if (r.halted !== null && Number(r.halted) >= seq) return null;
  if (await namesAnAgent(q, r.text ?? "")) return null;
  return { senderId: r.sender_id };
}

/**
 * Whether `text` names an Agent by `@handle` — any Agent, in the group or not: such a message is no one to judge
 * (`judgeable`, the decision's first read). One query, only when the text has a handle.
 */
export async function namesAnAgent(q: Queryable, text: string): Promise<boolean> {
  const handles = mentionedHandles(text);
  if (handles.length === 0) return false;
  const named = await q.query("select 1 from principals where kind = 'agent' and handle = any($1::citext[]) limit 1", [handles]);
  return Boolean(named.rowCount);
}

/**
 * SQL: whether Agent `p` (a `principals` alias, with its `agents` row `a` and its `memberships` row `m` in the group) may
 * answer unasked the message at seq `seq` from person `sender` (parameter positions, spliced in): a current member since
 * before that message (an Agent answers nothing from before it joined), with proactive replies on, not paused or deleted,
 * with a model, whose owner has no block with the sender in either direction (the sender may be the owner). Read when
 * the options are offered (`optionsFor`) and again under their locks (decide.ts).
 */
export const mayAnswerUnasked = (seq: string, sender: string): string =>
  `m.left_seq is null and m.joined_seq < ${seq} and p.kind = 'agent'
   and a.proactive and not a.paused and a.deleted_at is null and a.model_source is not null
   and not ${blockedEitherWay("p.owner_id", sender)}`;

/**
 * The Agents that may answer unasked `senderId`'s message at `seq` in the group (`mayAnswerUnasked`). At most
 * `MAX_AGENT_OPTIONS`: beyond that, those judged here least recently (`agent_group_state.judged_at`, never first) take
 * the places. Keyed and returned in id order.
 */
export async function optionsFor(q: Queryable, conversationId: string, seq: number, senderId: string): Promise<Option[]> {
  const { rows } = await q.query<{ id: string; handle: string; name: string; intro: string; field: string; joined_seq: string }>(
    `select x.* from (
       select p.id, p.handle::text as handle, p.display_name as name, a.intro, a.field, m.joined_seq::text as joined_seq
         from memberships m
         join principals p on p.id = m.principal_id
         join agents a on a.principal_id = p.id
         left join agent_group_state s on s.agent_id = p.id and s.conversation_id = m.conversation_id
        where m.conversation_id = $1 and ${mayAnswerUnasked("$3", "$2::uuid")}
        order by s.judged_at nulls first, p.id
        limit $4) x
      order by x.id`,
    [conversationId, senderId, seq, MAX_AGENT_OPTIONS],
  );
  return rows.map((r, i) => {
    const name = labelName(r.name, r.handle);
    return {
      key: `a${i + 1}`,
      agentId: r.id,
      joinedSeq: Number(r.joined_seq),
      name,
      description: cut(`${name}：${oneLine(r.intro)}；擅长：${oneLine(r.field)}`, DESCRIPTION_CHARS),
    };
  });
}

/** What a listener's question flags when it is answered high enough: the new messages it is about. */
export interface Flaggable {
  key: string;
  kind: "hearsay" | "own";
  listener: Listener;
  seqs: number[];
}

/** What the judgement model is shown (`state`) and asked (`questions`) about the message at `seq`, and what its answers flag. */
export interface JudgeRequest {
  state: string;
  questions: Question[];
  /** The listener questions, each with the seqs of the new messages a high answer flags. */
  flaggable: Flaggable[];
}

/**
 * The request for the message at `seq` (the group's latest that is not a notice): the transcript — the last
 * `transcriptMessages` messages that are not notices, after the latest join among `options` and `listeners` (so no Agent
 * that may answer or listens is shown what came before it joined), oldest first, each `{name}：{text}`, opened with
 * `NEW_MARK` when it came after the message they were last judged up to (`judgedUpTo`; the latest always: a request to
 * be quiet that a later message covered is still asked about, and one judged already is not asked about again) (an
 * Agent's `{name}（Agent）：{text}`; a file `[文件] {caption or name}`), the name a label's (`labelName`), the text on one
 * line and cut at `transcriptChars` characters — then, when there are options, one choice over them and `nobody` about
 * the latest message, and a quiet question about each option that sent one of the messages shown, asked of the new
 * messages; then, for each listener (an owner whose Agents remember), whether a new message by someone else says
 * something lasting about the owner (`{key}`: asked only when a person with no block with the owner either way sent
 * one) and whether a new message by the owner says something lasting about themselves (`{key}o`: asked only when the
 * owner sent one and an Agent of theirs reviews it, `reviewerId`).
 * Null when there is no line to show (nothing is asked about descriptions alone) or nothing to ask.
 */
export async function requestFor(
  q: Queryable,
  conversationId: string,
  seq: number,
  options: readonly Option[],
  P: Pick<ProactiveConfig, "transcriptMessages" | "transcriptChars">,
  listeners: readonly Listener[] = [],
): Promise<JudgeRequest | null> {
  if (options.length === 0 && listeners.length === 0) return null;
  const after = Math.max(...options.map((o) => o.joinedSeq), ...listeners.map((l) => l.joinedSeq));
  const { rows } = await q.query<{ seq: string; sender_id: string; sender_kind: string; name: string; handle: string; kind: string; text: string | null; file: string | null }>(
    `select m.seq::text as seq, m.sender_id, p.kind as sender_kind, p.display_name as name, p.handle::text as handle, m.kind,
            m.body ->> 'text' as text, m.body -> 'attachment' ->> 'name' as file
       from messages m join principals p on p.id = m.sender_id
      where m.conversation_id = $1 and m.seq > $2 and m.seq <= $3 and m.kind in ('text', 'file')
      order by m.seq desc
      limit $4`,
    [conversationId, after, seq, P.transcriptMessages],
  );
  if (rows.length === 0) return null;
  // Null (never judged with an answer): only the latest message is new, as when each message is judged in turn.
  const agentIds = [...new Set([...options.map((o) => o.agentId), ...listeners.flatMap((l) => l.agentIds)])];
  const judged = Math.min((await judgedUpTo(q, conversationId, agentIds)) ?? seq - 1, seq - 1);
  rows.reverse();
  const lines = rows.map((r) => {
    const text = r.kind === "file" ? `[文件] ${r.text || r.file || ""}` : (r.text ?? "");
    return `${Number(r.seq) > judged ? NEW_MARK : ""}${labelName(r.name, r.handle)}${r.sender_kind === "agent" ? "（Agent）" : ""}：${cut(text, P.transcriptChars)}`;
  });
  const questions: Question[] = [];
  if (options.length > 0) {
    const spoke = new Set(rows.map((r) => r.sender_id));
    questions.push({
      key: PICK,
      type: "choice",
      instructions: PICK_INSTRUCTIONS,
      options: Object.fromEntries([...options.map((o) => [o.key, o.description]), [NOBODY, NOBODY_DESCRIPTION]]),
    });
    for (const o of options) if (spoke.has(o.agentId)) questions.push({ key: quietKey(o), type: "noul", instructions: quietInstructions(o.name) });
  }
  const flaggable = await listenerQuestions(q, rows, judged, listeners);
  for (const f of flaggable) {
    questions.push({ key: f.key, type: "noul", instructions: (f.kind === "hearsay" ? hearsayInstructions : ownInstructions)(f.listener.ownerName) });
  }
  if (questions.length === 0) return null;
  return { state: `群聊记录：\n${lines.join("\n")}`, questions, flaggable };
}

/**
 * The listener questions worth asking of the transcript `rows` (`judged`: the last seq judged already): per listener,
 * hearsay when a new message came from a person other than the owner who has no block with the owner either way, and
 * the owner's own when the owner sent a new message and an Agent of theirs reviews it.
 */
async function listenerQuestions(
  q: Queryable,
  rows: readonly { seq: string; sender_id: string; sender_kind: string }[],
  judged: number,
  listeners: readonly Listener[],
): Promise<Flaggable[]> {
  if (listeners.length === 0) return [];
  const fresh = rows.filter((r) => Number(r.seq) > judged && r.sender_kind !== "agent");
  if (fresh.length === 0) return [];
  const { rows: blocks } = await q.query<{ blocker_id: string; blocked_id: string }>(
    `select blocker_id, blocked_id from blocks
      where (blocker_id = any($1::uuid[]) and blocked_id = any($2::uuid[])) or (blocker_id = any($2::uuid[]) and blocked_id = any($1::uuid[]))`,
    [listeners.map((l) => l.ownerId), [...new Set(fresh.map((r) => r.sender_id))]],
  );
  const blocked = new Set(blocks.flatMap((b) => [`${b.blocker_id}|${b.blocked_id}`, `${b.blocked_id}|${b.blocker_id}`]));
  const out: Flaggable[] = [];
  for (const l of listeners) {
    const others = fresh.filter((r) => r.sender_id !== l.ownerId && !blocked.has(`${l.ownerId}|${r.sender_id}`)).map((r) => Number(r.seq));
    if (others.length > 0) out.push({ key: hearsayKey(l), kind: "hearsay", listener: l, seqs: others });
    const own = fresh.filter((r) => r.sender_id === l.ownerId).map((r) => Number(r.seq));
    if (own.length > 0 && l.reviewerId !== null) out.push({ key: ownKey(l), kind: "own", listener: l, seqs: own });
  }
  return out;
}
