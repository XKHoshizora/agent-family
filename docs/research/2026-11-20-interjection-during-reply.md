# What other products do when people keep talking while an AI agent is still writing

Researched 2026-11-20, web reading only. Nothing was run or installed. Many pages were read through a summarising fetch tool, so wording is mine and numbers are "as reported". Confidence tags: **official** = a vendor doc or help page said it; **review** = a news piece, paper or community report said it; **unconfirmed** = I looked and could not confirm, or only a snippet exists.

The question: an agent is asked something (or decides to speak); while it generates, others answer, the topic moves, someone asks a second thing, someone says stop. What lands, what does the agent see, is anything cancelled, queued, threaded, quoted?

## Headline finding

**No product I could find documents a rule for "my late reply was overtaken by the conversation."** The documented mechanisms fall into two families:

1. **Chat products (Slack, Discord, Telegram, Teams, Mattermost, Open WebUI, ChatGPT, Meta AI)**: the answer is made *unmistakably tied to its question by the surface* (a thread, a reply-to, an edited placeholder, a private preview), and the late reply is simply allowed to land. None documents dropping or revising an overtaken reply.
2. **Coding/working agents and agent gateways (Claude Code, Codex, Cursor, Copilot SDK, OpenClaw)**: the answer to "a new message arrived mid-run" is a small named menu: **steer** (inject at next safe step), **queue** (own turn after), **collect** (merge queued into one follow-up after a quiet period), **interrupt** (abort). These are one-owner, one-conversation tools; there is no multi-person turn-taking in them.

Nothing found documents "re-read the new messages just before sending and let the model revise/cancel". That is the one idea from the proposal with zero shipped precedent in what I found (not proof that nobody does it).

---

## 1. Messaging platforms with assistants in groups

**ChatGPT group chats (OpenAI, Nov 2025; expanded to all logged-in users on Free/Go/Plus/Pro from 20 Nov 2025).** Reported: the model follows the flow of the conversation and chooses between answering and staying quiet; including "ChatGPT" in a message reliably makes it answer; it can react with an emoji and refer to profile photos; rate limits count only when ChatGPT replies, not messages between people. OpenAI's own pages returned 403 to me, so this rests on press summaries. No published rules for when it speaks, reacts, or what it does when overtaken. Confidence: **review** (secondary). Maturity: shipped by OpenAI to all plans, but under one year old. Sources: https://openai.com/index/group-chats-in-chatgpt/ (could not open), https://www.tomsguide.com/ai/chatgpt/chatgpt-just-got-a-major-upgrade-now-you-can-invite-friends-into-the-same-ai-conversation , https://www.gsmarena.com/openai_chatgpt_group_chats-news-70295.php

**Meta AI in WhatsApp groups.** Third-party guides: you reach it by typing @ and choosing Meta AI, or by replying to one of its messages; it answers in the chat for everyone; one report says it cannot read group messages except those where it is tagged. So reply-to is the follow-up channel. I found no official help-centre page (the WhatsApp Help Centre was not in results). Confidence: **review**, weak. Maturity: widely used (WhatsApp), but the group behaviour is only documented by third parties. Source: https://www.alphr.com/how-to-chat-with-meta-ai-in-a-group-chat-on-whatsapp/ , https://blog.whatsapp.com/lets-explore-ai

**Microsoft Copilot in Teams group chats.** Official: you @mention Copilot or add it from the people menu; anyone in the chat can prompt it; answers are grounded in the data of *the person who asked*. If it used only things everyone can see, the full answer posts; otherwise only the asker sees a preview with Approve / Reject, and rejecting posts a notice to all that a response could not be shared. Needs a Copilot licence to prompt; unlicensed members can read. Disabled in meeting chats. Described as a public preview on the page I read. The page says nothing on threads, quoting, or overtaken replies. Confidence: **official**. Maturity: Microsoft first party, preview. Sources: https://support.microsoft.com/en-us/office/copilot-in-teams-chats-2c613de4-cd26-4ae3-9e4b-6905d745d991 , https://support.microsoft.com/office/how-to-use-microsoft-365-copilot-in-teams-group-chats-2c613de4-cd26-4ae3-9e4b-6905d745d991 . Relevant to "owner pays, others read": the asker-approves-before-others-see pattern.

