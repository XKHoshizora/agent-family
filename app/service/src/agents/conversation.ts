import { randomUUID } from "node:crypto";
import { lockAccount } from "../accounts/store.ts";
import type { Config } from "../config.ts";
import type { Change } from "../conversations/events.ts";
import { appendSystem } from "../conversations/system.ts";
import type { Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { insertMessage, MESSAGE_COLUMNS, toStored, type MessageBody, type MessageRow, type StoredMessage } from "../messages/model.ts";
import { cleanModelText, hasVisibleText } from "../schemas.ts";
import { parseProposalBlock, PROPOSAL_PLACEHOLDER, storeProposal, withoutUnfinishedBlock } from "./persona.ts";
import { ownedAgentOf } from "./runs.ts";
import { assertModelChoice, countLiveAgents, lockAgent, modelParams, type AgentModel, type AgentRow, type ReplyMode } from "./store.ts";
import type { ReasoningLevel } from "../config.ts";

/** The longest text a message holds (people's messages are refused above it; an Agent's reply is cut there). */
export const MESSAGE_TEXT_MAX = 8000;
/** The most of a reply's reasoning that is stored; the rest is cut (it is never shown to a model again). */
export const REASONING_MAX = 32_000;

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
  config: Pick<Config, "agentTiers" | "siteModels" | "providerDefaultMaxOutputTokens">,
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
    avatarVersion: 0,
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

/**
 * `postAsAgent` refused because the run is no longer `running`: something else ended it meanwhile — another instance's
 * recovery at start-up, while this one was still answering (a deploy where old and new instances overlap). Nothing was
 * posted; the run stays as that recovery recorded it.
 */
export class RunNotRunning extends Error {
  constructor(
    readonly runId: string,
    readonly status: string | null,
  ) {
    super(`postAsAgent: run ${runId} is ${status ?? "gone"}, not running`);
    this.name = "RunNotRunning";
  }
}

/** An Agent's reply as the worker hands it over. */
export interface AgentReply {
  text: string;
  reasoning: string;
  stopped: boolean;
  truncated: boolean;
}

/**
 * The one way an Agent's reply becomes a message (besides the fixed greeting at creation): under `lockAgent` — the
 * conversation row, then the `agents` row, the locks pause and delete take — so once a pause or delete has committed,
 * nothing more is posted: 409 `agent_paused` / `agent_deleted`, also for a run that pause or delete marked
 * `interrupted` after the Agent was resumed. Nor is a run posted that is no longer `running` (`RunNotRunning`: another
 * instance's recovery ended it, read under the same locks recovery takes). The message is the Agent's, kind `text`, with
 * `client_txn` = the run's id, so posting a run's reply again returns the stored message (`duplicate`) and stores
 * nothing. The text follows the rules of message text (`cleanModelText`: what a send would refuse is removed); a
 * persona proposal in it (`parseProposalBlock`: the reply's text only, never its reasoning) is taken out — the fixed
 * `PROPOSAL_PLACEHOLDER` stands in when nothing visible is left — and stored in this same transaction
 * (`storeProposal`, against the persona version read under this lock), the message's body naming it (`proposalId`).
 * The text is then cut at 8 000 characters, which marks it `truncated`. Without a proposal, a reply that was stopped or
 * cut (`truncated`) loses everything from its first `<af-` on (`withoutUnfinishedBlock`: it ended inside a block it
 * never finished); a complete reply with a malformed block keeps it as written. `reasoning` follows the rules of message
 * text, is cut at 32 000 characters (no mark) and is stored only when there is some. Null, storing nothing, when there
 * is nothing to show: no visible text and no reasoning.
 */
export async function postAsAgent(
  t: Tx,
  agentId: string,
  conversationId: string,
  runId: string,
  reply: AgentReply,
): Promise<{ message: StoredMessage; duplicate: boolean } | null> {
  const agent = await lockAgent(t, agentId);
  if (agent.conversationId !== conversationId) throw new Error(`postAsAgent: ${conversationId} is not the conversation of Agent ${agentId}`);
  const prior = await t.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from messages m where m.conversation_id = $1 and m.sender_id = $2 and m.client_txn = $3`,
    [conversationId, agentId, runId],
  );
  if (prior.rows[0]) return { message: toStored(prior.rows[0]), duplicate: true };
  // A run that has ended — another instance's recovery ended it while this one was still answering — is never posted;
  // nor is one its Agent's pause or delete interrupted, even once the Agent is resumed (runs.ts).
  const run = await t.query<{ status: string; interrupted: string | null }>("select status, interrupted from agent_runs where id = $1 and agent_id = $2", [
    runId,
    agentId,
  ]);
  if (run.rows[0]?.status !== "running") throw new RunNotRunning(runId, run.rows[0]?.status ?? null);
  const interrupted = run.rows[0].interrupted;
  if (interrupted) throw new AppError(409, interrupted);
  if (agent.deleted) throw new AppError(409, "agent_deleted");
  if (agent.paused) throw new AppError(409, "agent_paused");

  let text = cleanModelText(reply.text);
  const proposal = parseProposalBlock(text);
  const proposalId = proposal ? randomUUID() : null;
  if (proposal) text = hasVisibleText(proposal.visible) ? proposal.visible : PROPOSAL_PLACEHOLDER;
  let truncated = reply.truncated;
  const characters = Array.from(text);
  if (characters.length > MESSAGE_TEXT_MAX) {
    text = characters.slice(0, MESSAGE_TEXT_MAX).join("").trimEnd();
    truncated = true;
  }
  if (!proposal && (reply.stopped || truncated)) text = withoutUnfinishedBlock(text);
  let reasoning = cleanModelText(reply.reasoning);
  const thought = Array.from(reasoning);
  if (thought.length > REASONING_MAX) reasoning = thought.slice(0, REASONING_MAX).join("").trimEnd();
  if (!hasVisibleText(text) && !hasVisibleText(reasoning)) return null;

  const body: MessageBody = { text };
  if (reasoning !== "") body.reasoning = reasoning;
  if (reply.stopped) body.stopped = true;
  if (truncated) body.truncated = true;
  if (proposalId !== null) body.proposalId = proposalId;
  const message = await insertMessage(t, conversationId, agentId, "text", body, runId);
  if (proposal && proposalId !== null) await storeProposal(t, agent, proposalId, message.id, proposal.proposal);
  return { message, duplicate: false };
}

/**
 * `POST /api/conversations/:id/topic` (spec 6.2 "新话题"): appends a `topic_reset` notice from the owner to their
 * Agent's conversation, under `lockAgent` (the conversation row, then the `agents` row) like every write there. What the
 * model is shown starts after the latest one (`buildContext`); history and search keep everything. 404 unless it is
 * `ownerId`'s Agent conversation; 403 `cannot_send` (`agent_deleted`) once the Agent is deleted, as a send; allowed
 * while it is paused. It neither starts a reply nor ends one under way (which was given the old topic).
 */
export async function resetTopic(t: Tx, ownerId: string, conversationId: string): Promise<StoredMessage> {
  const agentId = await ownedAgentOf(t, ownerId, conversationId);
  if (!agentId) throw notFound();
  const agent = await lockAgent(t, agentId);
  if (agent.deleted) throw new AppError(403, "cannot_send", { reason: "agent_deleted" });
  return appendSystem(t, conversationId, { event: "topic_reset", actorId: ownerId });
}
