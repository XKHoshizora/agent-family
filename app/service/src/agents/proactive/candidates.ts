import type { ProactiveConfig } from "../../config.ts";
import type { Queryable } from "../../db.ts";
import { MAX_CHOICE_OPTIONS, type Question } from "../../judge/client.ts";
import { blockedEitherWay } from "../../social/relations.ts";
import { mentionedHandles } from "../mentions.ts";
import { labelName, oneLine } from "../runtime/prompt.ts";

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

const PICK_INSTRUCTIONS = "群里有几个 AI 助手。记录里标着“（Agent）”的是它们说过的话。最新这条消息如果需要某个 AI 助手主动来回答，应该由谁回答？";
const NOBODY_DESCRIPTION = "不需要任何 AI 助手回答：真人之间的闲聊、客套、道谢，已经有人回答了，或者不属于上面任何一位擅长的事";
const quietInstructions = (name: string): string =>
  `群里有一个 AI 助手「${name}」。记录里标着“${name}（Agent）”的是它说过的话。最新这条消息是在让${name}别再说话、安静一点，或者表示它打扰到大家了。`;

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
 * Whether `text` names an Agent by `@handle` — any Agent, in the group or not (`judgeable`; the send route tells the
 * scheduler so). One query, only when the text has a handle.
 */
export async function namesAnAgent(q: Queryable, text: string): Promise<boolean> {
  const handles = mentionedHandles(text);
  if (handles.length === 0) return false;
  const named = await q.query("select 1 from principals where kind = 'agent' and handle = any($1::citext[]) limit 1", [handles]);
  return Boolean(named.rowCount);
}

/**
 * The Agents that may answer `senderId`'s message in the group unasked: its current Agent members with proactive replies
 * on, not paused or deleted, with a model, whose owner has no block with the sender in either direction (the sender may
 * be the owner). At most `MAX_AGENT_OPTIONS`: beyond that, those judged here least recently (`agent_group_state.judged_at`,
 * never first) take the places. Keyed and returned in id order.
 */
export async function optionsFor(q: Queryable, conversationId: string, senderId: string): Promise<Option[]> {
  const { rows } = await q.query<{ id: string; handle: string; name: string; intro: string; field: string; joined_seq: string }>(
    `select x.* from (
       select p.id, p.handle::text as handle, p.display_name as name, a.intro, a.field, m.joined_seq::text as joined_seq
         from memberships m
         join principals p on p.id = m.principal_id
         join agents a on a.principal_id = p.id
         left join agent_group_state s on s.agent_id = p.id and s.conversation_id = m.conversation_id
        where m.conversation_id = $1 and m.left_seq is null and p.kind = 'agent'
          and a.proactive and not a.paused and a.deleted_at is null and a.model_source is not null
          and not ${blockedEitherWay("p.owner_id", "$2::uuid")}
        order by s.judged_at nulls first, p.id
        limit $3) x
      order by x.id`,
    [conversationId, senderId, MAX_AGENT_OPTIONS],
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

/** What the judgement model is shown (`state`) and asked (`questions`) about the message at `seq`. */
export interface JudgeRequest {
  state: string;
  questions: Question[];
}

/**
 * The request for the message at `seq` (the group's latest that is not a notice): the transcript — the last
 * `transcriptMessages` messages that are not notices, after the latest join among `options` (so no option is shown what
 * came before it joined), oldest first, each `{name}：{text}` (an Agent's `{name}（Agent）：{text}`; a file `[文件] {caption
 * or name}`), the name a label's (`labelName`), the text on one line and cut at `transcriptChars` characters — then one
 * choice over the options and `nobody`, and a quiet question about each option that sent one of the messages shown.
 */
export async function requestFor(
  q: Queryable,
  conversationId: string,
  seq: number,
  options: readonly Option[],
  P: Pick<ProactiveConfig, "transcriptMessages" | "transcriptChars">,
): Promise<JudgeRequest> {
  const after = Math.max(...options.map((o) => o.joinedSeq));
  const { rows } = await q.query<{ sender_id: string; sender_kind: string; name: string; handle: string; kind: string; text: string | null; file: string | null }>(
    `select m.sender_id, p.kind as sender_kind, p.display_name as name, p.handle::text as handle, m.kind,
            m.body ->> 'text' as text, m.body -> 'attachment' ->> 'name' as file
       from messages m join principals p on p.id = m.sender_id
      where m.conversation_id = $1 and m.seq > $2 and m.seq <= $3 and m.kind in ('text', 'file')
      order by m.seq desc
      limit $4`,
    [conversationId, after, seq, P.transcriptMessages],
  );
  const lines = rows.reverse().map((r) => {
    const text = r.kind === "file" ? `[文件] ${r.text || r.file || ""}` : (r.text ?? "");
    return `${labelName(r.name, r.handle)}${r.sender_kind === "agent" ? "（Agent）" : ""}：${cut(text, P.transcriptChars)}`;
  });
  const spoke = new Set(rows.map((r) => r.sender_id));
  const pick: Question = {
    key: PICK,
    type: "choice",
    instructions: PICK_INSTRUCTIONS,
    options: Object.fromEntries([...options.map((o) => [o.key, o.description]), [NOBODY, NOBODY_DESCRIPTION]]),
  };
  const quiet = options
    .filter((o) => spoke.has(o.agentId))
    .map((o): Question => ({ key: quietKey(o), type: "noul", instructions: quietInstructions(o.name) }));
  return { state: `群聊记录：\n${lines.join("\n")}`, questions: [pick, ...quiet] };
}
