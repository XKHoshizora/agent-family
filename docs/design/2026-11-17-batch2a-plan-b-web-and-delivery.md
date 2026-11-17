# Batch 2A / Plan B — Agents in the Web Client, and Delivery: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user can create and configure Agents, choose a model source, chat with an Agent with streamed replies, and see usage — in the approved interface, proven in real browsers, deployed to the acceptance environment, verified against a real model provider, and attacked by an independent reviewer.

**Architecture:** `app/web/` keeps its batch-1 shape: `api/` (one function per endpoint), `data/` (pure `model.js`, `sync.js` for pushes, `actions.js`, `viewmodel.js`) and `pages/` built from the prototype's components. Agents, providers, usage and runs become new slices of the same model; the streamed reply is transient client state keyed by run id and replaced by the stored message. Agent messages alone are rendered as safe Markdown in a lazily loaded chunk.

**Tech Stack:** React 19 + Vite, vitest, Playwright (all existing); new: `react-markdown`, `remark-gfm`, `remark-math`, `rehype-katex` + `katex`, `rehype-highlight` + `highlight.js` (MIT / BSD-3-Clause — confirm the licences of the versions installed). Service from Plan A. Railway acceptance environment (exists).

**Spec:** `docs/design/2026-11-16-batch2-personal-agent-design.md` (read it first; §6.6, §6.8, §6.9, §6.11 and §7 govern this plan). The service's contract is `app/service/README.md` — the authority on routes, wire shapes, pushes, error codes and limits. Visual baseline: `prototype-v2/` (especially `src/pages/Agents.jsx`) and its `AGENTS.md`.

## Global Constraints

- Everything in batch 1 Plan B's Global Constraints still binds (`docs/design/2026-11-16-batch1-plan-b-web-and-delivery.md`): client code under `app/web/` only; the prototype's layout, palette, density and interaction details do not change; new screens are assembled from existing components and classes, no new design language; no mock data or simulated replies in the real build; permissive licences only, recorded in the commit that adds a dependency; the session cookie is HttpOnly and nothing secret is stored in JS-readable storage; no personal data in URLs; the wire behaviour follows the service README exactly.
- Human messages stay plain text exactly as in batch 1. Only messages whose sender is an Agent are rendered as Markdown, and that renderer: allows no raw HTML; loads no remote resource of any kind (a Markdown image becomes its alt text as a plain link label, never an `<img>`); opens links in a new tab with `rel="noopener noreferrer"` and only for `http:`/`https:`; needs no change to the page's Content-Security-Policy (fonts and styles for maths are bundled and served from the same origin).
- A provider API key typed into the form is sent once to the service and then dropped from client state: never kept in the model, never logged, never put in a URL, the input cleared after save. The client shows `keyLast4` only.
- Money on the wire is decimal strings of points; the client never does float arithmetic on them (display only).
- Streamed text (`delta`) is transient: it never enters search, unread counts, the conversation preview or persistent state, and it is discarded when the stored message, a terminal `run`, a `gone`, or a reconnect arrives (then `GET /api/conversations/:id/run` is the truth).
- Every new interactive element is keyboard reachable and has an accessible name, as the batch-1 screens do.
- UI copy is Chinese in the prototype's tone; reuse existing strings where one exists. Every service error code the client can receive for these features has a Chinese sentence in `data/errorTexts.js`; an unknown code falls back to the existing generic sentence.
- Local commits after each task. Pushing the working branch and deploying to the acceptance environment are authorised by the user for this run (ledger, 2026-11-17): working branch only, never `master`, never force-push, the live project "Agent-Family" untouched.
- Real provider keys: read only from `E:\Agent-Family\CanalAPI-Key.txt` at the moment of use, passed by environment variable or request body, never printed, never committed, never written into any file in the repository, a log, a report or the acceptance record. Never typed into a browser form by an automated browser.
- The user is not an engineer. Undecided product behaviour → the most conservative option, implemented and listed for the user in the acceptance record. Never block on a question.

## Review Focus

