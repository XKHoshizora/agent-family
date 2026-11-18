# Limits (others' daily budget, split rate limits, concurrency) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** What other people make an owner's Agent do is counted, rate-limited, run and budgeted apart from what the owner does themself.

**Architecture:** Every run records who was behind it (`caller_id`) and a lane (`own` | `others` | `proactive`). The per-minute limit, the worker's claim and a new per-Agent daily budget all read the lane. No new tables; one migration adds columns. The site-wide cap is the worker's existing in-flight limit (one service instance), raised to 16.

**Tech Stack:** Fastify 5, Postgres, TypeScript, vitest (`app/service`); React, vitest (`app/web`).

**Spec:** `docs/design/2026-11-18-limits-design.md` (rules 1–10). Rule numbers below refer to it.

## Global Constraints

- Tests first; each task's new tests are seen failing before the code. Focused runs only while working: `npx vitest run tests/<file>` from `app/service` (ONE shared test database: never two service test runs at once). `npm run typecheck` before each commit.
- Commits: explicit path list on the command (never `git add -A`), message ends with the environment's Co-Authored-By line. Do not push.
- Install nothing; no new dependency. Never read `.env` files, `.local/`, or key files under `E:\Agent-Family\`.
- Numbers are site configuration with these defaults, copied from the spec: own lane 20 starts/minute per owner; others' lane 20 starts/minute per owner; one caller 5 starts/minute on other people's Agents; per owner at most 4 running of which at most 3 not `own`; site-wide 16 running; others' daily budget default 20 points, `null` = unlimited.
- "Charged" means `usage_records.free_micro + balance_micro` (as `chargedSince`, `GET /api/usage`, `via`).
- The site day is `siteDayStart(now, config.siteTimezone, 0)` (`src/accounts/store.ts`).
- Nothing about lanes, callers or budgets reaches anyone but the Agent's owner, except the group notice of Task 4.
- Chinese copy, verbatim: notice `「{name}」今天的额度已用完`; form label `别人 @ 每天最多花`; options `20 点（默认）` / `自己填` / `不限`; unlimited warning `群里任何人都能让它回复，花的是你的点。`; owner line `今天别人 @ 已花 {spent} / {budget} 点` and, when reached, `今天别人 @ 的额度已用完，调高后立即恢复。`.

## Rulings made while planning (each: what — why — cost if wrong)

- **Per owner "1 + 3" is implemented as "4 running in all, at most 3 of them not `own`"** — a literal single reserved slot would cut an owner's own concurrency from today's 2 to 1 — a config change if the owner should be held to fewer.
- **The site-wide cap is `AGENT_MAX_RUNS_IN_FLIGHT` (default 8 → 16), not a database count** — there is one service instance (documented limit); a database cap would be dead code today — add the count to `claimNext` when a second instance exists.
- **A caller over their 5 a minute gets no run and no notice; the mention is only logged** — the spec says "不触发回复"; a notice per refused mention would itself be spam — add a once-a-minute notice if testers find it confusing.
- **The owner's "one reminder" is the Agent's own state, not a message:** the owner's view of the Agent carries today's spend and the page shows it; an `agent` push tells open pages — appending to the owner's conversation with the Agent from a group's transaction takes a second conversation's row lock out of order — add a real notification when the notifications batch lands.
- **The budget counts settled charges plus the holds of that Agent's running non-own runs** — tighter than settled only, with three running at once — remove the holds term if it refuses too early.
- **A run a caller's and the owner's messages both asked for is `own`** (as a person's message makes a folded run a person's) — the owner asked; it should not spend the others' budget.

## Review Focus

- A mention folded into a queued `others` run by the owner turns it `own`; folded by a second other person it stays `others` and its `caller_id` stays the first caller's.
- An Agent's follow-up after a reply (`followUp`) takes the lane and caller from the messages it answers, not from the finished run.
- The budget is read under the Agent's row lock where one is held (`triggerInGroup`), and without it where it is not (`triggerFromAgent`, by design reads, not locks): two callers at the last point may both pass; the overshoot is bounded by the concurrency cap. Test that the second is refused once the first's hold exists.
- Changing the budget (PATCH) while it is spent restores calls at once; setting it below today's spend refuses at once.
- A run recorded before this change (no `caller_id`) is `own` and counts toward nothing new.

---

### Task 1: Every run records its caller and lane

**Files:**
- Create: `app/service/migrations/019_run_callers.sql`
- Modify: `app/service/src/agents/runs.ts` (`queueRun`, `recordRateLimited`, `rateLimitedInGroup`, `reachAgents`, `triggerInGroup`, `triggerFromAgent`, `followUp`, `maybeTrigger`, `retryRun`, `retryInGroup`), `app/service/src/agents/persona.ts` (draft runs: `own`, caller the owner)
- Test: `app/service/tests/agents-run-lanes.test.ts` (new; helpers copied in the style of `agents-group-trigger.test.ts`), `app/service/tests/schema-agents.test.ts`

**Interfaces:**
- Produces: columns `agent_runs.caller_id uuid null references principals(id) on delete set null`, `agent_runs.lane text not null default 'own' check (lane in ('own','others','proactive'))`; index `agent_runs_caller_created_idx (caller_id, created_at) where purpose = 'reply' and lane <> 'own'`; index `agent_runs_owner_lane_created_idx (owner_id, lane, created_at) where purpose = 'reply'`.
- Produces: `type Lane = "own" | "others" | "proactive"`; `type Caller = { id: string; lane: Lane }`; `callerOf(ownerId: string, personId: string): Caller` (`own` when equal, else `others`), exported from `runs.ts`. `reachAgents(t, conversationId, agents, seq, triggeredBy, caller: (agent: RunAgent) => Caller, config)`.

- [ ] **Step 1: failing tests.** In `agents-run-lanes.test.ts`, with a helper `laneOf(agentId, conv)` returning `[lane, caller_id]` per run in creation order:
  - `"the owner's mention is own, another member's is others, with who called"`: owner `@anna` → `[["own", owner.id]]`; settle; member `@anna` → second row `["others", member.id]`.
  - `"an Agent's mention carries its owner as the caller"`: member's Agent names owner's Agent → `["others", member.id]`; owner's Agent names the owner's other Agent → `["own", owner.id]`.
  - `"its own conversation is own"`: a message in the Agent's conversation → `["own", owner.id]`.
  - `"folding: the owner's mention makes a queued others run own; another member's leaves it others with the first caller"`.
  - `"a follow-up takes its lane from what it answers"`: running `others` run, owner mentions meanwhile → follow-up `own`; only the member mentions → `others`, caller the member.
  - `"a rate-limited record carries them too"`.
  - `schema-agents.test.ts`: `lane` rejects `'x'`; default is `'own'`.
- [ ] **Step 2:** run both files; expect failures on the missing columns.
- [ ] **Step 3:** write the migration; thread `Caller` through the functions above. In a group a person's message: `callerOf(agent.ownerId, message.senderId)`; an Agent's message: `callerOf(agent.ownerId, poster.ownerId)`. The fold `UPDATE` sets `lane = 'own', caller_id = owner` when the new caller is `own`, else leaves both. `followUp` in a group: `own` if the owner wrote one of the calling person-messages in `(covers, pending]` or an Agent of the owner did; else `others` with the earliest caller.
- [ ] **Step 4:** run both files and `tests/agents-group-trigger.test.ts`; all pass. `npm run typecheck`.
- [ ] **Step 5:** commit `feat(service): a run records who called it and its lane`.

### Task 2: The per-minute limits read the lane; one caller's limit

**Files:**
- Modify: `app/service/src/config.ts` (`AGENT_OTHERS_RUNS_PER_MINUTE: wholeNumber(20, 1, 10_000)` → `agentOthersRunsPerMinute`; `AGENT_CALLER_RUNS_PER_MINUTE: wholeNumber(5, 1, 10_000)` → `agentCallerRunsPerMinute`), `app/service/src/agents/runs.ts`
- Test: `app/service/tests/agents-run-lanes.test.ts`, `app/service/tests/config.test.ts`

**Interfaces:**
- Consumes: `Caller`, `lane` (Task 1).
- Produces: `startedLastMinute(t, ownerId: string, own: boolean): Promise<number>` (counts `lane = 'own'` or `lane <> 'own'`); `calledLastMinute(t, callerId: string): Promise<number>` (rows with `caller_id = $1 and lane <> 'own' and purpose = 'reply' and created_at > now() - interval '1 minute' and error is distinct from 'rate_limited'`). `Config` picks widen to `"agentRunsPerMinute" | "agentOthersRunsPerMinute" | "agentCallerRunsPerMinute"`.

- [ ] **Step 1: failing tests** (set the three limits small through `useApp` env: own 2, others 2, caller 1):
  - `"others' calls do not use up the owner's own minute"`: member and third call `@anna` to the others' limit (third run is `failed` `rate_limited`); the owner's `@anna` in the same minute is `queued`; and in the Agent's own conversation too.
  - `"the owner's own calls do not use up the others'"`: the mirror.
  - `"one caller's second call in a minute starts nothing, records nothing; another caller's does"`: member `@anna`, settle, member `@tess_of_third`... assert `runsOf` for the second Agent is `[]` and no notice; third's call to `anna` is `queued`.
  - `"a caller's limit does not count calls to their own Agents"`.
  - `"a call folded into a run under way does not count"`.
  - `config.test.ts`: both variables default and reject 0.
- [ ] **Step 2:** run; expect failures.
- [ ] **Step 3:** implement. Order in `reachAgents` for an unfolded Agent: caller's limit first (not `own` only; over it: skip, `log.info({ metric: "caller_rate_limited", ... })` — pass a logger or return the count to the caller, whichever the surrounding code already does for logging), then the owner's lane limit (`rateLimitedInGroup` as today). `maybeTrigger`, `followUp`, `retryRun`, `retryInGroup`: lane limit of the run's lane (retries by the owner are `own`).
- [ ] **Step 4:** run the two files plus `tests/agents-group-trigger.test.ts` and `tests/agents-runs.test.ts` (or whichever file covers `rate_limited` today — find with `grep -l rate_limited tests`); all pass; typecheck.
- [ ] **Step 5:** commit `feat(service): separate per-minute limits for an owner's own replies and those others call for; a limit per caller`.

