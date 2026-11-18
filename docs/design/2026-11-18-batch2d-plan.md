# Batch 2D — an Agent decides whether to reply — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner can let their Agent reply in a group without being @-mentioned, when a judgement model says the latest message calls for it, under a floating threshold, a daily budget and a fuse.

**Architecture:** After a person's message that names no Agent, the group's judgement is debounced in memory (one service instance) and then made by one call to a small judgement endpoint (`/systemone`, typed probabilities), outside any transaction. The decision is pure arithmetic over a per-Agent-per-group state row; the winner gets an ordinary queued reply run in lane `proactive`. Everything fails closed: any error, timeout or doubt means nobody replies.

**Tech Stack:** Fastify 5, Postgres, TypeScript, vitest (`app/service`); React, vitest, Playwright (`app/web`).

**Spec:** `docs/design/2026-11-18-batch2d-agent-decides-design.md` (rules 1–19). Built on `docs/design/2026-11-18-limits-plan.md` (lanes, limits, budgets), which is implemented.

## Global Constraints

- Tests first; each new test seen failing. Service: ONE shared test database — focused runs only (`npx vitest run tests/<file>` from `app/service`), never two at once; `npm run typecheck` before each commit. The whole suites run once, in the last task.
- Commits: explicit path list, the environment's Co-Authored-By trailer, no push. Install nothing; no new dependency. Never read `.env`, `.local/`, or key files under `E:\Agent-Family\`. Migrations append-only (latest is 021).
- Fail closed (rule 9): judgement unconfigured, over its daily cap, erroring, timing out, or answering anything but a number in [0, 1] for a question → that Agent is not chosen and its state is not changed.
- The judgement model is shown only: the last messages of the group that every judged Agent may see, and each Agent's name, intro and field. Never a persona document, never anything from another conversation (rule 6).
- The judgement costs the site, never a user (rule 16). The reply it leads to is its owner's, as any reply (rule 17).
- Nothing tells a group member who has proactive replies on, nor that a reply was proactive (rules 18, 19). Only the owner's copy says so.
- A blocked pair (either direction, as in the limits work) never causes each other's Agents to reply proactively.
- All numbers are site configuration with these defaults (starting points; calibrated before release): debounce 3000 ms; transcript 15 messages, 300 characters each; at most 8 Agents per judgement; base threshold `less` 0.6 / `normal` 0.45 / `more` 0.35; surcharge +0.15 per proactive reply, at most 0.4, halving every 120 s or every 4 messages by others, whichever decays more; quiet: probability ≥ 0.8 → raise 0.5 with half-life 3600 s, ≥ 0.3 → raise 0.15 with half-life 600 s; total threshold at most 0.9; fuse 1 per 10 s and 30 per hour per Agent per group; judgement timeout 4000 ms; site cap 20 000 judgements a day; proactive daily budget default 20 points (1–100 000, never unlimited).
- Chinese copy, verbatim: notice `「{name}」暂时不主动发言，需要时可以 @ 它`; form switch `主动参与群聊`, helper `打开后，群里有人说到它擅长的事，没 @ 它它也可能回复。花的是你的点。`; level label `话多话少`, options `少说` / `适中` / `多说`; budget label `主动回复每天最多花`; owner line `今天主动回复已花 {spent} / {budget} 点`, reached `今天主动回复的额度已用完，调高后立即恢复。`; reply line suffix ` · 主动回复`.

## Rulings made while planning (what — why — cost if wrong)