**Slack.** Official developer docs: agents live in a split-view panel or DM; in channels, @-mentions work as they do today and are left to the app. Replies go "directly or in thread" via `thread_ts`; the thread id is the unit of conversation context. While working, the app sets a status ("processing" shows a loading indicator, and if the app subscribes to a stop event, Slack shows a **stop button**); you set "active" when finished or the session times out after one hour. Streaming limited to 10 minutes per stream; for long tasks, post then update the message. **The docs say nothing about a new user message arriving mid-response.** Older method `assistant.threads.setStatus` is superseded by `agents.sessions.setStatus`. Confidence: **official** for the mechanisms; **unconfirmed** for mid-response behaviour. Maturity: very mature platform, the agent surface is new (2025-26). Sources: https://docs.slack.dev/ai/developing-agents , https://docs.slack.dev/reference/methods/assistant.threads.setStatus

**Discord.** Official: a slash-command or component interaction must be acknowledged within 3 seconds; a *deferred* response shows the "is thinking" loading message; the interaction token then lives 15 minutes for follow-ups; the loading message is filled by editing `@original`; ephemeral (only the invoker sees it) is fixed when the placeholder is made. Ordinary (non-interaction) bot messages have no such window; those are plain posts, optionally with a message reference (reply). Nothing in the docs about newer messages overtaking. Confidence: **official** (docs) . Maturity: very mature API. Source: https://docs.discord.com/developers/interactions/receiving-and-responding . Note the structure: placeholder first, edited in place, so the late reply lands *where the question was acknowledged*.

**Telegram.** Official: in groups, privacy mode is on by default, so a bot sees only commands to it, replies to its own messages, and a few others, unless made admin or privacy mode is turned off. Replying to a bot's message is the supported way to address it. Bots can address each other by mention in a command or by replying to a bot message (Bot-to-Bot mode). The page does not describe the `reply` parameter itself (that is in the Bot API reference, which I did not read). Confidence: **official**. Maturity: very mature. Source: https://core.telegram.org/bots/features#privacy-mode

**Google Chat / Gemini.** I found Gemini as a side-panel helper that summarises spaces, not an @mention agent that answers in-thread. Mention and thread behaviour: **unconfirmed**. Source: https://support.google.com/chat/answer/15345722

**Grok on X.** Official-ish press: mention @grok in a reply and it answers under that post; the reply is a normal post in the thread, so the *thread is the anchor*. A research paper on Grok interactions reports it answers about 62% of prompts. Nothing on overtaking. Confidence: **review**. Maturity: widely used. Sources: https://techcrunch.com/2025/03/07/x-now-lets-you-query-grok-by-mentioning-it-in-replies , https://arxiv.org/html/2602.21236v1

**Snapchat My AI in groups; Line; KakaoTalk.** Not researched in depth; **unconfirmed**.

**腾讯元宝 / WeChat.** The reports I found describe forwarding up to 100 chat messages to 元宝 for a summary, and @元宝 under 视频号 comments via an AI-suffixed contact. I did **not** find a documented in-group @元宝 reply flow. Confidence: **review**; group-reply behaviour **unconfirmed**. Sources: https://www.ifanr.com/1635953 . 元宝派 is an in-app multi-person feature (not WeChat groups); details **unconfirmed**.

**飞书 (Lark).** Official open-platform API: a bot can reply to a *specific message* (`.../im/v1/messages/:message_id/reply`), optionally `reply_in_thread` to make it a topic thread, with a `uuid` for de-duplication; group sending is rate-limited at 5 QPS shared by bots in a group; getting all group messages (not only @-mentions) needs a sensitive permission. So the platform gives developers *quote-reply* and *thread-reply* as first-class calls. Whether the first-party Feishu AI assistant uses them, **unconfirmed**. Confidence: **official** (via a search summary of the API doc). Source: https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply.md . 钉钉, 企业微信, 豆包/扣子 in groups: **unconfirmed** (not found).