### Task 3: Concurrency by lane; 16 in flight

**Files:**
- Modify: `app/service/src/config.ts` (`AGENT_MAX_CONCURRENT_RUNS` default 2 → 4; new `AGENT_MAX_CONCURRENT_OTHERS_RUNS: wholeNumber(3, 1, 100)` → `agentMaxConcurrentOthersRuns`; `AGENT_MAX_RUNS_IN_FLIGHT` default 8 → 16; refuse at load `others > total`), `app/service/src/agents/port-impl.ts` (`claimNext`)
- Test: `app/service/tests/agents-claim.test.ts` (new, or the existing file that tests `claimNext` — find with `grep -l claimNext tests`), `app/service/tests/config.test.ts`

**Interfaces:**
- Consumes: `lane` (Task 1).
- Produces: `claimNext` claims the oldest queued reply `q` for which `running(q.owner_id) < total` and (`q.lane = 'own'` or `running(q.owner_id, lane <> 'own') < others`).

- [ ] **Step 1: failing tests** (env: total 3, others 2):
  - `"others' replies leave room for the owner's"`: two `others` runs running, a third `others` queued (older) and an `own` queued (newer) for the same owner → `claimNext()` returns the `own` one; the third `others` stays queued; after one `others` ends it is claimed.
  - `"the owner's own replies may use every place"`: three `own` running → nothing claimed for that owner; another owner's queued run is claimed.
  - `"a draft counts as the owner's own"`.
  - `config.test.ts`: defaults 4 / 3 / 16; `others` above `total` refuses to start naming both variables.
