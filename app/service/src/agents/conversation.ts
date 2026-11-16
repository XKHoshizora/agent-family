import { lockAccount } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Change } from "../conversations/events.ts";
import type { Tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { insertMessage } from "../messages/model.ts";
import { assertModelChoice, countLiveAgents, modelParams, type AgentModel, type AgentRow, type ReplyMode } from "./store.ts";
import type { ReasoningLevel } from "../config.ts";

const UNIQUE_VIOLATION = "23505";

export const greetingText = (name: string): string =>
  `你好，我是「${name}」，你刚刚创建的 Agent。我现在还没有设定。你希望我是谁、主要帮你做什么、用什么语气说话？直接告诉我就行，说完我会整理成一份设定给你确认。`;

export interface NewAgent {
  handle: string;
  name: string;
  intro: string;
  field: string;
  persona: string;
  replyMode: ReplyMode;
  reasoning: ReasoningLevel;
  model: AgentModel;
}

/**
 * Creates an Agent in one transaction: its principal (kind `agent`, owned by `ownerId`), the `agents` row, the
 * dedicated conversation (type `agent`, `agent_conversations`, owner and Agent as speakers from seq 0) and, when
 * there is no persona yet, the fixed greeting from the Agent. The owner's account lock (taken first: it also
 * serialises the count) decides the limit: 403 `agent_limit` at the tier's number of Agents that are not deleted
 * (a tier `config` no longer names gets the `free` number). 409 `handle_taken`; 400 for a model or reasoning level
 * that does not fit.
 */
export async function createAgent(
  t: Tx,
  ownerId: string,
  input: NewAgent,
  config: Pick<Config, "agentTiers" | "siteModels">,
): Promise<{ agent: AgentRow; change: Change }> {
  const account = await lockAccount(t, ownerId);
  const limit = config.agentTiers[account.tier] ?? config.agentTiers.free!;
  if ((await countLiveAgents(t, ownerId)) >= limit) throw new AppError(403, "agent_limit");
  await assertModelChoice(t, ownerId, input.model, input.reasoning, config);

  let id: string;
  try {
    const { rows } = await t.query<{ id: string }>(
      "insert into principals (kind, handle, display_name, owner_id) values ('agent', $1, $2, $3) returning id",
      [input.handle, input.name, ownerId],
    );
    id = rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new AppError(409, "handle_taken");
    throw err;
  }
  const personaVersion = input.persona === "" ? 0 : 1;
  const created = await t.query<{ created_at: Date }>(
    `insert into agents (principal_id, intro, field, persona, persona_version, reply_mode, reasoning,
                         model_source, site_model_id, provider_id, provider_model)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning created_at`,
    [id, input.intro, input.field, input.persona, personaVersion, input.replyMode, input.reasoning, ...modelParams(input.model)],
  );
  const conversation = await t.query<{ id: string }>("insert into conversations (type, creator_id) values ('agent', $1) returning id", [ownerId]);
  const conversationId = conversation.rows[0]!.id;
  await t.query("insert into agent_conversations (conversation_id, agent_id, owner_id) values ($1, $2, $3)", [conversationId, id, ownerId]);
  await t.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq)
     values ($1, $2, 'speaker', 0), ($1, $3, 'speaker', 0)`,
    [conversationId, ownerId, id],
  );
  // The one message an Agent gets without a reply run: it counts as unread for the owner like any other.
  const greeting =
    input.persona === ""
      ? [await insertMessage(t, conversationId, id, "text", { text: greetingText(input.name), fixed: true }, null)]
      : [];

  const agent: AgentRow = {
    id,
    ownerId,
    handle: input.handle,
    name: input.name,
    intro: input.intro,
    field: input.field,
    persona: input.persona,
    personaVersion,
    replyMode: input.replyMode,
    reasoning: input.reasoning,
    model: input.model,
    paused: false,
    deleted: false,
    conversationId,
    createdAt: created.rows[0]!.created_at,
  };
  return { agent, change: { messages: greeting, conversations: [{ conversationId, principalIds: [ownerId, id] }] } };
}