1. A `delta` arriving for a run the client does not know (joined mid-stream after a reload, or after the terminal `run` push) — must not create a ghost bubble or resurrect a finished reply. → Task 1.
2. The stored Agent message arriving before, between or after the last `delta` — exactly one bubble, no flicker to empty, no duplicate. → Task 1, Task 4.
3. Agent output crafted to escape the renderer: raw HTML, `javascript:` links, remote images, enormous tables, a 50 000-character line, unclosed code fences, maths that makes the renderer throw. The page must not execute, fetch, or hang, and a renderer error degrades to plain text. → Task 5.
4. Confirming a proposal that went stale or was superseded in another tab — the card updates to its real state with a sentence, no error toast loop. → Task 4.
5. A user with no model source at all (no site models configured, no provider) — creating an Agent must lead them to adding a provider, not to a dead end or an Agent that silently never answers. → Task 2.

---

## File Structure

```
app/web/src/
  api/routes.js            += agents, proposals, runs, topic, providers, usage (one function per endpoint)
  data/model.js            += agents, providers, usage, runs, streams; avatar versions of other principals
  data/sync.js             += pushes: agent, run, delta, principal; run refetch on reconnect
  data/actions.js          += the async actions for all of the above
  data/viewmodel.js        += agent conversations, Agent rows, run/stream/proposal view state
  data/errorTexts.js       += texts for the new error codes
  pages/Agents.jsx         real list / create / edit / detail (from prototype-v2/src/pages/Agents.jsx)
  pages/AgentForm.jsx      form incl. model picker, reasoning level, persona draft
  pages/ModelPicker.jsx    site models (free / paid) and "my providers"
  pages/Providers.jsx      settings section: providers
  pages/Usage.jsx          settings section: usage and balance
  pages/AgentChatBits.jsx  streaming bubble, thinking, run status line, proposal card, new-topic control
  ui/Markdown.jsx          the lazily loaded safe renderer (Agent messages only)
  styles.css               minimal additions; the two batch-1 fixes
app/web/tests/             unit tests per task (vitest, jsdom)
app/web/e2e/               agents.spec.mjs, providers.spec.mjs, markdown.spec.mjs, fixes.spec.mjs; support/model-stub.mjs
app/service/               a test-only server entry for e2e that allows a local model stub (never in dist)
app/deploy/                README: new variables
docs/acceptance/batch2a/   README.md, shots/
```

---

### Task 1: Data layer — Agents, providers, usage, runs, streams

**Files:** Modify `src/api/routes.js`, `src/data/model.js`, `sync.js`, `actions.js`, `viewmodel.js`, `errorTexts.js`, `src/ui/primitives.jsx` (avatar URL versions); test `tests/agents-model.test.js`, `tests/agents-sync.test.js`, `tests/agents-actions.test.js`, extend `tests/viewmodel.test.js`.

**Interfaces — Produces** (names later tasks use):

- `api.*`: `listAgents`, `createAgent`, `getAgent`, `patchAgent`, `pauseAgent`, `resumeAgent`, `deleteAgent`, `uploadAgentAvatar`, `draftPersona`, `confirmProposal`, `discardProposal`, `getRun`, `stopRun`, `retryRun`, `dismissRun`, `resetTopic`, `listProviders`, `createProvider`, `patchProvider`, `deleteProvider`, `testProvider`, `refreshProviderModels`, `getUsage` — each exactly one endpoint of the service README.
- Model slices: `agents: {[id]: Agent}`, `providers: {[id]: Provider}`, `usage: Usage | null`, `siteModels: SiteModelView[]` (from whichever service response lists them — if the README offers none, add nothing here and report it: Task 2 needs the list), `runs: {[conversationId]: Run | null}`, `streams: {[runId]: {text, reasoning}}`, and `avatarVersions: {[principalId]: number}`.
- Push handling: `agent` → refetch that Agent and the conversation's messages page that carries proposals (per the README's rule); `run` → set `runs[conversationId]`, and on a terminal status drop `streams[run.id]`; `delta` → append to `streams[runId]` only if `runs[conversationId]?.id === runId` and it is `running`, otherwise ignore; `principal` → set `avatarVersions[id]`. On every (re)connect and after the first sync: `getRun` for each `agent` conversation, and clear all `streams`.
- View model: an `agent` conversation maps to the prototype's `type: "agent"`; the Agent's row in `state.agents` has what `prototype-v2/src/pages/Agents.jsx` reads (`name`, `handle`, `intro`, `field`, `role` ← persona, `privateReply`, `paused`, `ownerId: "me"`); every avatar URL of another principal carries its version (`avatarUrl(id, version)`), which is the web half of spec 6.11 item 1.
- `errorTexts`: sentences for `agent_limit`, `agent_paused`, `agent_deleted`, `no_quota` (two: free allowance used up with its reset time; balance), `provider_in_use`, `address_not_allowed`, `provider_rejected`, `provider_unavailable`, `stale_proposal`, `busy_run`, `context_too_small`, `busy`, `provider_limit`, `name_taken`, `handle_taken`.