- **The reply probability is `max(need, addressed)`** of two questions per Agent ("it should reply to this now" / "this message is speaking to it or following up on what it said") — the experiment showed follow-ups score on the second and fresh requests on the first — one constant to change.
- **One transcript for all judged Agents: only messages after the latest join among them** — rule 5 wants one call, rule 6 wants nobody shown what came before they joined — a newly joined Agent shortens everyone's context for a while; judge per Agent if that hurts.
- **At most 8 Agents are judged per message (lowest ids)** — bounds the call — raise the number.
- **Debounce timers live in memory** — one instance; a restart loses at most the judgements of the last 3 s, which is "nobody replies" — move to a table with a second instance.
- **A proactive reply is never folded into, and never starts while that Agent has an active run in the group.**
- **Over the proactive budget, the owner's others-lane minute, or the fuse: silently nothing** (the owner's page shows the budget; the log has the rest) — a notice for a reply nobody asked for would be noise.
- **The surcharge is added when the run is queued**, not when it ends — otherwise two messages in a row both pass.
- **The Agent's scene gets one more line for a proactive reply:** `没有人 @ 你。你是看到相关的话题主动发言：简短、有用，不要寒暄。` — the model should know nobody asked — wording change.
- **Calibration samples are written by hand to resemble real chats** — there are no real users yet — replace with real excerpts after the friends' test and re-run.
- **A person can make an Agent quiet or talk by what they say; display names in the transcript are theirs to choose** — the judgement only yields probabilities, and what they can cause (one reply within the budget, or a raised threshold that decays) is no more than they could by @-mentioning or by asking it to be quiet.

## Review Focus

- Nothing proactive happens when `JUDGE` is unset: no timer, no query, the settings refuse to turn on, the web shows no switch.
- A judgement in flight when the group changes (an Agent posts, someone @-mentions, the Agent is paused/removed/its owner leaves): the decision re-reads everything under the group's row lock and drops what is stale.
- Two Agents over their thresholds: exactly one replies; the other's state is untouched.
- The quiet raise decays with time only; an @-mention answers but does not lower it; the notice appears once per raise, not per message.
- A member's view, pushes and message copies never contain `proactive*` keys or `via.proactive`.

---

### Task 1: The judgement client and its configuration

**Files:** Create `app/service/src/judge/client.ts`, `app/service/tests/helpers/judge.ts`, `app/service/tests/judge-client.test.ts`. Modify `app/service/src/config.ts`, `app/service/src/app.ts` (build it into `deps.judge`, overridable in tests like `deps.models`).

**Interfaces — produces:**
- Config `JUDGE` (JSON, optional): `{ model: string, channels: [{ url: https URL, apiKeyEnv: string }] (1–2), timeoutMs?: 4000, dailyLimit?: 20000 }` → `config.judge: null | {...}`; an `apiKeyEnv` that is unset refuses start-up naming it (as `SITE_MODELS`). Config `PROACTIVE` (JSON, optional, every field defaulted per Global Constraints) → `config.proactive`.
- `type Question = { key: string; instructions: string }`; `interface Judge { ask(state: string, questions: Question[], signal?: AbortSignal): Promise<Map<string, number>> }` — POSTs `{ model, state, questions: { [key]: { type: "noul", instructions } } }` with `authorization: Bearer`, `content-type: application/json; charset=utf-8` through `guardedFetch` (follow `providers/probe.ts`); reads `answers[key].noul`; a key missing or not a finite number in [0, 1] is left out of the map; non-200, invalid JSON, timeout → tries the next channel, then throws `JudgeError`.
- `tests/helpers/judge.ts`: `scriptedJudge()` with `.answer((state, questions) => Record<key, number> | Error | "hang")`, `.calls`.

- [ ] Failing tests: request shape and headers against a local HTTP stub; second channel used after a 500 and after a timeout; out-of-range/missing answers dropped; both channels failing throws; `JUDGE` unset → `config.judge === null`; unset key variable refuses.
- [ ] Implement; tests pass; typecheck; commit `feat(service): the judgement client and its configuration`.

### Task 2: The owner's settings

**Files:** Create `app/service/migrations/022_proactive_settings.sql` (`agents.proactive boolean not null default false`, `proactive_level text not null default 'normal' check in ('less','normal','more')`, `proactive_budget_micro bigint not null default 20000000 check between 1000000 and 100000000000`). Modify `agents/store.ts`, `agents/routes.ts`, the models/site-info route the web reads at start (find the one that lists site models), the co-member sweep test's hidden keys. Test `tests/agents-proactive-settings.test.ts`.