- [ ] **Step 2:** run; expect failures.
- [ ] **Step 3:** implement the two sub-counts in the claim's `where`; log `{ metric: "run_wait_ms", lane, ms }` (started − created) for each claim.
- [ ] **Step 4:** run those files and `tests/agents-worker*.test.ts`; all pass; typecheck.
- [ ] **Step 5:** commit `feat(service): an owner's running replies: four in all, three at most called by others; sixteen in flight`.

### Task 4: Others' daily budget

**Files:**
- Create: `app/service/migrations/020_others_budget.sql` (`agents.others_budget_micro bigint null default 20000000 check (others_budget_micro is null or others_budget_micro between 1000000 and 100000000000)`)
- Modify: `app/service/src/agents/store.ts` (`AgentRow.othersBudgetMicro: bigint | null`, `AgentPatch`, `updateAgent`), `app/service/src/agents/routes.ts` (PATCH + create schema field `othersBudget`: the `chainBudget` schema or `null`; wire `othersBudget: string | null`, `othersSpentToday: string`), `app/service/src/agents/runs.ts`, `app/service/src/messages/model.ts` (`SystemEvent` `agent_daily_budget_reached { actorId, agentId }`), `app/service/src/conversations/system.ts` (`renderNotice`)
- Test: `app/service/tests/agents-others-budget.test.ts` (new), `app/service/tests/agents-routes.test.ts` (or the file testing PATCH), the co-member sweep test that lists hidden keys (add `othersBudget`, `othersSpentToday`)