- [ ] **Step 1: failing tests.** Model: applying `run(running)` then three `delta`s then the stored `message` then `run(done)` in every interleaving that the service can produce (message before the last delta; `run(done)` before the message; a `delta` after `run(done)`; a `delta` for an unknown run) ends with one message, no stream entry, and never a state in which both the stream bubble and the stored message are shown for the same run (`viewmodel` exposes at most one). Sync: a reconnect clears streams and calls `getRun` once per agent conversation; a `principal` push changes the avatar URL of that principal everywhere the view model exposes it; an `agent` push refetches. Actions: `createProvider` drops the key from every model slice and from the action's resolved value (search the serialised model for the key string); a failed action resolves to the error text for its code.
- [ ] **Step 2–4:** see them fail, implement, pass (`npm test` in `app/web`, lint clean).
- [ ] **Step 5:** commit `feat(web): data layer for agents, providers, usage and runs`.

### Task 2: Agent pages — list, create, edit, detail, pause, delete

**Files:** Rewrite `src/pages/Agents.jsx` from the prototype's; create `src/pages/AgentForm.jsx`, `src/pages/ModelPicker.jsx`; modify `src/pages/Contacts.jsx` (a "我的 Agent" group), `src/AppShell.jsx`, `src/icons.js`; test `tests/agents-pages.test.jsx`, `tests/model-picker.test.jsx`.

**Interfaces — Consumes:** Task 1. **Produces:** the Agent screens of spec §6.9.

