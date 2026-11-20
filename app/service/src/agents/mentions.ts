import type { ConversationType } from "../conversations/store.ts";
import type { Queryable } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Mention } from "../messages/model.ts";
import { handleOf } from "../principals/store.ts";

/**
 * Who a mention means (Task M): decided once, when a message is sent — or, for an Agent's reply, posted — and stored
 * with it (`messages.mentions`, `Mention`: who, and the range of the stored text that names them). Nothing reads mention
 * text again to decide who was meant. A mention picked from the @ list comes with its id (`checkPicked`); an `@…` typed
 * and not picked is read here, once (`mentionsAtSend`, by the family-names reading, `namedIn`); every reader after that —
 * the triggers (runs.ts), the follow-up (by the calls its run recorded), the proactive judgement, the web — reads the
 * stored entries.
 */

/** The most mentions one message stores, picked and typed together (README "Mentions"). */
export const MENTION_LIMIT = 20;

/**
 * `@` not preceded by a word character, then the whole run of word characters after it and, when a `.` and another run
 * follow, that run too: `@owner.name` (family names, Task N). Nothing follows the second `+`, the first run cannot give
 * up a character to a `.` (it is no word character), and a global match resumes after what it took, so each character is
 * looked at a bounded number of times: linear in the text, whatever it holds (long runs of `@`, `.` or word characters
 * included).
 */
const MENTION = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?/g;

/** A typed `@…`: the handle it names, lower-cased, and the code units it takes in the text. */
export interface Token {
  handle: string;
  start: number;
  length: number;
}

/** `[start, end)` in code units of a text. */
export type Range = readonly [number, number];

/** A fence line: after any quote markers and indentation, ``` or ~~~ (three or more), then the rest of the line. */
const FENCE = /^[ \t>]*(`{3,}|~{3,})(.*)$/;

/**
 * The parts of `text` Markdown shows as code, in which a typed `@…` names nobody: fenced blocks, from the opening fence
 * line to the closing one (the same character, at least as many, nothing but spaces after them) or to the end of the
 * text when none closes it (a backtick fence's info string holds no backtick); and outside them backtick spans — a run of
 * backticks up to the next run of exactly as many in the same paragraph (a blank line ends one); a backtick after an odd
 * number of backslashes is text, and so is a run nothing closes. Indented code blocks are not told apart: they are text
 * here. In order, not overlapping; linear in the text.
 */
export function codeRanges(text: string): Range[] {
  const out: Array<[number, number]> = [];
  const prose: Array<[number, number]> = [];
  let fence: { char: string; size: number; start: number } | null = null;
  let proseStart = 0;
  for (let at = 0; ; ) {
    const newline = text.indexOf("\n", at);
    const end = newline === -1 ? text.length : newline;
    const line = FENCE.exec(text.slice(at, end));
    if (fence === null) {
      if (line && !(line[1]![0] === "`" && line[2]!.includes("`"))) {
        if (at > proseStart) prose.push([proseStart, at]);
        fence = { char: line[1]![0]!, size: line[1]!.length, start: at };
      }
    } else if (line && line[1]![0] === fence.char && line[1]!.length >= fence.size && line[2]!.trim() === "") {
      out.push([fence.start, end]);
      fence = null;
      proseStart = end;
    }
    if (newline === -1) break;
    at = newline + 1;
  }
  if (fence !== null) out.push([fence.start, text.length]);
  else if (proseStart < text.length) prose.push([proseStart, text.length]);

  const blank = /\n[ \t]*\n/g;
  for (const [from, to] of prose) {
    let start = from;
    blank.lastIndex = from;
    for (let gap = blank.exec(text); gap !== null && gap.index < to; gap = blank.exec(text)) {
      out.push(...backtickSpans(text, start, gap.index));
      start = gap.index + gap[0].length;
    }
    if (start < to) out.push(...backtickSpans(text, start, to));
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** The backtick spans of `text` in `[from, to)` (`codeRanges`): an opening run's next run of the same length closes it. */
function backtickSpans(text: string, from: number, to: number): Array<[number, number]> {
  const runs: Array<{ at: number; size: number }> = [];
  for (let i = from; i < to; ) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < to && text[j] === "`") j += 1;
    runs.push({ at: i, size: j - i });
    i = j;
  }
  // The runs of each length, in order, and how far each list has been passed: every list is walked forward once.
  const bySize = new Map<number, number[]>();
  runs.forEach((run, k) => {
    const list = bySize.get(run.size);
    if (list) list.push(k);
    else bySize.set(run.size, [k]);
  });
  const passed = new Map<number, number>();
  const spans: Array<[number, number]> = [];
  for (let k = 0; k < runs.length; ) {
    const run = runs[k]!;
    let slashes = 0;
    for (let b = run.at - 1; b >= from && text[b] === "\\"; b -= 1) slashes += 1;
    // An escaped first backtick is text: the rest of the run may open a span (inside one, a backslash is text).
    const escaped = slashes % 2 === 1;
    const size = escaped ? run.size - 1 : run.size;
    const list = size > 0 ? bySize.get(size) : undefined;
    let p = passed.get(size) ?? 0;
    if (list) {
      while (p < list.length && list[p]! <= k) p += 1;
      passed.set(size, p);
    }
    if (!list || p >= list.length) {
      k += 1;
      continue;
    }
    const close = runs[list[p]!]!;
    spans.push([escaped ? run.at + 1 : run.at, close.at + close.size]);
    k = list[p]! + 1;
  }
  return spans;
}