**Interfaces:**
- Consumes: `lane`, `Caller` (Task 1); `siteDayStart`.
- Produces: `othersSpentToday(t, agentId: string, dayStart: Date): Promise<bigint>` = sum of `free_micro + balance_micro` of `usage_records` whose run has `agent_id = $1 and lane = 'others'` and `usage_records.created_at >= $2`, plus `hold_micro` of that Agent's `running` runs with `lane = 'others'`. `othersBudgetSpent(t, conversationId, agent: Pick<AgentRow,"id"|"othersBudgetMicro">, dayStart): Promise<{ spent: boolean; notice: StoredMessage | null }>`: when spent, appends `agent_daily_budget_reached` unless one about this Agent exists in this conversation with `created_at >= dayStart`.

- [ ] **Step 1: failing tests** (a helper `paidOthers(agent, conv, micro)` inserts a `done` `others` run with a usage record of that charge, as `paid` does in `agents-group-trigger.test.ts`):
  - `"under the budget another member's call is queued; at it, no run and one notice a day in the group"`: budget `"2"`, `paidOthers` 2 points → member `@anna`: `runsOf` unchanged, `noticesOf` holds one `agent_daily_budget_reached` with `agentId`; third `@anna`: still one notice; in a second group: its own one notice.
  - `"the owner's own call is answered all the same, and does not count"`.
  - `"an Agent of someone else is refused the same way"` (through `agentSays`).
  - `"a follow-up others asked for is not queued once it is spent"`.
  - `"a running reply's hold counts"`: budget 2, a running `others` run holding 2 points → the next call refused.
  - `"yesterday's spend does not count"`: usage record with `created_at` before `siteDayStart`.
  - `"raising it restores calls at once; null is unlimited; lowering it below today's spend refuses"` (PATCH `othersBudget`).
  - Routes: PATCH accepts `"1"`..`"100000"` and `null`, refuses `"0"`, `"0.5"`, `"abc"`; the owner's view has `othersBudget` and `othersSpentToday`; a co-member's view of the Agent has neither key.
  - Notice text: `「安娜」今天的额度已用完`.