- The list, form and detail follow `prototype-v2/src/pages/Agents.jsx` with exactly these differences (spec §6.9): the form's "角色说明" becomes "人格文档" (a larger textarea, limit 20 000, counter, hint that it only affects how it replies and grants nothing) with a "帮我起草" button (enabled when a name and a model are set; calls `draftPersona`; fills the textarea; never saves by itself); new fields: avatar (the batch-1 avatar editor reused), 账号名 (with a suggested value derived from the name, the human handle rule, "创建后不可修改"), 模型 (`ModelPicker`), 思考程度 (the six levels, only those the chosen model allows; hidden when it allows none); "群内回复方式" is removed. Detail tabs: 资料, 参与的会话 (the one dedicated conversation, "进入查看"), 能力与设备 (kept, body "尚未开放"). Detail gains "删除 Agent" with a confirmation that says it cannot be undone and the chat history stays readable. A deleted Agent is listed last with "已删除" and offers no actions.
- `ModelPicker`: two groups, "站点提供" (each model with 免费 / 需余额; a paid model is selectable with zero balance but shows that balance is needed) and "我的供应商" (provider name → its models). Nothing available at all → a notice with a button to Settings → 模型供应商. No site models configured → that group reads "尚未开放".
- Privacy notice (spec §6.8) beside the picker: conversations with this Agent are sent to the chosen model provider.
- Creating navigates into the new Agent's conversation.
- Validation mirrors the service (name 1–20, intro ≤ 40, field ≤ 20, persona ≤ 20 000, handle rule) with inline messages; server refusals (`handle_taken`, `agent_limit` with the tier's limit from `usage`) appear inline, not as a toast.

- [ ] **Step 1: failing tests** (jsdom, the batch-1 `harness.jsx` style): create with only a name and a site model posts exactly the expected body and lands in the conversation; "帮我起草" fills the textarea and sends nothing else; the reasoning selector lists only allowed levels and disappears for a model with none; `handle_taken` and `agent_limit` render inline; pause/resume toggle the tag and call the right endpoint; delete asks for confirmation and then lists the Agent as deleted without actions; with no model source the form shows the notice and its button opens the providers section; the contacts page lists own Agents under "我的 Agent" and nothing else about Agents.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `feat(web): agent list, form and detail`.

### Task 3: Settings — model providers; usage and balance

**Files:** Create `src/pages/Providers.jsx`, `src/pages/Usage.jsx`; modify `src/pages/Settings.jsx`; test `tests/providers.test.jsx`, `tests/usage.test.jsx`.

- Providers: list (name, protocol label, base URL, `…{keyLast4}`, model count); add / edit form: 名称, 接口类型 (the four protocols with their common names; fixed after creation), 接口地址, 密钥 (password input; on edit empty means "keep"; required again when the address's origin changes — the service enforces it, the form explains it), 模型 (list with add/remove; "从供应商读取" calls refresh and shows how many were found); per model an "高级" disclosure: 能看图片, 能直接读 PDF, 支持思考, 上下文容量. "测试连接" shows success or the sentence for the returned error. Delete: on `provider_in_use` list the Agents that use it. The privacy notice of spec §6.8 appears on this form too.
- Usage: 今日免费额度 (used / allowance, reset time in local time), 余额 (points; negative shown plainly with one sentence), 档位与 Agent 数量 (count / limit), 最近用量 (per Agent and model, points and reply count). Refetched when the section opens and after each terminal `run` push while it is open.

- [ ] **Step 1: failing tests:** saving a provider sends the key once and the input is empty afterwards; the key string is absent from the DOM after save; editing without a key omits `apiKey`; changing the origin without a key shows the explanation and does not submit; test-connection renders each of the three error sentences; delete in use lists the Agents; usage renders a negative balance and the reset time; points are shown as given (string in, same digits out).
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `feat(web): provider settings and usage`.

### Task 4: The Agent conversation

**Files:** Create `src/pages/AgentChatBits.jsx`; modify `src/pages/ChatView.jsx`, `Messages.jsx`, `Composer.jsx`, `ChatList.jsx`, `DetailsPanel.jsx`; test `tests/agent-chat.test.jsx`.

**Interfaces — Consumes:** Tasks 1, 2.

- Header and list row carry the prototype's Agent tag; no "已读"-style or friendship wording that does not apply.
- While `runs[conv]` is `queued` or `running`: a bubble from the Agent at the end of the list showing `streams[run.id].text` (or "正在回复…" while empty), and a "停止生成" button; thinking text (`reasoning`), when present, sits above the answer in a collapsed "思考过程" disclosure, both while streaming and on stored messages.
- Stored Agent messages: `stopped` → a small "已停止" mark; `truncated` → "已截断".
- `runs[conv]` `failed` → one status line at the end of the list (not a message): the sentence for the error, "重试" when `retryable`, and a dismiss control; `no_quota` shows the reset time or "余额不足" and links to Settings → 用量与余额; `context_too_small` says to shorten the persona or choose a model with a larger context and links to the Agent's edit page. `cancelled` shows nothing.
- Paused Agent: the prototype's pause notice above the composer; the composer stays usable. Deleted Agent: the frozen-conversation style with "这个 Agent 已删除，聊天记录仍可查看".
- "开始新话题": a control in the conversation's menu; the `topic_reset` notice renders as a divider-style system line.
- Proposal card on an Agent message that carries `proposal`: the proposed 人格文档 (collapsed beyond a few lines, expandable), 简介 / 擅长领域 when present, and by status — `open`: "确认", "修改后确认" (opens the text in an editor, then confirms with the edited values), "放弃"; `confirmed`: "已采用"; `discarded`: "已放弃"; `superseded`: "已被新的提议取代"; `stale`: "配置已变更，请重新生成提议". A 409 `stale_proposal` on confirm refetches and shows the card's real state with that sentence.
- When the Agent's model cannot see images and the owner attaches one: a one-line hint under the composer, "当前模型看不到图片，只会知道文件名".
- Scrolling follows the streaming bubble only while the user is at the bottom (the batch-1 rule for new messages).

- [ ] **Step 1: failing tests:** the streaming bubble shows deltas and is replaced by the stored message without a frame showing both or neither (assert on the rendered list after each event of every interleaving from Task 1); stop calls `stopRun` and the stored message shows "已停止"; each failure code renders its sentence, retry visibility follows `retryable`, dismiss calls `dismissRun` and hides the line; paused and deleted states; topic reset renders the divider; the proposal card in each of the five statuses, edit-then-confirm sends the edited body, a stale confirm ends in the stale card; the image hint appears only for a non-vision model.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `feat(web): agent conversation with streaming, runs and proposals`.

### Task 5: Safe Markdown for Agent messages

**Files:** Create `src/ui/Markdown.jsx` (lazy chunk); modify `src/pages/Messages.jsx`, `AgentChatBits.jsx`, `styles.css`, `vite.config`; test `tests/markdown.test.jsx`.

- Rendered: paragraphs, headings (visually capped so a reply cannot shout), lists, emphasis, inline code, fenced code with syntax highlighting and a "复制" button, block quotes, tables (horizontally scrollable inside the bubble), links, inline and block maths. Mermaid and other diagram fences render as code.
- Not rendered: raw HTML (shown as text), images (the alt text as a link label to the URL, never fetched), any URL scheme but `http`/`https` (shown as text).
- KaTeX runs with `trust: false`, `strict` errors off, `throwOnError: false`, `maxExpand` bounded; its CSS and fonts are bundled.
- An error boundary around the renderer falls back to the plain-text rendering of the same message; a message over 50 000 characters or with a line over 10 000 is rendered as plain text without trying.
- The streaming bubble is rendered through the same component (so half-written Markdown must never throw).
- Human messages do not pass through this component at all.

- [ ] **Step 1: failing tests:** each allowed construct renders to the expected element; `<img src=x onerror=…>`, `<script>`, `<iframe>`, an inline `style`, `[x](javascript:alert(1))`, `![a](https://evil.example/p.png)` and a `data:` link produce no `img`, `script`, `iframe`, no element with an event-handler attribute and no `href` other than http(s) (assert on the DOM, and assert that `fetch`/`Image`/`XMLHttpRequest` were not called); links have `target="_blank"` and `rel` containing both `noopener` and `noreferrer`; unclosed code fence, unbalanced `$`, a 5 000-row table and deeply nested lists (depth 200) render or fall back within 1 s without throwing; a human message containing Markdown syntax is shown literally.
- [ ] **Step 2–4:** fail, implement, pass; `npm run build` succeeds and the Markdown chunk is separate from the entry chunk. Record every added package's licence in the commit message.
- [ ] **Step 5:** commit `feat(web): safe markdown for agent messages`.

### Task 6: The two batch-1 fixes (spec §6.11 items 2 and 3)

**Files:** Modify `src/styles.css`, `src/pages/Messages.jsx`; test `tests/render.test.jsx`, `e2e/fixes.spec.mjs` (written here, run in Task 7).

- Bubble width: a bubble from someone else is as wide as its content, never stretched by the name-and-time line; same content gives the same bubble size on both sides.
- "已读": directly under my bubble, right-aligned to it, with no space reserved for the hover-only "回复" control (which keeps appearing on hover, to the left of the receipt).

- [ ] **Step 1: failing e2e assertions** (they need a real layout): two users exchange the same one-emoji message; the two bubbles' rendered widths differ by at most 1 px; the "已读" label's right edge is within 2 px of my bubble's right edge and its top is below the bubble's bottom.
- [ ] **Step 2–4:** fail, implement, pass (unit tests now; the e2e file in Task 7's run).
- [ ] **Step 5:** commit `fix(web): bubble width and read receipt position`.

### Task 7: Browser tests

**Files:** Create `e2e/agents.spec.mjs`, `e2e/providers.spec.mjs`, `e2e/markdown.spec.mjs`, `e2e/support/model-stub.mjs`; modify `e2e/support/app.mjs`, `e2e/global-setup.mjs`; a test-only service entry (e.g. `app/service/tests/helpers/e2e-server.ts`) that builds the app with the local-stub allowance.

- The model stub is a small local HTTP server speaking the OpenAI Chat Completions streaming format, scriptable per test (reply text, chunk delay, reasoning, error status, hang). The service under test is started with one free and one paid site model pointing at it and a small `FREE_DAILY_POINTS`. The production entry (`src/server.ts`, `dist/`) cannot enable the local allowance; only the test entry can.
- Specs (two browser contexts where two people are involved):
  1. Create an Agent with an empty persona → greeting visible → send a message → streamed reply appears progressively → reload → history intact, no stream remnant.
  2. Stop mid-stream → "已停止"; pause → no reply to a new message; resume → the next message is answered, the paused-period one is not.
  3. Add a provider (pointing at the stub), test connection, pick its model for an Agent, get a reply; the key is nowhere in the DOM or `localStorage`/`sessionStorage` afterwards.
  4. Use up the free allowance → the next message shows the quota sentence with a reset time; after an admin grant (through the service CLI from the test helper) a paid-tier reply works and Usage shows the charge.
  5. Proposal: the stub replies with a proposal block → card → confirm → the Agent's persona in its detail page is the proposed text; a second proposal supersedes the first.
  6. New topic → divider; the stub's next recorded request contains only the later message.
  7. Markdown: a reply with a heading, code, table, maths, a remote image and a raw `<script>` renders the first four, issues no request to the image host (assert with Playwright's request log) and executes nothing.
  8. Avatar sync: B changes avatar; A's open page shows the new image without reload (spec 6.11 item 1).
  9. `fixes.spec.mjs` from Task 6.
  10. A stranger cannot open another user's Agent conversation by URL and sees the same not-found view as for a random id.
- [ ] **Step 1:** write the specs and the stub; **Step 2:** run, fix what the browser reveals (client fixes only; a service defect is reported, not patched here); **Step 3:** the whole e2e suite (batch-1 specs included) passes twice in a row.
- [ ] **Step 4:** commit `test(web): browser tests for agents, providers, markdown and fixes`.

### Task 8: Deploy to the acceptance environment

**Files:** Modify `app/deploy/README.md` (already updated by Plan A Task 12 — verify), `docs/acceptance/batch2a/README.md` (start it).

- New variables on the Railway service `af-app` of project `agent-family-acceptance`: `PROVIDER_KEY_SECRET` (generate 48 random bytes, base64; set without printing; note in the acceptance record that it must be backed up with the database, and where it lives), `SITE_TIMEZONE=Asia/Shanghai`, `FREE_DAILY_POINTS`, `SITE_MODELS` (see below), and the upstream key variable named by `apiKeyEnv` (value read from the user's key file, never printed).
- Choosing site models: query the provider's model list with the key (base URL from the same file), pick one inexpensive model as the free-tier model and one stronger model as the paid-tier model, each on the protocol the provider serves it best; record the choice and the reason. Prices in points per million tokens are the controller's call (documented default: 1 point = 1 000 tokens of the free model's output; a paid model priced proportionally to its public price); `FREE_DAILY_POINTS` default 200.
- Deploy as in batch 1: `git archive HEAD app/web app/service app/deploy` into a scratch directory, `railway up --detach` with explicit project, environment and service ids. Migrations run on start. Confirm `GET /api/health`, then a signed-in smoke through the API: create an Agent on the free model, send a message, receive a reply.
- Grant the three seeded acceptance accounts a balance with `credits:grant` (run inside the service container) so the paid tier can be tried.
- Push the working branch (`git push origin claude/agent-family-review-8a6084`; never `master`, never force).
- [ ] Each step is recorded in the acceptance record with what was verified and how.

### Task 9: Real-provider verification (spec acceptance item 8)

- Locally, with the key from the user's file in the environment: a script (kept untracked under `.claude/`) drives `createModelGateway` once per protocol against the real provider with a one-sentence prompt and `maxOutputTokens` 64: `openai_chat`, `openai_responses`, `anthropic`, `gemini`; then once more at a non-`none` reasoning level for a model that supports it; then one image part for a vision model. For each: worked / failed with the mapped code and upstream status. A protocol the provider does not actually serve is recorded as "not verified against a real provider", never as passed.
- On the acceptance environment: one conversation on a site model through the browser (no key is typed anywhere), and one on a user provider created through the service API by a script (the key goes from the file to the user's own service only).
- Total spend is kept minimal (short prompts, small output caps); the record states roughly how many calls were made.
- [ ] Results go into the acceptance record as a table.

### Task 10: Adversarial review, fixes, acceptance record

- An independent reviewer (fresh context, most capable model) gets the code and the running acceptance service and attacks spec §7 items 11–22 and freely: prompt injection through conversation, file contents and file names to change configuration, leak another user's data, or exfiltrate through rendered output; SSRF through provider addresses (the deployed service, not just tests); overdrawing balance or free allowance by racing; posting as an Agent; reading another user's Agent, provider, proposal, run or usage; breaking the Markdown renderer. Findings are fixed (service fixes follow Plan A's constraints), each with a test, and re-reviewed until a round finds nothing exploitable.
- `docs/acceptance/batch2a/README.md`: every item of spec §7 with code state, what covers it, deployed or not, limits; the real-provider table; screenshots of the new screens beside the prototype's where one exists; decisions made on the user's behalf with what each costs if wrong; what the user must do (look at the new screens; decide prices and free allowance; choose the long-term provider); known limits.
- Backup/restore note extended with `PROVIDER_KEY_SECRET` (a restore without it loses every saved provider key; state it plainly). A full restore rehearsal is not repeated unless the schema additions give a reason; say which.
- Update the design doc where rulings changed it (Agents invisible without the two exceptions; charge capped at the hold; GIF by name; `context_too_small`; turn ordering) so the spec matches what was built.
- Final deploy of the fixed code, remote smoke, push.