/**
 * A test of whether `[start, start + length)` lies outside every one of `ranges` (any order, overlapping or not), for
 * starts that never go back (matches in the order of the text): each range is passed once, so a text of many spans and
 * many tokens stays linear.
 */
function outside(ranges: readonly Range[]): (start: number, length: number) => boolean {
  const merged: Array<[number, number]> = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let p = 0;
  return (start, length) => {
    while (p < merged.length && merged[p]![1] <= start) p += 1;
    return !(p < merged.length && merged[p]![0] < start + length);
  };
}

/**
 * The `@…` of `text` the reading looks up, outside `skip` (code, and the picked ranges): `@owner.name` — an owner's
 * handle of 3 to 24 word characters, a dot, a name part of 2 to 24 — or a bare `@name` of 2 to 24 (a person's handle or
 * display name, or an Agent's name part: `namedIn` says whose). A `.` not followed by a word character is punctuation
 * (`ask @xiaolin.jarvis.` names `xiaolin.jarvis`), only one dot counts (`@abc.def.ghi` names `abc.def`), and a run
 * beyond those lengths on either side names nobody; `mail@anna` names nobody (an address). Every occurrence, in order,
 * lower-cased.
 */
export function mentionTokens(text: string, skip: readonly Range[] = []): Token[] {
  const found: Token[] = [];
  const free = outside(skip);
  for (const match of text.matchAll(MENTION)) {
    const [whole, first, name] = match as unknown as [string, string, string | undefined];
    const fits = name === undefined ? first.length >= 2 && first.length <= 24 : first.length >= 3 && first.length <= 24 && name.length >= 2 && name.length <= 24;
    if (!fits || !free(match.index!, whole.length)) continue;
    found.push({ handle: (name === undefined ? first : `${first}.${name}`).toLowerCase(), start: match.index!, length: whole.length });
  }
  return found;
}

/**
 * The handles `text` names outside `skip` (`mentionTokens`): distinct, in the order they first appear, at most the first
 * MENTION_LIMIT — what one message may look up. Pure: no lookup, so a text that names nobody costs no query.
 */
export function mentionedHandles(text: string, skip: readonly Range[] = []): string[] {
  return [...new Set(mentionTokens(text, skip).map((t) => t.handle))].slice(0, MENTION_LIMIT);
}