**Interfaces — produces:** create/PATCH `proactive: boolean`, `proactiveLevel`, `proactiveBudget` (the `chainBudget` schema; `null` refused); owner's view adds those three and `proactiveSpentToday: string` (settled charges today on this Agent's lane-`proactive` runs, no holds — generalise the limits work's spend sum to take the lane); `proactive: true` with `config.judge === null` → 409 `proactive_unavailable`; the site-info answer gains `proactiveAvailable: boolean`.

- [ ] Failing tests: defaults; each field's validation; 409 when unconfigured (and `false` still accepted); the owner's view has the four keys, a co-member's none; `proactiveSpentToday` counts only lane `proactive`.
- [ ] Implement; tests pass; typecheck; commit.

### Task 3: The floating threshold (pure)

**Files:** Create `app/service/migrations/023_agent_group_state.sql` (`agent_group_state (agent_id, conversation_id, surcharge real not null default 0, surcharge_at timestamptz, surcharge_seq bigint, quiet real not null default 0, quiet_half_life_s int, quiet_at timestamptz, primary key (agent_id, conversation_id))`, both FKs `on delete cascade`), `app/service/src/agents/proactive/threshold.ts`, `app/service/tests/proactive-threshold.test.ts`.

**Interfaces — produces** (all pure; `P` = `config.proactive`):
- `type GroupState = { surcharge: number; surchargeAt: Date | null; othersSince: number; quiet: number; quietHalfLifeS: number | null; quietAt: Date | null }`
- `surchargeNow(s, now, P): number` = `s.surcharge × 0.5^max(Δt/halfLife, othersSince/halfMessages)`
- `quietNow(s, now): number` = `s.quiet × 0.5^(Δt/quietHalfLifeS)`
- `thresholdNow(level, s, now, P): number` = `min(P.cap, base[level] + surchargeNow + quietNow)`
- `afterProactive(s, now, P)`: surcharge = `min(P.surchargeMax, surchargeNow + P.surchargeStep)`, stamped now
- `afterQuiet(s, q, now, P): { state, big: boolean } | null`: `null` below 0.3; else the raise and half-life for q; keeps the larger of the decayed current value and the new raise, with the half-life of whichever won; `big` when q ≥ 0.8.

- [ ] Failing tests as a table, using the design's worked examples: idle 0.45; after one reply 0.60; after two 0.75; after two then ~6 minutes or ~12 messages ≈ 0.47 (±0.02); `less`/`more`; cap 0.9 with quiet 0.5 on top; quiet 0.95 → +0.5, half after an hour, unaffected by `othersSince`; quiet 0.35 → +0.15, half after 10 minutes; quiet 0.1 → null; a small raise does not shorten a big one.
- [ ] Implement; tests pass; typecheck; commit `feat(service): the floating threshold`.

### Task 4: The decision

**Files:** Create `app/service/src/agents/proactive/decide.ts`, `app/service/tests/proactive-decide.test.ts`. Modify `app/service/src/agents/runs.ts` (export what is needed: `queueRun` for lane `proactive` with `caller_id` null and `triggered_by` 'human'; the others-lane minute check), `messages/model.ts` + `conversations/system.ts` (`agent_quieted { actorId, agentId }`).