## 2. Companion / multi-agent conversation products

**Character.AI group chats (Oct 2023, first for paid c.ai+).** Press: people and several characters in one room. One article says characters start chatting among themselves automatically; single source. No help-centre text on turn order or auto-reply found. Confidence: **unconfirmed**. Maturity: large consumer product, but the group feature's rules are not documented where I could read. Sources: https://techcrunch.com/2023/10/11/character-ai-introduces-group-chats-where-people-and-multiple-ais-can-talk-to-each-other

**Poe.** Multi-bot chat (Apr 2024): summon bots with @; a secondary summary says each bot answers independently (parallel, no floor). Creator changelog: an off-by-default setting that merges prior history into one message so the current bot has context. Group chat with people (Nov 2025): up to 200 users, multiple models. No documented turn-taking rules. Confidence: **review** / **official** (changelog). Sources: https://creator.poe.com/changelog/support-for-multi-bot-chat , https://techcrunch.com/2025/11/18/poes-ai-app-now-supports-group-chats-across-ai-models

**Kindroid, Nomi.** Not found / **unconfirmed**.

**SillyTavern group chats (open source, years old, large community).** Official docs: four reply-order strategies. *Manual*: only the member you pick replies; user messages don't trigger replies. *Natural*: scan the last message for whole-word member names, then roll each member's "talkativeness" (0% = only if named, 100% = always, default 50%); if nobody fires, one random speaker. *List*: roster order. *Pooled*: random among those who haven't spoken since the last user message. Per-character Mute and Force Talk. **Auto-mode**: next turn starts 5 seconds after the last character's message; typing in the send box turns auto-mode off, **but generations already queued are not stopped**. The docs do not describe stop/interrupt or what happens to user messages sent during a generation. Confidence: **official**. Source: https://docs.sillytavern.app/usage/core-concepts/groupchats . This is the best-documented "who speaks next among several agents" design, with a stop gap that matches our problem exactly.

## 3. Agent frameworks (turn-taking)

All of these are **developer frameworks for agents working among themselves**, with a human as one input; none has live multi-human chat timing, so none addresses overtaking.