/**
 * Whom each of `handles` names among the current members of conversation `conversationId` (an Agent not deleted), by the
 * family-names reading (Task N): `owner.name` the Agent with name part `name` of the person whose handle is `owner` now
 * (a handle they gave up names nobody); a bare `name` the person member with that handle, else the one person member
 * whose display name it is (trimmed, case ignored, the whole name: people first — two such people name nobody), else the
 * one Agent member with that name part. Two or more of one name part, or for a full handle two live Agents (only a write
 * that skipped the owner's account lock could make them), name nobody. Handles that name nobody are absent. One query,
 * none when there is nothing to look up.
 */
async function namedIn(q: Queryable, conversationId: string, handles: readonly string[]): Promise<Map<string, string>> {
  const named = new Map<string, string>();
  const wanted = [...new Set(handles)];
  if (wanted.length === 0) return named;
  const parts = [...new Set(wanted.map((h) => h.slice(h.indexOf(".") + 1)))];
  const bare = wanted.filter((h) => !h.includes("."));
  const { rows } = await q.query<{ id: string; kind: "human" | "agent"; handle: string; owner: string | null; name: string }>(
    `select p.id, p.kind, lower(p.handle::text) as handle, lower(o.handle::text) as owner, lower(btrim(p.display_name)) as name
       from memberships m
       join principals p on p.id = m.principal_id
       left join principals o on o.id = p.owner_id
      where m.conversation_id = $1 and m.left_seq is null
        and (p.handle = any($2::citext[]) or (p.kind = 'human' and lower(btrim(p.display_name)) = any($3::text[])))
        and not exists (select 1 from agents a where a.principal_id = p.id and a.deleted_at is not null)`,
    [conversationId, parts, bare],
  );
  const one = (ids: readonly string[]): string | null => (ids.length === 1 ? ids[0]! : null);
  for (const handle of wanted) {
    let id: string | null;
    if (handle.includes(".")) {
      id = one(rows.filter((r) => r.kind === "agent" && `${r.owner}.${r.handle}` === handle).map((r) => r.id));
    } else {
      const byHandle = rows.find((r) => r.kind === "human" && r.handle === handle);
      const byName = rows.filter((r) => r.kind === "human" && r.name === handle);
      id = byHandle ? byHandle.id : byName.length > 0 ? one(byName.map((r) => r.id)) : one(rows.filter((r) => r.kind === "agent" && r.handle === handle).map((r) => r.id));
    }
    if (id !== null) named.set(handle, id);
  }
  return named;
}

/**
 * Whether `namePart` alone calls Agent `agentId` in conversation `conversationId` (`namedIn`): the system text then names
 * both ways it is called (port-impl.ts `begin`). It reads no message: it says how a typed `@name` would be read at send.
 */
export async function namePartCalls(q: Queryable, conversationId: string, namePart: string, agentId: string): Promise<boolean> {
  return (await namedIn(q, conversationId, [namePart.toLowerCase()])).get(namePart.toLowerCase()) === agentId;
}

const bad = (): AppError => new AppError(400, "bad_mentions");

/** Whether position `at` of `text` falls between the two halves of a surrogate pair (an emoji cut in two). */
const splitsPair = (text: string, at: number): boolean =>
  at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);

/**
 * The mentions picked from the @ list, as sent with a message (`POST …/messages` `mentions`), checked against its text as
 * it is stored (`text`) and its conversation: at most MENTION_LIMIT; each range inside the text, not cutting a surrogate
 * pair, beginning with `@`, in ascending order and not overlapping the one before; each id a current member of the
 * conversation (a person, or an Agent that is not deleted — who can be called there is decided by the triggers, as for
 * any mention). The text in a range is otherwise free: it is the name as the sender saw it. Anything else: 400
 * `bad_mentions`, and nothing is stored. One query, none when nothing was picked.
 */