- [ ] **Step 2:** run; expect failures.
- [ ] **Step 3:** implement. Where: `triggerInGroup` (per called Agent with a non-own caller, after the skips, before `reachAgents`; under the Agent's lock), `triggerFromAgent` (after the chain budget check, same shape as `chainBudgetSpent`), `followUp` (a non-own follow-up). The notice is returned to the caller for publishing the way `agent_budget_reached` is. After a refusal, push the owner's Agent view (`pushAgentChanged`) once per notice appended.
- [ ] **Step 4:** run the new file, the routes file, the sweep, `tests/agents-group-trigger.test.ts`; all pass; typecheck.
- [ ] **Step 5:** commit `feat(service): a daily budget for what others' calls spend of an Agent's owner`.

### Task 5: Web — the setting, the notice, the owner's line

**Files:**
- Modify: `app/web/src/pages/AgentForm.jsx`, `app/web/src/pages/Agents.jsx`, `app/web/src/data/viewmodel.js` (`agentView`, `noticeText`), `app/web/src/data/actions.js` / `app/web/src/api/routes.js` only if the patch body is whitelisted there
- Test: `app/web/tests/agents-pages.test.jsx`, `app/web/tests/viewmodel.test.js`

**Interfaces:**
- Consumes: wire `othersBudget: string | null`, `othersSpentToday: string`; notice event `agent_daily_budget_reached { agentId }`.

- [ ] **Step 1: failing tests:**
  - Form: with `群里谁能 @ 它` = 群成员 the field `别人 @ 每天最多花` shows, with options `20 点（默认）` / `自己填` / `不限`; with 仅主人 it is absent and nothing about it is sent. `自己填` shows a number input validated as the chain budget's (1–100000, up to 6 decimals). `不限` shows the warning text and sends `othersBudget: null`. Editing sends the field only when changed. An Agent whose budget is `"20"` opens on the default option; `"35"` on `自己填` with 35; `null` on `不限`.
  - Detail page: `今天别人 @ 已花 3.5 / 20 点`; with spend ≥ budget the reached line; with `null` budget `今天别人 @ 已花 3.5 点（不限）`.
  - `noticeText` for `agent_daily_budget_reached` → `「{name}」今天的额度已用完`; an unknown agent id falls back as the other agent notices do.
- [ ] **Step 2:** `npx vitest run tests/agents-pages.test.jsx tests/viewmodel.test.js` from `app/web`; expect failures.
- [ ] **Step 3:** implement, following the `chainBudget` field's code in each file.
- [ ] **Step 4:** the two files pass; `npm test` and `npm run build` in `app/web`.
- [ ] **Step 5:** commit `feat(web): the others' daily budget on the Agent form, its notice, and today's spend on the Agent's page`.

### Task 6: Refusals upstream are logged; documentation; whole suites

**Files:**
- Modify: `app/service/src/agents/runtime/worker.ts` (or where a `ModelError` ends a run: log `{ metric: "upstream_refused", status }` for upstream 429 and 5xx), `app/service/README.md` (Configuration table; "In a group"; "Replies started"; Agent wire shape; notices table), `app/deploy/README.md` (variables), `app/service/.env.example` if the new variables are listed there by name
- Test: `app/service/tests/readme.test.ts` (runs as is), one test where the worker's existing failure tests live: `"an upstream refusal is logged as a metric"`

- [ ] **Step 1:** the failing log test; run it.
- [ ] **Step 2:** implement the log line; write the documentation (what each lane is, the three limits, the concurrency rule, the budget and its notice, the three `metric` log lines and how to read them).
- [ ] **Step 3:** once, with nothing else running: `npm run typecheck` and `npm test` in `app/service` (about 20 minutes); `npm test`, `npm run build` and `npm run e2e` in `app/web`. Record the three result lines in the report.
- [ ] **Step 4:** commit `docs(service): lanes, limits and the others' budget; test(service): upstream refusals are logged`.

## After the plan (controller, with the user's go-ahead for each)

Push the branch; deploy to the acceptance environment; live check with two accounts per the spec's 验收; update the Notion decision log.
