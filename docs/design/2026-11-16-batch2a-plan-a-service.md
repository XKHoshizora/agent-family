# Batch 2A / Plan A — Personal Agents in the AF Service: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The service lets a user own Agents, each with a dedicated conversation in which the Agent replies through a real model (the user's own provider or a site model), with usage metered and every rule enforced server-side and proven by API-level tests.

**Architecture:** An Agent is a `principals` row of kind `agent`; its reply is an ordinary message written through the existing send transaction with the Agent as sender. A reply is a row in `agent_runs`, picked up by an in-process worker that talks to the model through one `ModelGateway` and to the conversation only through a narrow `AgentPort`. Site-model calls are admitted and settled against a per-user free allowance and a points balance kept in an append-only ledger.

**Tech Stack:** what `app/service` already uses (Node ≥ 24, TypeScript strict ESM, Fastify 5, zod, `pg`, node-pg-migrate, vitest) plus the Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`; Apache-2.0 — confirm the licence of the exact versions installed) for the four model protocols, and `node:crypto` for key encryption.

**Spec:** `docs/design/2026-11-16-batch2-personal-agent-design.md` (Chinese; read it first — it is the authority). It builds on `docs/design/2026-11-15-batch1-real-social-design.md`. The service's own contract is `app/service/README.md`.

**What this plan does not cover:** the web client, browser tests, the three web-side fixes of spec 6.11 items 2 and 3, deployment, real-provider verification, the adversarial review and the acceptance record. Those are Plan B, written after this plan lands so it can cite the real API. Spec acceptance items 8, 9, 10 (web part), 3c, 22 (rendering), 23, 24 belong to Plan B.

## Global Constraints

- Everything in batch 1 Plan A's Global Constraints still binds (`docs/design/2026-11-15-batch1-plan-a-service.md`): code under `app/service/` only; commit locally after each task, never push or deploy; permissive licences only, recorded in the commit that adds a dependency; zod schema on every route, 400 before handler code, never 5xx for malformed input; the acting principal comes only from the session; `404 {"error":"not_found"}` identically for "does not exist" and "not yours"; tests against the real Postgres in WSL; do not install anything on the machine or touch WSL beyond the existing database; do not ask the user technical questions.
- Every write keeps "check and mutate in one transaction". Lock order, extended: pair lock (direct chats) → conversation row → `agents` row → `accounts` row. Never take them in another order.
- An Agent's message is written only by `postAsAgent` (Task 7) inside the existing send path. No other code inserts a message with an Agent as sender, except the fixed greeting at creation (Task 3).
- The worker and everything under `src/agents/runtime/` may import the database only through `AgentPort` (Task 7). A test (`tests/agent-port-boundary.test.ts`) fails if a file there imports `../db.ts`, `pg`, or any `store.ts`.
- A provider key exists in plaintext only inside `src/providers/crypto.ts` and the function that hands it to the gateway. It never appears in a response, a push, an `AppError` detail, a log line, or `agent_runs.error_detail`. Upstream error bodies are never stored or returned verbatim: map them to codes.
- Every outbound model request goes through `guardedFetch` (Task 4). Nothing else in the service may call `fetch` or open a socket to a user-supplied host.
- Money is integer micro-points (`bigint`, 1 point = 1 000 000 micro-points). No floats in storage or arithmetic. Token prices are micro-points per token.
- New error codes: `agent_limit`, `agent_paused`, `agent_deleted`, `no_quota`, `provider_in_use`, `address_not_allowed`, `provider_rejected`, `provider_unavailable`, `stale_proposal`, `busy_run`. Add them to `ErrorCode` in `src/errors.ts` and to the README error table.
- Read the AI SDK's current documentation (ai-sdk.dev) for the installed major version before writing gateway code; do not write its API from memory. Use only its core (`streamText`) and the three provider packages; no UI packages, no gateway/hosted service, no telemetry.
- Tests never call a real model. Rule tests inject a scripted `ModelGateway`; protocol tests (Task 5) use a local HTTP stub.
- Fixed values from the spec: Agent name 1–20 characters; intro ≤ 40; field ≤ 20; persona ≤ 20 000 characters; handle rule as humans (`^[a-z0-9_]{3,24}$`), immutable; reply modes `always` | `mention`; reasoning levels `none` | `low` | `medium` | `high` | `xhigh` | `max`; protocols `openai_chat` | `openai_responses` | `anthropic` | `gemini`; free tier = 20 Agents; site model tiers `free` | `paid`.

## Review Focus

1. **Pause or delete racing a reply.** After the pause commits, no Agent message is stored, including the one being generated at that instant. → Task 7.
2. **Concurrent replies overdrawing.** However many replies one user starts at once, the forgiven free overrun and the negative balance are each at most one reply's maximum cost. → Task 6.
3. **A provider hostname that resolves to a public address when saved and a private one when called.** The call is refused at connect time. → Task 4.
4. **An upstream that echoes the API key (or returns HTML) in its error.** Nothing of it reaches the owner, the log or the database. → Tasks 4, 5.
5. **The service dying mid-reply.** On restart: no second model call, no duplicate message, no hold left counting against the user. → Task 9.
6. **The owner sending three messages while the Agent is still answering the first.** Exactly one further reply follows, covering all three; never parallel replies. → Task 7.

---

## File Structure

```
app/service/
  migrations/
    008_agents.sql            agents, agent_conversations, conversations.type += 'agent', principals.avatar_version
    009_providers.sql         providers
    010_metering.sql          accounts, balance_ledger, free_usage, usage_records
    011_runs.sql              agent_runs, persona_proposals
  src/
    config.ts                 += agent / metering / site-model settings (Task 1)
    cli.ts                    += credits:grant, credits:show, tier:set, models:list (Task 2)
    accounts/   store.ts (tier, balance, ledger) · routes.ts (GET /api/usage)
    metering/   prices.ts (site models, cost maths) · admit.ts · settle.ts
    providers/  crypto.ts · guard.ts (guardedFetch) · store.ts · routes.ts
    models/     gateway.ts (ModelGateway interface + AI SDK implementation) · resolve.ts (Agent → callable model)
    agents/     store.ts · routes.ts · conversation.ts (create, canSend, postAsAgent) · persona.ts (draft, proposals)
                runtime/ port.ts (AgentPort) · worker.ts · context.ts · prompt.ts · stream.ts
  tests/
    helpers/    models.ts (scripted gateway, protocol stub server) · agents.ts (createAgent, grant, …)
    agents*.test.ts  providers*.test.ts  metering*.test.ts  runs*.test.ts  persona.test.ts  gateway-protocols.test.ts