export async function checkPicked(q: Queryable, conversationId: string, text: string, picked: readonly Mention[]): Promise<void> {
  if (picked.length === 0) return;
  if (picked.length > MENTION_LIMIT) throw bad();
  let end = 0;
  for (const { start, length } of picked) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < end || length < 1 || start + length > text.length) throw bad();
    if (text[start] !== "@" || splitsPair(text, start + length)) throw bad();
    end = start + length;
  }
  const ids = [...new Set(picked.map((m) => m.id))];
  const { rows } = await q.query<{ id: string }>(
    `select p.id from memberships m join principals p on p.id = m.principal_id
      where m.conversation_id = $1 and m.left_seq is null and p.id = any($2::uuid[])
        and not exists (select 1 from agents a where a.principal_id = p.id and a.deleted_at is not null)`,
    [conversationId, ids],
  );
  if (rows.length !== ids.length) throw bad();
}

/**
 * The mentions a message stores (`messages.mentions`; null for none), decided now, once, in the transaction that stores
 * it — a person's send (after `checkPicked`) and an Agent's post alike: the picked ones (`picked`, as sent), and the
 * `@…` typed outside them and outside code (`codeRanges`) read once by the family-names reading (`mentionTokens`,
 * `namedIn`: at most the first MENTION_LIMIT distinct handles are looked up), each occurrence an entry with the range it
 * matched; what names nobody stores nothing. In an Agent's own conversation (`type` `agent`) the Agent is also named as
 * it always was there (spec 6.5): by its full handle or its name part as a whole mention, and by `@` and its name
 * anywhere (case ignored), outside code. At most MENTION_LIMIT in all, the picked ones first; in order of their ranges.
 */
export async function mentionsAtSend(
  q: Queryable,
  conversation: { id: string; type: ConversationType },
  text: string,
  picked: readonly Mention[] = [],
): Promise<Mention[] | null> {
  // No `@` typed anywhere: only what was picked (and no query at all).
  if (!text.includes("@")) return picked.length === 0 ? null : picked.map(({ id, start, length }) => ({ id, start, length }));
  const code = codeRanges(text);
  const taken: Range[] = picked.map((m) => [m.start, m.start + m.length] as const);
  const skip = [...code, ...taken];
  const tokens = mentionTokens(text, skip);
  const typed: Mention[] = [];
  const own = conversation.type === "agent" ? await ownAgent(q, conversation.id) : null;
  if (tokens.length > 0) {
    const handles = mentionedHandles(text, skip);
    const named = await namedIn(q, conversation.id, handles.filter((h) => own === null || (h !== own.handle && h !== own.namePart)));
    for (const token of tokens) {
      const id = own !== null && (token.handle === own.handle || token.handle === own.namePart) && handles.includes(token.handle) ? own.id : named.get(token.handle);
      if (id !== undefined) typed.push({ id, start: token.start, length: token.length });
    }
  }
  if (own !== null && own.name !== "") {
    const byName = new RegExp(`@${own.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "giu");
    const free = outside([...code, ...taken, ...typed.map((m) => [m.start, m.start + m.length] as const)]);
    for (const match of text.matchAll(byName)) {
      if (free(match.index!, match[0].length)) typed.push({ id: own.id, start: match.index!, length: match[0].length });
    }
  }
  const room = Math.max(0, MENTION_LIMIT - picked.length);
  const all = [...picked.map(({ id, start, length }) => ({ id, start, length })), ...typed.sort((a, b) => a.start - b.start).slice(0, room)];
  return all.length === 0 ? null : all.sort((a, b) => a.start - b.start);
}

/** The Agent of its own conversation `conversationId`: its id, full handle and name part (lower-cased), and its name. */
async function ownAgent(q: Queryable, conversationId: string): Promise<{ id: string; handle: string; namePart: string; name: string } | null> {
  const { rows } = await q.query<{ id: string; handle: string; name_part: string; name: string }>(
    `select p.id, lower(${handleOf("p")}) as handle, lower(p.handle::text) as name_part, p.display_name as name
       from agent_conversations ac join principals p on p.id = ac.agent_id where ac.conversation_id = $1`,
    [conversationId],
  );
  const r = rows[0];
  return r ? { id: r.id, handle: r.handle, namePart: r.name_part, name: r.name } : null;
}