**Interfaces — consumes:** `Judge` (Task 1), settings (Task 2), threshold functions and table (Task 3), `noneTriggered()`/`Triggered`, `lockAgent`, `appendSystem`, `siteDayStart`. **Produces:** `decideProactive(deps: { db, judge, config, log }, conversationId: string, seq: number): Promise<Triggered>` in three phases:
1. *Read* (no locks): the message at `seq` must still be the group's latest non-system message and a person's, naming no Agent; candidates = current Agent members with `proactive`, not paused/deleted, with a model, no block either way between their owner and the sender (the owner's own message counts: the owner can be answered proactively too); at most 8 by id; none → return. The site's judgement count for today (table `judge_usage (day date primary key, calls int)`, created in this task's migration `024`) at the cap → log once a day, return.
2. *Judge* (no transaction): transcript = the last 15 non-system messages after the latest `joined_seq` among candidates, each `{display name}：{text}` (an Agent's `{name}（Agent）：…`; a file `[文件] caption`; 300 characters); `state = "群聊记录：\n" + transcript`; three questions per candidate `i`: `i_need`, `i_addr`, `i_quiet`, each opening with `群里有一个 AI 助手，名字叫「{name}」，它的定位是：{intro}；擅长：{field}。记录里标着“{name}（Agent）”的是它说过的话。` then, respectively: `它现在应该主动回复最新这条消息：有人在求助或提问，而且正好是它擅长的事，还没有人回答。真人之间的闲聊、客套、已经有人回答的问题，都不算。` / `最新这条消息是在对{name}说话，或者是在接着{name}刚才说的话继续追问它。` / `最新这条消息是在让{name}别再说话、安静一点，或者表示它打扰到大家了。`. Count the call in `judge_usage`. Error → return.
3. *Decide* (one transaction, the group's row locked; then `lockAgent` per touched Agent in id order): re-check phase 1's conditions; for each candidate with a `quiet` answer apply `afterQuiet` (upsert state; when `big` and no `agent_quieted` notice about it in this group within the last hour, append one); a candidate without both `need` and `addr` is out; `p = max(need, addr)`; `othersSince` = messages by anyone else after `surcharge_seq`; eligible when `p ≥ thresholdNow`; choose the largest `p − threshold` (ties: lowest id); for the chosen: no active run in the group, fuse (its proactive runs in this group: none in the last 10 s, fewer than 30 in the last hour), proactive budget not spent, owner's others-lane minute not full — any failing: log `{ metric: "proactive_skipped", reason }`, return without trying the next; else queue the run (lane `proactive`), apply `afterProactive` with `surcharge_seq = seq`, return it.

- [ ] Failing tests (scripted judge): on-topic request → the Agent's run, lane `proactive`, covers `seq`; chat → nothing, no state row; two candidates → one run, the other untouched; an Agent's message / a message naming any Agent / a stale `seq` → judge not called; quiet 0.95 → state raised, one notice, a second within the hour no notice; quiet then need 0.48 → nothing; quiet then addr 0.93 → run; after a run, need 0.48 again → nothing until time/messages pass (advance by rewriting `surcharge_at`); blocked sender (each direction) → not a candidate; budget spent, fuse, owner's minute full, active run → nothing and a `proactive_skipped` line; judge throws / hangs past timeout / answers `need` only → nothing; `judge_usage` at the cap → judge not called; the notice text.
- [ ] Implement; tests pass; also `tests/agents-group-trigger.test.ts`, `tests/agents-others-budget.test.ts`; typecheck; commit.

### Task 5: When it is asked

**Files:** Create `app/service/src/agents/proactive/scheduler.ts`, `app/service/tests/proactive-scheduler.test.ts`. Modify `messages/routes.ts` (after commit), `agents/port-impl.ts` (an Agent's post cancels), `app.ts` (build, `onClose` clears).

**Interfaces — produces:** `createProactiveScheduler({ decide, publish, announce, delayMs, log }): { noted(conversationId, seq, namesAgent: boolean): void; cancelled(conversationId): void; close(): void; idle(): Promise<void> }` — `noted` (a person's group message): `namesAgent` → cancel the group's timer; else (re)start it for `seq`. On firing: `decide`, then publish notices and announce the run exactly as the send route does for a mention. Never throws; errors are logged. Not created at all when `config.judge` is null.

- [ ] Failing tests (fake timers or `delayMs: 20`): three messages in quick succession → one decision, for the last; a mention in between cancels; an Agent's post cancels; nothing scheduled in an Agent's own conversation or a direct chat; `close()` leaves no timer and a later `noted` does nothing; with `JUDGE` unset the route schedules nothing (spy); end to end with the scripted judge and the worker: a person asks, ~delay later the Agent's reply is posted and every member's page gets it.
- [ ] Implement; tests pass; typecheck; commit.

### Task 6: What the owner sees of a proactive reply; the Agent knows nobody asked

**Files:** Modify `messages/read.ts` (`via` gains `proactive: true` when the run's lane is `proactive`; absent otherwise), `agents/context.ts` (the scene line), `app/web/src/data/viewmodel.js` + `app/web/src/pages/Messages.jsx` (suffix), tests beside each (`tests/agents-reply-via.test.ts`, `tests/context.test.ts`, `web/tests/agent-chat.test.jsx`, `web/tests/viewmodel.test.js`), the co-member sweep.

- [ ] Failing tests: owner's copy `via.proactive === true` for a proactive reply, key absent for a mentioned one; member's copy has no `via` (unchanged); the system text of a proactive run contains the line, a mentioned run's does not; web line ends ` · 主动回复`.
- [ ] Implement; tests pass (service files one at a time; web `npx vitest run` for the two files); commit.

### Task 7: Web — the settings and the notice

**Files:** Modify `app/web/src/pages/AgentForm.jsx`, `Agents.jsx`, `data/viewmodel.js` (`agentView`, `noticeText` for `agent_quieted`), wherever the site-info answer is stored; tests `web/tests/agents-pages.test.jsx`, `web/tests/viewmodel.test.js`.

- [ ] Failing tests: with `proactiveAvailable` false no switch and nothing sent; with it true the switch (default off) and, when on, the level select and budget input (validated as the chain budget's, no unlimited option); edit sends only changed fields; the Agent page's row and its reached text (numeric compare as the others' budget row); the notice text and its unknown-Agent fallback.
- [ ] Implement, following the others' budget field added by the limits work; `npm test`, `npm run build` in `app/web`; commit.

### Task 8: Calibration, documentation, the whole suites

**Files:** Create `app/service/calibration/samples.jsonl` (at least 40 hand-written group excerpts, each `{ id, agent: { name, intro, field }, transcript, expect: "reply" | "none" | "quiet" }`, covering: fresh on-topic requests, follow-ups by the asker and by others, thanks, topic changes, called by name without @, asked to be quiet (blunt and mild), complaints, chat that only brushes the field, questions already answered by a person, questions to someone else, jokes telling it to shut up), `app/service/scripts/calibrate-judge.mjs` (reads `JUDGE_URL`, `JUDGE_KEY`, `JUDGE_MODEL` from the environment — never a file; prints per sample the three probabilities and, for thresholds 0.30–0.70 in steps of 0.05, how many `reply`/`none` samples fall on the wrong side, and for quiet the same at 0.3 and 0.8). Modify `app/service/README.md`, `app/deploy/README.md`, `.env.example` (names only), `app/web/e2e/support/env.mjs`, add `app/web/e2e/agents-proactive.spec.mjs` (a stub judgement server started by the e2e harness: the owner turns the switch on; a member asks an on-topic question without @ → the Agent replies; the owner's page shows ` · 主动回复`, the member's does not; "别插话了" → the notice).

- [ ] Samples and script (the script is run against the real model by the controller, who holds the key; its output goes into the acceptance record and decides the defaults).
- [ ] Documentation: configuration (`JUDGE`, `PROACTIVE`), the flow and its three phases, the state table, every brake and what the log says for each, wire shapes, notices, what members never see.
- [ ] Once: `npm run typecheck`, `npm test` (service); `npm test`, `npm run build`, `npm run e2e` (web). The five result lines go in the report.
- [ ] Commit.

## After the plan (controller, each with the user's go-ahead)

Run the calibration against the real model and set the defaults from it; push; set `JUDGE` (two channels) on the acceptance service without printing keys; deploy; live check per the spec's 验收; acceptance record; Notion.