- **AutoGen (SelectorGroupChat).** Official docs: a model picks the next speaker from history plus each participant's name and description; override with `selector_func`, narrow with `candidate_func`; same agent cannot speak twice in a row by default; termination by combinable conditions (e.g. a keyword OR a max message count); a `UserProxyAgent` lets a human give feedback when the selector routes to it. The page does not cover interruption. Maturity: widely used framework; the project has since split (AG2 fork, and Microsoft's newer Agent Framework) which I did not research. Confidence: **official**. Source: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html
- **Semantic Kernel AgentGroupChat.** Selection strategy (sequential or prompt-based) plus termination strategy with a max-iterations cap. The doc page says it is **archived, experimental, no longer maintained**, replaced by "Group Chat Orchestration." Confidence: **official**. Source: https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-chat
- **OpenAI Agents SDK handoffs.** One agent holds control at a time; a handoff is a tool call that transfers the conversation; the receiver sees the full history by default or a filtered one. Confidence: **official**. Source: https://openai.github.io/openai-agents-python/handoffs/
- **LobeChat group chat.** RFC (Aug 2025): a *supervisor* agent decides who speaks next and whether publicly or by DM. Current code may differ. Confidence: **review** (RFC + third-party code summary). Source: https://lobehub.com/blog/rfc-130
- **CrewAI, LangGraph, Letta, AG2:** not read; **unconfirmed**. (LangGraph's supervisor pattern is the same single-controller idea as handoffs, but I did not open its docs.)

## 4. Coding and working agents: a message arrives mid-run

These are the only products with a *documented, named policy*.

- **Claude Code.** Official: pressing Enter while it works **queues** the message (shown grey until started). Messages queued during tool calls are passed to the model as soon as those tool calls finish, within the same turn; when a turn ends with messages queued they go out in order. Ctrl+Enter sends queued messages without waiting; Esc interrupts the turn but keeps what you queued and sends it right away. Confidence: **official**. Maturity: widely used. Source: https://code.claude.com/docs/en/interactive-mode (section "Queue messages while Claude works"). Community issues show users want a separate hard steer vs queue key and a visible, editable queue (https://claudeissues.com/issue/77537-feature-first-class-steering-queue-ui-view-delete-and-inject-queued-messages-ind): **review**.
- **GitHub Copilot SDK.** Official: two modes. *Steering* (immediate): message injected before the next model request in the same turn; if a tool call is already committed it takes effect after that call; best-effort, falls back to the queue if the turn ended. *Queueing* (default): FIFO, each queued message starts its own full turn. Confidence: **official**. Source: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing
- **Codex CLI.** Community requests describe Enter = steer at next breakpoint, Tab = queue for after, Esc = hard stop. The Codex doc page I could open only says you can "steer the active turn"; a "Mid-turn steering" guide exists but was not read. Confidence: **review** for the key mapping. Source: https://learn.chatgpt.com/docs/codex/cli
- **Cursor.** Community posts (the official 1.4 changelog only says mid-run messages steer better): Send (default, delivered at next safe point), Queue (Option+Enter, after the loop), Stop & send (Cmd+Enter). Several forum threads report regressions where a new message cancelled the earlier task, or a message ran twice (interrupted *and* queued). Confidence: **review**. Source: https://forum.cursor.com/t/critical-regression-task-queues-no-longer-work-new-messages-cancel-previous-tasks/171529 , https://cursor.com/en/changelog/1-4
- **OpenClaw (open-source agent gateway that also lives in group chats).** Official docs, richest model found. Inbound messages during a run follow one of four queue modes: **steer** (default; injected into the active run, tools finish first), **followup** (own turn after), **collect** (queued messages merged into one follow-up after a quiet period; on Discord/Telegram it behaves like followup), **interrupt** (abort, run newest). Debounce default 500 ms; queue cap 20; overflow policy summarize/drop-old/reject-new. In Discord guild channels, ordinary messages from *different requesters* stay separate turns. In groups: replies need an @mention by default (a reply to the bot can count as an implicit mention on some channels); skipped messages are kept as pending context; always-on groups can feed unmentioned messages in as *quiet context* so the agent speaks only by explicitly sending; a token-only `NO_REPLY` ends a turn silently and discards unsent text; reply-to/quoted text is injected into context. Maturity: young project, popularity and production use **unconfirmed**; treat as a design reference, not proven practice. Sources: https://docs.openclaw.ai/concepts/queue , https://docs.openclaw.ai/channels/groups/index.html
- **Devin, Manus, ChatGPT agent:** not read; **unconfirmed**.

## 5. Voice barge-in (principles only)

OpenAI Realtime: speech start does not stop generation automatically; the client must stop local playback, send `response.cancel`, and send `conversation.item.truncate` with the audio actually played so the server's record of what was said matches what the listener heard. Community reports of timing errors. Transferable principle to text: **when a reply is cancelled, record in the history only what was actually delivered**, not what was generated. Confidence: **official** for the truncate event description; cancel-order details are **review**. Sources: https://developers.openai.com/api/docs/api-reference/realtime-client-events/conversation/item/truncate , https://community.openai.com/t/interruption-not-implemented-out-of-the-box-in-the-twilio-example/966625 . Gemini Live, Alexa: **unconfirmed**.

## 6. Research (all preprints; not product evidence)

- **Proactive Conversational Agents with Inner Thoughts** (Liu et al., arXiv 2501.00383, Dec 2024, revised Feb 2025; page lists no venue). Argues next-speaker prediction is weak in multi-party human-AI chat because turns are not allocated; the agent should keep a covert stream of thoughts and look for a moment to speak, driven by its own motivation. Formative study with 24 people; built into a web playground and a chatbot; the abstract says it beat baselines on coherence and turn-taking appropriateness (no numbers given in the abstract). https://arxiv.org/abs/2501.00383
- **Speak or Stay Silent: Context-Aware Turn-Taking in Multi-Party Dialogue** (Bhagtani et al., arXiv 2603.11409, Mar 2026, submitted to Interspeech 2026). Frames each pause as a speak/stay-silent decision; benchmark of 120,000+ labelled conversations; eight LLMs failed zero-shot; fine-tuning with reasoning traces improved balanced accuracy by up to 23 points; conclusion is that the skill must be explicitly trained. Relevant to our small judge model: prompting alone is reported unreliable. https://arxiv.org/abs/2603.11409
- **DiscussLLM** (arXiv 2508.18167) and **When2Speak** (arXiv 2605.05626): datasets with explicit speak/silent labels; I saw only search snippets, details **unconfirmed**. https://arxiv.org/pdf/2508.18167 , https://arxiv.org/pdf/2605.05626
- Addressee-recognition and interruption-handling literature: not found in this pass; **unconfirmed**.

## 7. Open-source chat-with-agents projects

- **Open WebUI channels.** Official docs: channels are passive; a model answers only when tagged; by default a top-level mention is answered **in a thread under that message** (admin setting can post to the channel timeline instead); a mention made inside a thread replies in that thread; replies stream. Concurrency and typing indicators are not documented. Maturity: very widely used project; channels feature newer. Confidence: **official**. Source: https://docs.openwebui.com/features/channels/
- **Mattermost Agents.** Official: @mention the agent in a channel or thread; the reply is visible to all; it uses earlier thread context up to the mention. Auto-reply without a mention is an Enterprise Advanced feature (per a search summary). Confidence: **official**. Maturity: established company; Agents plugin newer. Source: https://docs.mattermost.com/end-user-guide/agents
- **LobeChat group chat:** see §3 (supervisor). **Rocket.Chat:** not found.
- **Linger quiet delivery queue** (already in our own notes, https://github.com/simplexai-labs/linger , docs/research/2026-11-20-linger.md): unasked messages wait until the chat has been quiet 3 minutes, go out as one batch in order, and are dropped if their reason was revoked. Young project; licence forbids hosted reuse of its code, ideas only.

---

## Strategies found

"Who" lists only what I confirmed above. Cost is rough: latency / extra model calls / build effort.

| # | Strategy | Who ships it (confidence) | Cost | Failure it leaves |
|---|---|---|---|---|
| 1 | **Reply in a thread anchored to the trigger message** | Slack (`thread_ts`, official); Open WebUI channels (default for top-level mention, official); Feishu `reply_in_thread` (API, official); Grok on X (reply under post, review) | None at run time; UI work for threads | Group main timeline fragments; people who don't open the thread miss it; a thread is a heavy answer to a short question |
| 2 | **Native reply-to / quote on the agent's reply** | Telegram/WhatsApp/Meta AI replies are the way users address the bot (official/review); Feishu reply API (official); Discord reply references (not read in detail). Whether any *first-party AI* auto-quotes its own answers: **unconfirmed** | Near zero | Quote can look noisy when the answer is instant; does not fix the answer being stale |
| 3 | **Placeholder / status shown, then edited in place** | Discord deferred "is thinking" then edit `@original` (official); Slack status + stop button (official); Slack "post then update" for long tasks (official) | Low; message-edit support | Placeholder sits there if the work dies; long tasks hit token windows (Discord 15 min, Slack stream 10 min) |
| 4 | **Typing/processing indicator only** | Slack, OpenClaw typing indicator (official) | Trivial | Says nothing about what it is answering |
| 5 | **Stop button / stop event for the user** | Slack `agent_session_stopped` (official); coding agents Esc/Ctrl+C (official) | Low | Only the asker (or whoever has the control) can use it; group-level "stop" authority unsettled |
| 6 | **Mention-gating: speak only when addressed** | Meta AI, Telegram privacy mode, Open WebUI, Mattermost, OpenClaw default, Slack channels, Teams (all official or review) | Cheapest possible; no judge | Agent never contributes unasked; "reply to the bot" must also count |
| 7 | **Judge model decides unasked speaking** | ChatGPT group chats (review, rules unpublished); research prompts-only shown weak (Speak or Stay Silent) | One cheap call per candidate moment | Judge calibration; no shipped policy on late/overtaken |
| 8 | **Probability / talkativeness dial per agent** | SillyTavern Natural order (official) | Zero model calls | Random; does not read content beyond name matches |
| 9 | **Single floor: one speaker at a time via a manager/selector/supervisor** | AutoGen selector (official); Semantic Kernel (archived); Agents SDK handoff (official); LobeChat supervisor (RFC); SillyTavern order strategies (official) | One extra selection call or none | Frameworks assume agents talk to each other, not a human crowd; selector can be a latency and cost step |
| 10 | **Debounce: wait for quiet before acting** | OpenClaw 500 ms (official); SillyTavern auto-mode 5 s gap (official); Linger 3 min for *unasked* (own notes) | Adds latency; zero tokens | Adds delay to urgent asks; "quiet" threshold is a guess |
| 11 | **Steer: inject new messages into the run at the next safe step** | Claude Code (queued msgs reach model after current tool calls), Copilot SDK, Codex (review), Cursor (review), OpenClaw (default) | Needs a re-planning loop; no extra calls but longer run | Only works if the agent loop has tool-call boundaries; pure text generation has none |
| 12 | **Queue: new message starts its own turn after** | Claude Code (order kept), Copilot SDK (default), Cursor/Codex (review), OpenClaw followup | Simple FIFO | Earlier turn finishes on stale premise; answers pile up |
| 13 | **Collect: merge queued messages into one follow-up after a quiet period** | OpenClaw `collect` (official) — and on Discord/Telegram it falls back to followup | Saves tokens vs one-turn-each | Different people's requests get merged (OpenClaw keeps different requesters separate in Discord guilds) |
| 14 | **Interrupt: abort current generation, run newest** | OpenClaw `interrupt`, Cursor "Stop & send", Codex Esc, voice barge-in (official/review) | Wasted tokens already spent | Cancelled work lost; Cursor reports show unwanted cancels and double-runs |
| 15 | **Truncate to what was delivered after cancel** | OpenAI Realtime `conversation.item.truncate` (official) | Needs a record of delivered portion | Off-by-timing bugs in the wild |
| 16 | **Silent turn / explicit no-reply token** | OpenClaw `NO_REPLY` and "room_event" quiet context (official) | Model call already paid | Spent tokens produce nothing |
| 17 | **Unasked messages go as quiet-delivery queue, dropped if stale** | Linger (docs, young); no mature product confirmed | Low | Unproven at scale; a drop rule needs a "reason still holds" check |
| 18 | **Private preview first, asker approves before group sees** | Teams Copilot (official) | Human latency; extra UI | Reply may expire unseen; not about timing, about permissions |
| 19 | **Re-read new messages just before sending; model revises/cancels** | **No product found** | Extra call per reply | — |
| 20 | **Auto-quote the answered message only when overtaken** (our proposal) | **No product found** | Low | — |
| 21 | **Emoji reaction as acknowledgement** | ChatGPT group chats can react (review); acknowledgement-on-receipt as a documented pattern: **unconfirmed** | Near zero | Reaction vs reply choice undocumented |

## The 3–4 combinations that shipped products actually use

All combinations below are what I can confirm from sources; none includes dropping an overtaken reply.

**A. "Mention-gated, reply anchored to the question, let it land."** Strategies 6 + 1 or 2 + 3/4. This is Slack agents (threads, status, stop), Open WebUI channels (answer in thread under the mention), Mattermost agents, Discord interactions (placeholder edited), Telegram and WhatsApp/Meta AI (reply-to), Grok on X (reply under the post). The product's answer to "the conversation moved on" is that the answer visibly belongs to its question, and people can ignore it. Confidence: **official** for Slack/Discord/Open WebUI/Mattermost/Telegram. Maturity: highest of the four.

**B. "One owner, steer or queue, user picks."** Strategies 11 + 12 (+ 14 on demand). Claude Code, Copilot SDK, Codex, Cursor, OpenClaw. The default is "your new message reaches the run at the next safe point (or waits its turn)", with an explicit hard-stop for the person who owns the run. Confidence: **official** for Claude Code, Copilot SDK, OpenClaw; **review** for Codex, Cursor. Maturity: widely used for single-user work; not multi-person.

**C. "Agents take turns by roster rules, with a manual override."** Strategies 8 + 9 + 10 + 5. SillyTavern (reply order, talkativeness, 5 s auto gap, mute/force-talk, typing disables auto-mode), AutoGen selector (single speaker, no repeat, max-message cap). Confidence: **official**. Maturity: SillyTavern is proven for roleplay; AutoGen is a developer framework. Note SillyTavern's documented gap: stopping auto-mode does not cancel generations already queued.

**D. "Reply visible to all, but a gate decides what the group sees."** Strategies 6 + 18. Teams Copilot: the asker approves a private preview before it is shared. Confidence: **official**. Maturity: Microsoft first party, still labelled preview.

Honourable mention (not mature): **E. "Quiet delivery for unasked messages"** (Linger, 17) and **"quiet context vs speak"** (OpenClaw room_event + NO_REPLY, 16). Both young; both are the closest to the owner's "unasked reply" case.

## Fit to a product where each Agent is owned by one member and replies cost that owner money

Facts that follow from the sources, not recommendations:

- **A** costs the owner nothing extra and needs no new model call; its failure (a late answer to an old question) is handled by how the surface frames it. It was built for products where the answer's author pays no per-answer bill to someone else, so it says nothing about wasted spend.
- **B** assumes the person who pays is the person typing; the steer/queue/interrupt menu belongs to the owner of the run. In a group, the *asker may not be the owner*. OpenClaw is the only source that addresses this: in Discord guilds, different requesters' messages stay separate turns rather than merging.
- **C** is mostly cost-neutral (no judge, no extra calls when it is rules or dice) and was designed for one user driving several characters; it needs a decision on whose budget each turn spends.
- **D** is the only one that explicitly separates *who asked* from *who sees* with the asker holding a veto. Teams ties the answer to the asker's data and permissions; nothing in it concerns money.
- Interrupting (14) is the one strategy with a direct token cost (already generated text is discarded); steering (11) and queueing (12) do not discard.
- None of the sources documents cost accounting for unasked or overtaken replies in a multi-owner setting. That is a gap, not a finding.

## What surprised me

1. No product states a policy for "my reply was overtaken". Even Slack's agent docs say nothing about a user message arriving mid-response.
2. The only documented queue/steer/collect/interrupt vocabulary comes from single-user coding agents and OpenClaw, not from chat apps.
3. Slack, Open WebUI and Discord all solve it structurally (thread or placeholder), not with logic: the late reply is fine because it is attached to its question.
4. SillyTavern's own docs admit that stopping auto-mode does not cancel queued generations, the same gap we have.
5. Several mature multi-agent frameworks have been retired or split (Semantic Kernel AgentGroupChat is archived), so "framework turn-taking" is a weak guide.
6. Research reports LLMs fail zero-shot at "should I speak now", which bears on our judge model.

## Gaps (not found in this pass)

OpenAI help-centre text on ChatGPT group chats (403), Meta/WhatsApp official help text, Character.AI / Kindroid / Nomi rules, Snapchat, Line/Kakao, 钉钉 / 企业微信 / 豆包 / 扣子, CrewAI/LangGraph/Letta docs, Devin/Manus/ChatGPT agent, Gemini Live/Alexa, Rocket.Chat, and the Slack "Agent sessions" page which may describe mid-response behaviour.

## Addendum (controller, read in a real browser on 2026-11-20)

OpenAI's help-centre pages refuse automated readers (HTTP 403) but open normally in a browser. The article at `https://help.openai.com/en/articles/12703475` is now titled "Retiring group chats in ChatGPT": group chats "launched as a pilot"; since 9 July 2026 nobody can create or join one; existing ones stay readable (read-only in the UK; elsewhere messaging continues "while messaging is enabled"); OpenAI says it is "winding down group chats" to simplify the product and will keep exploring collaboration. So the most prominent first-party "AI inside a group chat" was withdrawn after about eight months. The page gives no reason beyond simplification, and says nothing about how replies overtaken by the conversation were handled. For this note: ChatGPT group chats are no longer a live reference, only a past one.