```

Existing files that change: `src/app.ts` (Deps: `models`, `agentWorker`; route registration), `src/errors.ts`, `src/conversations/store.ts` (agent conversations in `lockForWrite`, `canSend`), `src/messages/model.ts` + `read.ts` (wire fields), `src/messages/routes.ts` (trigger), `src/sync/read.ts` + `hub.ts` (conversation type, pushes), `src/principals/routes.ts` + `store.ts` (lookup hides Agents, avatar version), `src/social/*` and `src/conversations/groups.ts` (Agents cannot be befriended or added), `README.md`.

## Wire additions (shared by tasks; Plan B relies on these exact names)

- **Principal**: `+ "avatarVersion": number` (0 until first change).
- **Conversation**: `type` gains `"agent"`; for it `"agentId"` replaces `peerId`, `canSend.reason` may be `"agent_deleted"`, and `"agent": {"paused": boolean, "deleted": boolean}` is present.
- **WireMessage**: `+ "reasoning"?: string` · `"stopped"?: true` · `"truncated"?: true` · `"proposal"?: {"id", "status": "open"|"confirmed"|"discarded"|"superseded"|"stale", "persona", "intro"?, "field"?}` (only rendered for the Agent's owner).
- **System notice**: `event: "topic_reset"`, `actorId`.
- **Pushes**: `{"type":"principal","id","avatarVersion"}` · `{"type":"agent","id"}` (config, pause or delete changed: refetch) · `{"type":"run","conversationId","run": Run}` · `{"type":"delta","conversationId","runId","text"?: string,"reasoning"?: string}`.
- **Run**: `{"id","status":"queued"|"running"|"done"|"failed"|"stopped"|"cancelled","error"?: ErrorCode,"retryable": boolean,"resetsAt"?: string}`.
- **Agent** (owner only): `{"id","handle","name","intro","field","persona","personaVersion","replyMode","reasoning","model": {"source":"site","id"} | {"source":"provider","providerId","model"} | null,"paused","deleted","conversationId","createdAt"}`.
- **Provider** (owner only): `{"id","name","protocol","baseUrl","keyLast4","models":[{"name","vision","pdf","reasoning","contextTokens"}]}`.

---

### Task 1: Schema and configuration

**Files:** Create `migrations/008_agents.sql` … `011_runs.sql`; modify `src/config.ts`, `.env.example`; test `tests/schema-agents.test.ts`, extend `tests/build.test.ts` style config tests in `tests/config-agents.test.ts`.

**Interfaces — Produces:**

- Tables (columns beyond the obvious `id`, `created_at`):
  - `agents(principal_id pk → principals, intro, field, persona text not null default '', persona_version int not null default 0, reply_mode, reasoning, model_source null|'site'|'provider', site_model_id, provider_id → providers on delete restrict, provider_model, paused bool, deleted_at)`; check: the three model columns are consistent with `model_source`.
  - `agent_conversations(conversation_id pk → conversations, agent_id unique → principals, owner_id → principals)`.
  - `conversations.type` check gains `'agent'`; `principals.avatar_version int not null default 0`.
  - `providers(id, owner_id, name, protocol, base_url, key_cipher bytea, key_last4, models jsonb)`; unique `(owner_id, name)`.
  - `accounts(principal_id pk, tier text default 'free', balance_micro bigint default 0)` — no non-negative check (spec 6.4 allows one reply of debt).
  - `balance_ledger(id bigserial, owner_id, delta_micro, reason 'grant'|'adjust'|'usage', note, usage_id)`; `free_usage(owner_id, day date, used_micro, pk(owner_id, day))`.
  - `usage_records(id bigserial, owner_id, agent_id, run_id, purpose 'reply'|'draft', source 'site'|'provider', model, input_tokens, output_tokens, estimated bool, cost_micro, free_micro, balance_micro, forgiven_micro, outcome 'done'|'stopped'|'failed'|'cancelled')`.
  - `agent_runs(id uuid, purpose 'reply'|'draft', conversation_id null, agent_id null, owner_id, status, covers_seq bigint, pending_seq bigint, charge_to null|'free'|'balance', hold_micro bigint default 0, error, started_at, finished_at)`; unique partial index on `(agent_id) where status in ('queued','running')`; check: `purpose = 'reply'` ⇔ both `conversation_id` and `agent_id` are set. A `draft` row (Task 10) exists so that its hold is counted by admission like any other. `usage_records.agent_id` and `run_id` are nullable for the same reason.
  - `persona_proposals(id uuid, agent_id, message_id → messages, base_persona_version, persona, intro, field, status)`.
- `Config` gains: `providerKeySecret` (`PROVIDER_KEY_SECRET`, ≥ 32 characters, **required**: the service refuses to start without it; add it to the test harness's config and to `.env.example`), `siteModels: SiteModel[]` (`SITE_MODELS`, a JSON array, default `[]`), `freeDailyMicro` (`FREE_DAILY_POINTS`, default 200 points), `siteTimezone` (`SITE_TIMEZONE`, IANA name, default `Asia/Shanghai`), `agentTiers: Record<string, number>` (`AGENT_TIERS`, JSON, default `{"free":20}`; must contain `free`), `agentMaxConcurrentRuns` (2), `agentRunsPerMinute` (20), `agentRunTimeoutMs` (120000), `providerDefaultContextTokens` (16000), `providerDefaultMaxOutputTokens` (2048).
- `SiteModel = { id, label, tier: 'free'|'paid', protocol, baseUrl, apiKeyEnv, model, inputMicroPerToken, outputMicroPerToken, maxOutputTokens, contextTokens, vision, pdf, reasoning: ReasoningLevel[] }`. `apiKeyEnv` names another environment variable holding the upstream key, so the JSON itself carries no secret; a missing variable fails start-up naming it.

- [ ] **Step 1: failing tests.** `schema-agents.test.ts`: inserting an `agents` row for a human principal fails; `model_source='site'` with a `provider_id` fails; two active runs for one agent fail on the partial index while a `done` plus a `queued` succeed; `conversations.type='agent'` is accepted. `config-agents.test.ts`: malformed `SITE_MODELS` (not JSON, unknown protocol, negative price, `apiKeyEnv` unset) each stop `loadConfig` with a message naming the variable; `AGENT_TIERS` without `free` is refused; a 31-character `PROVIDER_KEY_SECRET` is refused.
- [ ] **Step 2:** run them, expect failures.
- [ ] **Step 3:** write the four migrations (each with a Down section, in the style of 004) and the config parsing. Add every new variable to `.env.example` with a comment and to the README configuration table.
- [ ] **Step 4:** `npm test -- schema-agents config-agents schema` passes; `npm run typecheck` clean.
- [ ] **Step 5:** commit `feat(service): schema and configuration for agents, providers and metering`.

### Task 2: Accounts, balance ledger, tiers, admin commands

**Files:** Create `src/accounts/store.ts`, `src/accounts/routes.ts`; modify `src/cli.ts`, `package.json` scripts; test `tests/accounts.test.ts`, `tests/cli-credits.test.ts`.

**Interfaces — Produces:**

- `ensureAccount(t: Tx, ownerId): Promise<void>` (idempotent insert).
- `lockAccount(t: Tx, ownerId): Promise<{ tier: string; balanceMicro: bigint }>` (`select … for update`, creating the row first).
- `applyLedger(t: Tx, ownerId, deltaMicro: bigint, reason: 'grant'|'adjust'|'usage', note: string | null, usageId?: string): Promise<bigint>` — the only function that changes `balance_micro`; inserts the ledger row and updates the balance in the caller's transaction; returns the new balance.
- `freeUsedToday(q, ownerId, now: Date, timezone): Promise<bigint>` and `siteDay(now, timezone): string` (`YYYY-MM-DD` in the site timezone).
- `GET /api/usage` → `{ "tier", "agentLimit", "agentCount", "balance": "<points, decimal string>", "free": {"allowance","used","resetsAt"}, "canStartFreeReply": boolean, "recent": [{"agentId","model","source","points","replies"}] }` for the caller only; `recent` aggregates the last 7 site-days.
- CLI: `credits:grant --handle <h> --points <n> [--note <text>]` (n may be negative; prints the new balance), `credits:show --handle <h>`, `tier:set --handle <h> --tier <name>` (refused unless in `AGENT_TIERS`), `models:list` (id, label, tier, protocol, prices; never the key).

- [ ] **Step 1: failing tests.** `accounts.test.ts`: after any sequence of `applyLedger` calls, `sum(delta_micro) = balance_micro` (assert with one SQL); `GET /api/usage` of A never contains B's rows and takes no parameter that could select another user (a `?owner=` query is 400); the usage route cannot change a balance (there is no write route under `/api/usage`, `/api/credits`, `/api/accounts`: each returns 404 for POST/PUT/PATCH/DELETE). `cli-credits.test.ts`: grant to an unknown handle exits non-zero; grant to an Agent's handle is refused; `--points abc` is refused; a grant of 5 then −2 shows 3.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `feat(service): accounts, points ledger and admin commands`.

### Task 3: Agents — create, read, edit, pause, delete; the dedicated conversation

**Files:** Create `src/agents/store.ts`, `src/agents/routes.ts`, `src/agents/conversation.ts`; modify `src/conversations/store.ts`, `src/sync/read.ts`, `src/messages/model.ts`, `src/messages/read.ts`, `src/principals/store.ts` + `routes.ts`, `src/social/friends.ts`, `src/conversations/groups.ts`, `src/app.ts`; test `tests/agents.test.ts`, `tests/agents-visibility.test.ts`, `tests/agents-ratelimit.test.ts`.

**Interfaces — Consumes:** `lockAccount` (Task 2). **Produces:**

- Routes (all owner-only; any other caller, and any unknown id, gets the identical 404):
  - `POST /api/agents {handle, name, intro?, field?, persona?, replyMode?, reasoning?, model?}` → 201 `Agent`. 409 `handle_taken`; 403 `agent_limit` when the owner's non-deleted Agents ≥ the tier's limit (count under the account lock).
  - `GET /api/agents` → `{agents: Agent[]}` (deleted ones included, flagged) · `GET /api/agents/:id` → `Agent`.
  - `PATCH /api/agents/:id {name?, intro?, field?, persona?, replyMode?, reasoning?, model?}` — `handle` and owner are not accepted keys (strict schema ⇒ 400). A persona change increments `persona_version`.
  - `POST /api/agents/:id/pause` · `POST /api/agents/:id/resume` · `DELETE /api/agents/:id` (sets `deleted_at`; idempotent; irreversible).
  - `PUT /api/agents/:id/avatar` (same rules and limits as `PUT /api/me/avatar`; bumps `avatar_version`).
- `createAgent(t, ownerId, input)`: one transaction — principal (kind `agent`, `owner_id`), `agents` row, `conversations` row of type `agent`, `agent_conversations`, two `speaker` memberships at `joined_seq 0`, and, when `persona` is empty, the fixed greeting as a `text` message from the Agent with `body.fixed = true`. Greeting text, exactly: `你好，我是「{name}」，你刚刚创建的 Agent。我现在还没有设定。你希望我是谁、主要帮你做什么、用什么语气说话？直接告诉我就行，说完我会整理成一份设定给你确认。`
- `lockForWrite` and `canSend` understand type `agent`: members are exactly the owner and the Agent; the owner may send unless the Agent is deleted (403 `cannot_send`, reason `agent_deleted`); no friendship is consulted.
- `lockAgent(t, agentId): Promise<AgentRow>` — locks the Agent's conversation row, then the `agents` row (`for update`). Pause, resume, delete and `postAsAgent` all go through it.
- Agents are invisible to everyone but the owner's Agent routes: `GET /api/principals/lookup` and `POST /api/friend-requests` treat an Agent handle as unknown (for the owner too); adding an Agent id to a group is `invalid_request` exactly like a non-friend; an Agent can never be `requirePrincipal`'s subject (it has no auth user — already a schema constraint; add the test).
- `/api/sync` and `GET /api/conversations/:id` return agent conversations in the shape above; a deleted Agent's conversation stays listed with `canSend {ok:false, reason:"agent_deleted"}`.
- Model validation on create/patch: a site model id must exist in `config.siteModels`; a provider must belong to the caller and list that model name; `reasoning` must be allowed by the chosen model (site: its `reasoning` list plus `none`; provider model: `none` only unless flagged `reasoning`). Otherwise 400.
- Per-principal rate limit: 30 Agent writes a minute.

- [ ] **Step 1: failing tests.** `agents.test.ts`: create returns an Agent and `/api/sync` shows one `agent` conversation whose only message is the greeting (none when a persona was given); the 21st create is 403 `agent_limit`, succeeds after a delete, and after `tier:set` to a tier with 25; 8 concurrent creates at count 19 yield exactly one 201; PATCH with `handle` or `ownerId` is 400; persona of 20 001 characters is 400; owner sends a text in the conversation → 201; after delete → 403 `cannot_send`/`agent_deleted`, history still readable. `agents-visibility.test.ts`: for another signed-in user, every `/api/agents/:id…` route and the conversation routes answer byte-identically for the real id and a random uuid; lookup and friend request by the Agent's handle answer as for an unknown handle; adding it to a group is 400; the stranger's `/api/sync` never contains the Agent's id.
- [ ] **Step 2–4:** fail, implement, pass (run the whole suite: `sync`, `conversations`, `enumeration` and `fuzz` must stay green).
- [ ] **Step 5:** commit `feat(service): agents and their dedicated conversations`.

### Task 4: Providers — encrypted keys and the address guard

**Files:** Create `src/providers/crypto.ts`, `guard.ts`, `store.ts`, `routes.ts`; test `tests/providers.test.ts`, `tests/provider-guard.test.ts`, `tests/provider-secrets.test.ts`.

**Interfaces — Produces:**

- `sealKey(plain: string, secret: string): Buffer` / `openKey(cipher: Buffer, secret: string): string` — AES-256-GCM, key derived from `PROVIDER_KEY_SECRET` with HKDF-SHA-256, random 12-byte nonce, layout `version(1) | nonce(12) | tag(16) | ciphertext`.
- `guardedFetch(opts: { resolve?: typeof dns.lookup; maxResponseBytes: number; timeoutMs: number }): typeof fetch` — for each request: scheme must be `https:` (tests may pass `allowInsecureLocal: true`, a build option that production config cannot set); no credentials in the URL; resolve the hostname once, refuse (`AppError 400 address_not_allowed`) if any resolved address is loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16, fe80::/10), CGNAT (100.64/10), unspecified, multicast, or an IPv4-mapped form of those; connect to exactly the checked address with the original hostname as SNI/Host; `redirect: "manual"` and any 3xx is `provider_unavailable`; abort past `timeoutMs` between bytes and past `maxResponseBytes` in total. Use `undici`'s `Agent` with a `connect.lookup` (undici ships with Node; if it must be added as a dependency, it is MIT).
- Routes (owner-only, identical 404 otherwise): `POST /api/providers {name, protocol, baseUrl, apiKey, models?}` → 201 `Provider`; `GET /api/providers`; `PATCH /api/providers/:id {name?, baseUrl?, apiKey?, models?}`; `DELETE /api/providers/:id` → 409 `provider_in_use` with `{agents: [{id, name}]}` while a non-deleted Agent uses it; `POST /api/providers/:id/test` → `{ok: true}` or `{ok: false, error: "provider_rejected" | "provider_unavailable" | "address_not_allowed"}`; `POST /api/providers/:id/models/refresh` → the provider's model names as far as its list endpoint gives them (merged into `models`, existing flags kept). At most 10 providers per user, 100 models per provider, model name ≤ 100 characters, `contextTokens` 1 000–2 000 000.
- `loadProviderForCall(q, ownerId, providerId): Promise<{ protocol, baseUrl, apiKey, models } | null>` — the only reader of plaintext keys outside `crypto.ts`.

- [ ] **Step 1: failing tests.** `provider-guard.test.ts` with an injected resolver: `http://` refused; `https://127.0.0.1`, `https://[::1]`, `https://10.0.0.5`, `https://169.254.169.254`, `https://[::ffff:10.0.0.1]`, and a name resolving to `192.168.1.1` are refused before any connection; **rebinding**: the resolver returns a public address on the first call and `127.0.0.1` on the second — a local listener on 127.0.0.1 records zero connections and the call is refused; a 302 to `https://127.0.0.1/` is not followed; a response of `maxResponseBytes + 1` aborts; a server that stalls aborts at `timeoutMs`. `provider-secrets.test.ts`: create a provider with key `sk-test-SECRET-1234567890`; then exercise every provider route, `/api/sync`, the test route against a stub that echoes the Authorization header in a 401 body, and capture the log stream — the string `SECRET-1234567890` appears nowhere (response bodies, headers, log lines), and `key_cipher` in the table does not contain it; `keyLast4` is `7890`. `providers.test.ts`: another user's provider id is 404 on every route and cannot be set as an Agent's model (400); delete in use is 409 naming the Agent; an 11th provider is 400.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `feat(service): user model providers with sealed keys and a guarded fetch`.

### Task 5: The model gateway (four protocols)

**Files:** Create `src/models/gateway.ts`, `src/models/resolve.ts`, `tests/helpers/models.ts`; modify `src/app.ts` (`Deps.models`); test `tests/gateway-protocols.test.ts`, `tests/gateway-errors.test.ts`.

**Interfaces — Consumes:** `guardedFetch`, `loadProviderForCall`, `config.siteModels`. **Produces:**

```ts
export type ReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type Part =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: Uint8Array }
  | { type: "file"; mime: "application/pdf"; name: string; data: Uint8Array };
export interface ModelCall {
  protocol: "openai_chat" | "openai_responses" | "anthropic" | "gemini";
  baseUrl: string; apiKey: string; model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; parts: Part[] }>;
  reasoning: ReasoningLevel; maxOutputTokens: number; signal: AbortSignal;
}
export type ModelEvent =
  | { type: "text"; delta: string } | { type: "reasoning"; delta: string }
  | { type: "finish"; usage: { inputTokens: number; outputTokens: number } | null; truncated: boolean };
export interface ModelGateway { stream(call: ModelCall): AsyncIterable<ModelEvent>; listModels(p: Pick<ModelCall, "protocol"|"baseUrl"|"apiKey">): Promise<string[]>; }
export class ModelError extends Error { code: "provider_rejected" | "provider_unavailable" | "address_not_allowed"; }
export function resolveModel(q, config, agent: AgentRow): Promise<Resolved | null>;
// Resolved = { source: "site"|"provider"; call: Omit<ModelCall,"system"|"messages"|"signal"|"reasoning">; contextTokens; vision; pdf; reasoningAllowed; price?: {inputMicroPerToken; outputMicroPerToken}; tier?: "free"|"paid" }
```

- The implementation builds the AI SDK provider for the protocol with `baseURL`, the key and `fetch: guardedFetch(...)`, calls `streamText`, and maps its stream parts to `ModelEvent`. Reasoning output tokens count as output. `finish.usage` is `null` when the upstream reported none. `truncated` is true when the model stopped for length.
- Reasoning mapping lives in one exported table `REASONING_PARAMS[protocol][level]` (provider options per the SDK's docs: OpenAI reasoning effort, Anthropic thinking effort/budget, Gemini thinking level/budget); a level the protocol cannot express maps to its nearest lower one; `none` disables thinking where the protocol allows and omits the option otherwise.
- Error mapping: 401/403 → `provider_rejected`; network failure, timeout, 3xx, 404, 429, 5xx, malformed stream → `provider_unavailable`; the guard's refusal → `address_not_allowed`. `ModelError.message` is a fixed sentence per code; the upstream body is dropped.
- `tests/helpers/models.ts`: `scriptedGateway()` — a `ModelGateway` whose next calls are scripted (`reply(text, {reasoning?, usage?, delayMsPerChunk?, truncated?})`, `fail(code)`, `hang()`, `empty()`), recording every `ModelCall` it received; and `protocolStub()` — a local HTTP server that answers each protocol's streaming endpoint with a canned SSE body and records the request path, headers and JSON body.

- [ ] **Step 1: failing tests.** `gateway-protocols.test.ts`, once per protocol against `protocolStub()` (through `guardedFetch` with `allowInsecureLocal`): a streamed answer arrives as `text` deltas whose concatenation equals the canned text, then `finish` with the canned usage; the recorded request went to that protocol's path with the key in that protocol's header; system text, a prior assistant turn, an image part and a PDF part appear in the request body in that protocol's shape; for each of the six levels the request body carries exactly `REASONING_PARAMS[protocol][level]`; a canned reasoning stream arrives as `reasoning` deltas. `gateway-errors.test.ts`: 401 → `provider_rejected`; 500, a closed socket mid-stream, and non-SSE HTML → `provider_unavailable`; an upstream body containing the key never appears in `ModelError.message`; aborting the signal ends the iterator promptly and closes the upstream connection.
- [ ] **Step 2–4:** fail, implement, pass. Record the licence of each added package in the commit message.
- [ ] **Step 5:** commit `feat(service): model gateway over four protocols`.

### Task 6: Metering — admission and settlement

**Files:** Create `src/metering/prices.ts`, `admit.ts`, `settle.ts`; test `tests/metering.test.ts`, `tests/metering-concurrency.test.ts`.

**Interfaces — Consumes:** `lockAccount`, `applyLedger`, `freeUsedToday`, `Resolved`. **Produces:**

- `estimateTokens(text: string): number` = number of Unicode code points (deliberately high for Latin text); `IMAGE_TOKENS = 1500`; `PDF_TOKENS_PER_KB = 300`.
- `maxCostMicro(resolved, inputTokensEstimate): bigint` = `input × inputMicroPerToken + maxOutputTokens × outputMicroPerToken`.
- `admit(t, ownerId, resolved, inputTokensEstimate, now): Promise<{ chargeTo: 'free' | 'balance' | null; holdMicro: bigint }>` — under the account lock. Provider source: `{chargeTo: null, holdMicro: 0n}`. Site source: let `holdsFree` / `holdsBalance` be the sums of `hold_micro` over the owner's `running` runs by `charge_to`. Free-tier model: if `freeDailyMicro − freeUsedToday − holdsFree > 0` → `free`; else if `balance − holdsBalance > 0` → `balance`; else throw `AppError(402, "no_quota", {reason: "free_and_balance", resetsAt})`. Paid-tier model: `balance − holdsBalance > 0` → `balance`, else `no_quota` with reason `balance`. The caller stores `charge_to` and `hold_micro` on the run in the same transaction.
- `settle(t, run, usage: {inputTokens, outputTokens} | null, fallback: {inputChars, outputChars}, outcome): Promise<void>` — under the account lock: cost from real usage, or from `estimateTokens` with `estimated = true`; `free`: add `min(cost, remaining)` to `free_usage`, the rest is `forgiven_micro` (never the balance, never tomorrow); `balance`: `applyLedger(−cost, 'usage')`, which may go negative; provider source: cost 0. Inserts the `usage_records` row and zeroes the run's `hold_micro`. A failed call with no output costs 0 but still writes a record.
- HTTP status 402 is new: add it where `AppError` statuses are enumerated.

- [ ] **Step 1: failing tests.** `metering.test.ts`: free model inside the allowance → all `free_micro`; the reply that crosses the allowance → `forgiven_micro > 0`, balance unchanged, tomorrow's `freeUsedToday` is 0 (advance `now` past the site-day boundary; also assert the boundary follows `SITE_TIMEZONE`, not UTC); allowance exhausted + balance 5 points → `balance`; + balance 0 → 402 `no_quota` with `resetsAt`; paid model with balance 0 → 402 even with free allowance left; paid model crossing zero → balance negative, next admit refused, a grant that brings it positive admits again; provider source → cost 0, balance and `free_usage` untouched, record written; missing usage → `estimated = true`. `metering-concurrency.test.ts` (real Postgres, 20 parallel transactions, holds released only by `settle`): starting from allowance = 1.5 × one reply's max cost and balance 0, at most 2 are admitted and total `forgiven_micro` ≤ one max cost; starting from balance = 0.5 × max cost on a paid model, exactly 1 is admitted and the final balance ≥ −(one max cost); after all settle, `sum(delta_micro) = balance_micro` and no run has `hold_micro > 0`.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `feat(service): admission and settlement of site-model usage`.

### Task 7: Replies — trigger, AgentPort, worker, streaming

**Files:** Create `src/agents/runtime/port.ts`, `worker.ts`, `stream.ts`, `prompt.ts`; modify `src/agents/conversation.ts` (`postAsAgent`), `src/messages/routes.ts` (trigger), `src/sync/hub.ts` (run and delta pushes), `src/app.ts` (start/stop the worker with the app; `BuildOptions.agentWorker?: false` lets a test drive it by hand); test `tests/runs.test.ts`, `tests/runs-pause-race.test.ts`, `tests/agent-port-boundary.test.ts`.

**Interfaces — Consumes:** Tasks 3, 5, 6. **Produces:**

- `maybeTrigger(t, lock: WriteLock, message: StoredMessage): Promise<void>` — called by the send route in the send transaction, after the message is stored and only for a non-duplicate message from the owner in an `agent` conversation. No-op when the Agent is paused, deleted, has no model, or `replyMode = 'mention'` and the text contains neither `@{handle}` nor `@{current name}`. Otherwise: if the Agent has an active run, set its `pending_seq = message.seq`; else insert a `queued` run with `covers_seq = message.seq`. Subject to `agentRunsPerMinute` per owner (over it: no run, and the send still succeeds).
- `AgentPort` (the worker's whole view of the system):
  ```ts
  interface AgentPort {
    claimNext(): Promise<RunTicket | null>;                       // queued → running, oldest first, respecting agentMaxConcurrentRuns per owner
    begin(run: RunTicket): Promise<Prepared | RunEnd>;            // resolves the model, builds context, admits (Task 6); marks the Agent's read marker
    emit(run: RunTicket, delta: { text?: string; reasoning?: string }): void;   // push to the owner's sockets; nothing stored
    post(run: RunTicket, out: { text: string; reasoning: string; stopped: boolean; truncated: boolean }): Promise<"posted" | "refused">;
    finish(run: RunTicket, end: RunEnd, usage, fallback): Promise<void>;        // settle + status + follow-up run when pending_seq > covers_seq
    shouldStop(run: RunTicket): boolean;                          // stop requested, paused or deleted (in-memory flag set by routes after commit)
  }
  ```
- `postAsAgent(t, agentId, conversationId, runId, body)` — `lockAgent`, then refuse (`agent_paused` / `agent_deleted`) or `insertMessage` with `client_txn = runId` (so a retried post cannot duplicate). Text is passed through the existing message rules; over 8000 characters it is cut at 8000 with `truncated: true`. Empty text with no reasoning is not posted: the run ends `failed` / `provider_unavailable`.
- Worker loop: `claimNext` → `begin` → iterate the gateway with an `AbortController` (aborted on `shouldStop`, on `agentRunTimeoutMs`, and on app close) → `post` → `finish`. Deltas are coalesced to at most one push per 50 ms. It wakes on an in-process signal from `maybeTrigger`'s post-commit hook and also polls every 2 s.
- Routes: `POST /api/conversations/:id/runs/:runId/stop` (owner; sets the flag; idempotent) · `POST /api/conversations/:id/runs/retry` (owner; only when the last run is `failed`; creates a `queued` run covering the conversation's last owner seq; 409 `busy_run` when one is active) · `POST /api/conversations/:id/runs/dismiss` · `GET /api/conversations/:id/run` → `{run: Run | null}` (the latest run, so a reloaded page can show "replying" or the failure).
- Outcomes: stop with non-empty text → message with `stopped: true`, run `stopped`; pause/delete mid-run → nothing posted, run `cancelled`; `ModelError` or `no_quota` → run `failed` with that code (`retryable` false for `provider_rejected` and `address_not_allowed`).
- Context in this task is the plain one: every message visible to the Agent, text only, owner → `user`, Agent → `assistant`, no budget. Task 8 replaces it with `buildContext`.
- `prompt.ts`: `systemPrompt(agent, owner, now, mode: 'normal'|'onboarding')` — the fixed preamble (whose Agent it is, the owner's display name, the date in the site timezone, that it has no tools, no file access beyond what is shown and must not claim actions it cannot perform) followed by the persona; `onboarding` when the persona is empty (Task 10 supplies its text).

- [ ] **Step 1: failing tests.** `runs.test.ts` (scripted gateway, worker driven by hand): an owner message produces a `run` push `queued`→`running`, `delta` pushes whose concatenation equals the reply, one `message` push from the Agent, `run` `done`; history after reload shows exactly one Agent message; a second socket of the owner gets the same; **coalescing**: three owner messages while the first reply hangs → the gateway is called exactly twice in total and the second call's messages contain all three; `replyMode: mention` ignores plain text and answers `@handle` and `@name`; no model configured → no run; stop mid-stream → Agent message with `stopped: true` holding the text so far, usage record `stopped`; gateway `fail("provider_rejected")` → no Agent message, `GET …/run` shows `failed` / not retryable; `empty()` → `failed`; a 9000-character reply is stored as 8000 with `truncated: true`; retry after a failure posts a reply; retry while one is active → 409. `runs-pause-race.test.ts`: 50 rounds — start a reply with a gateway that finishes after a random 0–20 ms, pause at a random moment; assert in every round: no Agent message has `created_at` later than the pause's commit, and the run is `done` (posted before the pause) or `cancelled`; the same with delete. `agent-port-boundary.test.ts`: static check of imports under `src/agents/runtime/` (see Global Constraints).
- [ ] **Step 2–4:** fail, implement, pass; the full suite stays green (`fuzz` must cover the new routes).
- [ ] **Step 5:** commit `feat(service): agent replies through a run queue and a narrow port`.

### Task 8: What the model is shown — context, attachments, topics, reasoning

**Files:** Create `src/agents/runtime/context.ts`; modify `src/agents/routes.ts` (topic reset), `src/conversations/system.ts` + `src/messages/model.ts` (`topic_reset`), `src/messages/read.ts` (`reasoning` on the wire, excluded from search and previews); test `tests/context.test.ts`, `tests/topic-reset.test.ts`.

**Interfaces — Produces:**

- `buildContext(q, blobs, run, resolved): Promise<{ messages: ModelCall["messages"]; inputTokensEstimate: number; inputChars: number }>`:
  - Source: messages visible to the Agent (the one visibility rule, reader = the Agent) with `seq ≤ run.covers_seq` — plus later owner messages up to the conversation's current seq — after the latest `topic_reset`; system notices and `body.fixed` greetings are skipped; owner → `user`, Agent → `assistant`; a quoted message is prefixed as `> {first 200 characters}`; stored `reasoning` is never sent.
  - Attachments (reader = the Agent, through the same lookup downloads use): image and `resolved.vision` and ≤ 5 MB → image part, at most 10 images per call (newest win), else the text `[图片：{name}]`; text-like content (sniffed as UTF-8 text, not by extension) → `[文件：{name}]` followed by its text, at most 100 000 characters per file and 200 000 per call, cut with `…（已截断）`; PDF and `resolved.pdf` and ≤ 10 MB → file part, else `[文件：{name}]`; anything else `[文件：{name}]`.
  - Budget: `resolved.contextTokens − maxOutputTokens − estimate(system)`. Keep the newest turns; when over budget drop, oldest first, attachment contents (leaving the name), then whole turns. The newest owner message is never dropped; if it alone exceeds the budget its text is cut from the front.
- `POST /api/conversations/:id/topic` (owner, `agent` conversations only) → writes the `topic_reset` notice (Chinese sentence: `{owner} 开始了新话题，之前的对话不再发给 {agent}`).
- `reasoning` passes to the gateway only when allowed by the resolved model; otherwise `none`.

- [ ] **Step 1: failing tests.** `context.test.ts` (inspect the scripted gateway's recorded call): roles and order are right; after a topic reset nothing older is sent, yet history and search still return it; a vision model receives the image bytes, a non-vision model the name only; a `.txt` upload's content is included and a 150 000-character one is cut at 100 000 with the marker; a binary file renamed `.txt` is name-only; PDF follows `resolved.pdf`; with a 2 000-token context the oldest turns are gone and the newest owner message is present; stored reasoning of an earlier reply is absent from the next call; the Agent's reply stores `reasoning`, `GET messages` returns it, global search for a word that occurs only in the reasoning finds nothing. `topic-reset.test.ts`: a stranger and the owner of another Agent get 404; in a direct chat it is 404.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `feat(service): model context with attachments, topics and reasoning`.

### Task 9: Failure, restart and limits

**Files:** Modify `src/agents/runtime/worker.ts`, `port.ts`, `src/app.ts`; test `tests/runs-restart.test.ts`, `tests/runs-faults.test.ts`, `tests/runs-ratelimit.test.ts`.

**Interfaces — Produces:**

- `recoverRuns(db): Promise<number>` — run once when the app starts, before the worker: every `running` run becomes `failed` with error `provider_unavailable`, `retryable: true`, its hold is released by a zero-cost `settle` (a usage record with outcome `failed`, `estimated = true`, cost 0), and no model call is made. `queued` runs stay queued. If the Agent's message for that run id already exists (the crash fell between post and finish), the run becomes `done` instead.
- Limits enforced: `agentMaxConcurrentRuns` per owner (extra runs wait `queued`), `agentRunsPerMinute`, `agentRunTimeoutMs` (a timed-out reply with text is posted as `truncated`, without text fails as `provider_unavailable`).

- [ ] **Step 1: failing tests.** `runs-restart.test.ts`: with a hanging gateway, close the app mid-run and build a new one on the same database: the gateway of the new app is never called for that run, `GET …/run` shows `failed` and retryable, `sum(hold_micro) = 0`, no Agent message exists, retry then works; the post-then-crash case ends `done` with exactly one message. `runs-faults.test.ts`, each asserting "service alive, run in a terminal state, owner sees the matching error, holds zero, one usage record": slow stream, stream cut mid-way (text so far is discarded and nothing posted), upstream error, empty, 50 000-character reply, no usage reported. `runs-ratelimit.test.ts`: the 21st trigger within a minute creates no run while the message itself is stored; a third simultaneous run stays `queued` until one finishes.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `fix(service): agent runs survive faults and restarts`.

### Task 10: Persona — drafting, onboarding and proposals

**Files:** Create `src/agents/persona.ts`; modify `src/agents/routes.ts`, `src/agents/runtime/prompt.ts`, `stream.ts`, `src/messages/read.ts`; test `tests/persona.test.ts`, `tests/persona-authority.test.ts`.

**Interfaces — Produces:**

- `POST /api/agents/draft-persona {name, intro?, field?, model}` → `{persona}` — one metered model call, recorded as an `agent_runs` row of purpose `draft` (no Agent, no conversation) that is admitted, held and settled exactly like a reply with a fixed instruction to write a persona document in Chinese from those fields; the result is returned, not saved. 5 a minute per user.
- Onboarding prompt (persona empty): the Agent interviews the owner (who it should be, what it helps with, tone), a question or two at a time, and when it has enough writes the proposal block. Normal prompt: appended rule that when the owner asks it to update its persona it writes the same block.
- The block: `<af-persona>…</af-persona>`, optionally preceded by `<af-intro>…</af-intro>` and `<af-field>…</af-field>`. `stream.ts` holds back output from the first `<af-` so tags never reach `delta` pushes; at post time the block is removed from the text, validated (persona 1–20 000 characters, intro ≤ 40, field ≤ 20; anything else in it is ignored) and stored as a `persona_proposals` row tied to the message with `base_persona_version`; earlier `open` proposals of that Agent become `superseded`. A malformed block is left in the text as written and creates nothing.
- `POST /api/agents/:id/proposals/:proposalId/confirm {persona?, intro?, field?}` (owner; the body lets the owner edit before confirming) → `Agent`; 409 `stale_proposal` when `agents.persona_version ≠ base_persona_version` or the proposal is not `open` (on a version mismatch the proposal becomes `stale`). `POST …/discard`.
- The wire `proposal` object is added by `toWireFor` only when the reader is the Agent's owner.

- [ ] **Step 1: failing tests.** `persona.test.ts`: a scripted reply containing the block is stored without it, the message carries `proposal.status = "open"` with the persona, and no `delta` push contained `<af-`; confirm sets the persona, bumps the version, and the next gateway call's system text contains the new persona; discard leaves it; a second proposal supersedes the first; editing the persona by PATCH and then confirming is 409 `stale_proposal` and the manual text stays; a block with a 20 001-character persona creates no proposal; draft returns text and writes one usage record with purpose `draft`. `persona-authority.test.ts`: a stranger and another Agent's owner get the identical 404 on confirm and discard; a random proposal id is 404; confirm with extra keys (`model`, `paused`, `handle`, `ownerId`) is 400; a scripted reply containing the literal text "已确认" or a forged JSON of the confirm request changes nothing in `agents`; an owner message containing `<af-persona>` creates no proposal (only Agent output is parsed).
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `feat(service): persona drafting and owner-confirmed proposals`.

### Task 11: Avatar changes reach other people (spec 6.11 item 1, service half)

**Files:** Modify `src/principals/store.ts`, `routes.ts`, `src/sync/read.ts`, `src/sync/hub.ts`, `src/messages/principals.ts`; test extend `tests/principals.test.ts`, `tests/sync.test.ts`.

**Interfaces — Produces:** `swapAvatarKey` increments `avatar_version`; every Principal on the wire carries `avatarVersion`; after an avatar upload commits, `{"type":"principal","id","avatarVersion"}` is pushed to the uploader and to everyone who currently shares a conversation with them or is their friend (for an Agent: its owner). The avatar route keeps ignoring `?v=`.

- [ ] **Step 1: failing tests.** B and A are friends with sockets open: A uploads an avatar → B receives the push with version 1, B's next `/api/sync` lists A with `avatarVersion: 1`; C, who shares nothing with A, receives nothing; an Agent's avatar upload pushes to its owner only.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5:** commit `fix(service): avatar changes are announced with a version`.

### Task 12: Documentation and whole-suite hardening

**Files:** Modify `app/service/README.md`, `tests/readme.test.ts`, `tests/fuzz.test.ts`, `tests/enumeration.test.ts`, `tests/logging.test.ts`, `app/deploy/README.md` (new variables; the note that `PROVIDER_KEY_SECRET` must be backed up with the database).

- [ ] **Step 1:** README: every new route with request, response and errors; the wire additions above; a section "Agents and runs" (trigger, coalescing, the port boundary, outcomes, restart rule) and "Metering" (admission, settlement, forgiveness, debt bound, units); the configuration table; the two kept exceptions for Agent ids (avatar and block routes) stated next to the existing ones.
- [ ] **Step 2:** extend the suites so they fail first where coverage is missing: `fuzz` walks every new route with malformed input and expects 4xx only; `enumeration` asserts identical answers for foreign and random ids across Agent, provider, run and proposal routes; `logging` asserts no persona text, message text or key appears in info-level logs during a reply; `readme` (the test that checks documented routes against `routeList`) passes.
- [ ] **Step 3:** run the whole suite and `npm run typecheck`; expected: all green, no skipped tests.
- [ ] **Step 4:** commit `docs(service): agents, providers, metering; suites cover the new routes`.

---

## Spec coverage (acceptance item → task)

1 → 3, 7, 10 · 2 → 4, 5, 7 · 3 → 6 · 3a → 5 · 3b → 8 · 3d → 3 · 4 → 7 · 5 → 7 · 6 → 8 · 7 → 10 · 10 (avatar) → 11 · 11 → 3, 12 · 12 → 1, 3 · 13 → 7 · 14 → 10 · 15 → 4, 12 · 16 → 4 · 17 → 6 · 18 → 2 · 19 → 9 · 20 → 9 · 21 → 12. Plan B: 3c, 8, 9, 10 (web), 22, 23, 24.
