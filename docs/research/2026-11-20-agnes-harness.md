# Agnes Harness (AgnesAI-Labs/agnes-harness): what we can learn

Research date: 2026-11-20. Sources: the repository's README.md, LICENSE, NOTICE, docs/ (guide, extend, develop, reference, maintainers), and the GitHub API (repo, contributors, releases, commits). All pages were read through a fetch tool that summarises pages, so every statement is a paraphrase of a summary, not a verbatim reading. I did not read source code under `packages/`, so anything about internals not stated in docs is marked "unconfirmed". Nothing was cloned, downloaded or run.

## Summary (12 lines)

1. What it is: "Agnes Harness" (AGH) is a TypeScript, plugin-based agent runtime for "Forward Deployed Engineering" (building agents inside a customer's own environment). A local App Server owns an append-only SQLite event ledger, approvals and recovery; the agent loop, tools, memory, model adapters and UI panels are all plugins.
2. Who/when: org AgnesAI-Labs; repo created 2026-09-22; earliest visible commits 2026-09-24; last push 2026-11-20 (today). No releases, no tags, no package release.
3. Activity: 5,159 commits in about 2 months (roughly 85 a day); 12 contributors, three of them account for about 4,800; 2.3k stars, 182 forks, 7 open issues; "only collaborators can create PRs". That commit rate suggests heavy automation or AI-assisted work (inference, not stated).
4. Maturity: the repo itself says "developer preview (pre-alpha)", not for production, Windows untested end to end, no public package. No production users are named. One external benchmark number (Agents' Last Exam, 21.7% overall) is quoted without methodology.
5. Evidence level: the docs are unusually candid. Several of its own pages say "no performance claims", "no real-session evaluation yet". Most mechanisms are authors' design claims backed by tests of wiring, not measured outcomes.
6. Licence verdict: Apache-2.0, standard text, no hosted-service, multi-tenant or branding clause found. Code reuse is legally possible (keep notices, state changes). Practical verdict: reuse ideas, not code, because the code is pre-alpha, ties to its own plugin host, and parts are third-party (see section "Licence").
7. Ranked idea 1 (authors' claim only): "unknown outcome is never retried" for effectful tool calls, with a durable "executing" marker written before the call, so a crash leaves a trace. Sound design; no measurements.
8. Ranked idea 2 (authors' claim only, partly widely used elsewhere): bounded, ordered parallel tool execution plus "two failures of the same tool disables it for the turn" and a three-no-progress stop. Close to what we already have; the per-tool disable and "same call, same result, nothing changed" duplicate rule are the new bits.
9. Ranked idea 3 (authors' claim only): a separate side model that judges "did the reply end before doing what it promised?" (probability at least 0.5 triggers one continuation). They state outright there is no real-session evidence yet. Relevant to our small judge model but unproven.
10. Ranked idea 4 (authors' claim only): test tooling: scripted model provider, record-once-replay-offline with credential redaction, a localhost fault-injection server (429, 503, truncated SSE) that fails if a scripted fault is unused, and a loop "contract test" any custom loop must pass. Practical and adoptable; no outcome data, but this is plain engineering.
11. Ranked idea 5 (authors' claim only): memory writes as exact-diff proposals bound to content hashes, paragraphs with a validity state (valid, expired, unknown, delivered) where expired ones are hidden from the agent but still visible to humans, and agent access to memory defaulting to off. Matches our owner-only memory; the validity states are a possible addition.
12. Does not transfer: single-user local trust model (local Web UI "not internet authentication"), in-process trusted plugins, shell/OS sandbox, file workspace, FDE/device (MHS) features, GitHub-ticket "Superagent", a credits system with no stated dollar mapping. No priority queue, no per-owner metering, no multi-user chat.

## Basics

- What it is, in two sentences: an open-source runtime ("harness") for business agents, built so that everything a deployment adds (tools, loops, model adapters, personas, UI panels, skills) is a pinned, versioned plugin. A core process records every model call and tool result in a hash-chained SQLite ledger and handles approvals, crash recovery and cost rows. Source: README.md, docs/guide/why-agh.md.
- Maker: AgnesAI-Labs (GitHub org). Commit authors are mostly pseudonymous accounts (495696116, lookfree, Onetaway). Company details unconfirmed. The README mentions "Agnes" models (Agnes 2.5 Pro Beta, "Agnes Sys1" judgment model), so the org also appears to sell its own models (inference).
- Dates: created 2026-09-22 (GitHub API). Earliest commits I could see: 2026-09-24 (a docs commit and "perf(core)" change, PR #1 merged the same day). I did not reach the very first commit. Last push 2026-11-20.
- Activity: 5,159 commits on main; 12 contributors (3,016 / 1,063 / 724 / 86 / then small numbers); 2,275 stars; 182 forks; 5 watchers; 7 open issues. Stars-to-watchers ratio (2.3k to 5) is odd and, together with the pace, I would not read the star count as adoption.
- Maturity statements from the repo itself: pre-alpha developer preview; build from source (Node 24.10+, pnpm, mise); no installer; "not for production"; macOS and Linux checked, Windows not verified; upgrade from the previous version requires a fresh home (old sessions do not carry over). Source: README.md, docs/reference/limitations.md.
- Proof: no named production users. One leaderboard claim (README): Agnes Harness with its own Agnes 2.5 Pro Beta model scores 21.7% overall pass rate on "Agents' Last Exam"; the README itself says neighbouring entries use different models and settings, so it is not like-for-like, and gives no methodology. docs/guide/why-agh.md says no competitor runtime or paid-model benchmark was run. docs/reference/limitations.md says no performance claim is made without fixed models, budgets, tasks and reproducible measurements.
- Tests: a fast tier, a heavy tier (real processes, large data), repository guards on file and function size, a web bundle budget, a macOS/Linux browser end-to-end gate. docs/maintainers/verification.md deliberately gives no current test counts and says the previous-build upgrade test is disabled by default. So tests exist, their breadth is unconfirmed.

## Licence

- LICENSE title lines: "Apache License / Version 2.0, January 2004". My fetch tool saw the standard nine sections and appendix and no added clause; it could not diff against the official text, so "unmodified" is unconfirmed but nothing contradicts it.
- NOTICE: Apache-2.0 for project code unless a file says otherwise. It lists third-party parts under their own terms: MIT (Cordis, DeepSeek-derived tool and fetch code, Nous Research computer-use adaptation, a ported "superagent", XMarkdown, xterm.js and others), Apache-2.0 (the "Jev agent loop, adapted from JevLoop", Document Reader, ACP schema, sharp, playwright-core), ISC (Lucide icons), and separately licensed binaries (Chrome for Testing, libvips, PDF/Word/OCR dependencies). It says it "does not modify any license" and has no trademark or branding policy text.
- Hosted-service, multi-tenant, branding: none found in LICENSE or NOTICE. Apache-2.0 has a patent grant and requires keeping licence and NOTICE text and marking changes; it has no network-use clause.
- Verdict for Agent Family (hosted, multi-user): legally we may reuse code under Apache-2.0 with attribution. I recommend ideas only: (a) the code is tied to a plugin host and ledger we do not have, (b) it is pre-alpha with a very high churn rate, (c) mixed third-party provenance (several parts are borrowed from other projects, so a lawyer would need to trace each file), (d) the owner's rule to describe mechanisms in our own words. This is not legal advice.

## 1. Agent loop / harness core

Where: docs/guide/jev-loop.md, docs/guide/sessions.md, docs/extend/loop-events.md, docs/extend/workflow-loops.md, docs/extend/tool-runtime.md. The default loop's own internals (step caps, handling of garbled calls) are not documented on the pages I read: unconfirmed.

- Turn structure: a user request starts a "run" that cycles model calls and tool steps until it completes, is cancelled, hits a limit or fails. A reply with no visible text and no tool call does not count as done; the loop asks the model to continue within a retry budget. Transient failures retry in the same budget, and partial output of a failed attempt is kept as "interrupted" and still billed. (docs/guide/sessions.md)
- Alternative loop "Jev" (an optional plugin): at each step a small side model ("TypeSafe Jev") picks the next action (phase, tool plus arguments, or answer); if confident it runs the tool without calling the main model; the main model is used only to write arguments for tools Jev cannot fill, to review uncertain choices, and to write the final answer. Confidence gating: below 0.5 the main model reviews; tools that write externally need 0.6. For seven built-in file and shell tools Jev can fill arguments itself and can read up to four files in one step. (docs/guide/jev-loop.md)
- Stop conditions in the Jev loop: step cap 30 (`max_steps`); three failures of the same call, or three consecutive steps that learn nothing new, end the turn with a no-progress code; a core budget refusal ends it. (jev-loop.md)
- Repeat guard: an identical tool-plus-arguments call is refused as no-progress when its last two runs returned the same result and nothing in between could have changed files. File-staleness tracking: a file written after being read must be re-read; a shell call invalidates earlier reads. (jev-loop.md)
- Tool failure guard (any loop): two consecutive failures of a tool disable it for the rest of the turn; limit configurable 1 to 5. Invalid arguments are rejected with a short field-specific hint before any side effect. (docs/extend/tool-runtime.md)
- Parallel calls: adjacent concurrency-safe calls run in a bounded pool (1 to 64); an exclusive call waits for the pool to drain; results come back in input order. On cancel, no new calls start and running ones are drained. (tool-runtime.md)
- Retries and timeouts: Jev side call deadline 15 s default; rate-limit retries up to 2, honouring the vendor wait only up to 10 s; main-model retryable failures 2 attempts. Plugin event listeners get a 2 s limit. (jev-loop.md, loop-events.md)
- Crash resume: after restart the loop resumes from its last checkpoint and never resends a model request that may already have gone out; it asks for review instead. (jev-loop.md)
- Evidence: authors' claim only. The Jev page itself presents no benchmark, and says it has no pause or interrupt support and no child agents.
- What Agent Family could take: (1) the "same call, same result, nothing changed" duplicate rule and the "same tool fails twice, drop it for this turn" rule are cheap additions to our repeat detection; (2) "do not resend a model request that might already have gone out after a crash" is a good rule for our stale-run sweep (we should check we do not double-charge or double-post).

## 2. Context management

Where: docs/guide/context.md, docs/extend/compaction-engines.md, docs/guide/jev-loop.md (budgets), docs/reference/default-tools.md.

- Budgeting: repository rule files are capped (1 MiB each, 4 MiB total reads, 32 KiB rendered by default); extension text has two separate 8 KiB channels, one trusted and one "untrusted", so untrusted text cannot crowd out trusted text. Jev has a state token budget (24,000) and a whole-request budget (48,000), based on estimates. (context.md, jev-loop.md)
- Caching: the system prefix is kept stable; rules and clock notes are appended as tail notes; a note is re-sent only when its text changes; unchanged notes are recognised from the visible history so resume and fork do not resend them; the clock note refreshes about every ten minutes inside a turn. The point is to keep the prompt prefix byte-stable for provider prompt caching. (context.md)
- Compaction: pluggable engines. Each decides `shouldCompact(budget)` using a live reserve and a retained-token target. The default engine defers compaction while the cache is warm, recovers on context overflow, and retries failed summaries. The summary is produced by a dedicated "compaction model slot" with a check that the content fits that model's window, a budget reservation, and one retry on a reasoning cutoff. Core rejects any replacement not shorter than what it replaces. Fixed system sections and "pinned" nodes are never replaced; a range may not split a tool call from its result or remove the whole conversation. Original ledger rows are kept; elided content only leaves future requests. A simple alternative engine keeps the last N turns (default 4) with no model call. (compaction-engines.md)
- Token counts: engines receive estimated counts per node; the pages do not say how they are estimated or whether real usage later replaces them: unconfirmed. Summary calls record actual usage.
- Tool-result truncation: results over a row or size limit spill into an artifact the model can read in pieces; shell output is capped (4 MiB per job); grep and find cap structured path lists at 100 entries and spill the rest to an artifact. (default-tools.md)
- Numeric compaction thresholds: not given.
- Evidence: authors' claim only; no measurements of cost or quality.
- What Agent Family could take: (1) "never compact across a tool call and its result" and "reject a summary that is not shorter" are two cheap invariants for our planned rolling summary; (2) "defer compaction while the provider cache is warm" is a cost idea for our summary scheduling, if our providers cache prompts; (3) the stable-prefix plus tail-notes layout is worth copying for our per-turn changing items (time, whispers); (4) the "spill to a readable artifact" pattern fits our read-only history-search tool.

## 3. Tools

Where: docs/extend/tool-runtime.md, docs/reference/default-tools.md, docs/guide/security.md, docs/guide/sandbox-providers.md (not read).

- Definition: a full execution schema validated by Core before any policy or side effect, an optional compact schema shown to the model for large contracts (it grants no authority), and metadata flags: destructive, open-world, requires-approval, outward, defer-loading. Tools load on demand through `tool_search` and `tool_describe`. (tool-runtime.md, default-tools.md)
- Approval: policy returns allow, ask or deny; human decisions are durable requests that a deferred call resumes; "outward" actions (send content out, change remote state) always stop for a person in every mode; a command table is a safety floor that a selected policy can only tighten. Optional auto-review by a separate reviewer model that may only auto-allow low-risk calls; invalid, uncertain or "tainted" cases go to a human, and it never falls back to the main model. (tool-runtime.md, security.md)
- Sandbox: command text rules are explicitly "not a sandbox"; the real boundary is an OS sandbox on macOS and Linux; on Windows only partial write restriction. (security.md)
- Result bounds: see section 2; plus file write needs a prior read, stale-write check, atomic multi-edit (one failure writes nothing), and a guard against rewrites that sharply shrink a file. Errors return stable codes plus a recovery hint, not raw exceptions. (default-tools.md)
- Search: grep and find use ripgrep, skip dependency and build folders and symlinks, report unreadable paths and binary skips, and treat "no matches" as success. (default-tools.md)
- Evidence: authors' claim only (design docs), though read-before-write and atomic edits are widely used in coding agents.
- What Agent Family could take: (1) structured errors with a stable code plus a one-line recovery hint for each tool failure, which also helps weaker models recover; (2) the "schema shown to the model can be a compact version; the full one validates" split for our context budget on tool definitions; (3) "no matches is success, not an error" for the chat-history search tool. The approval and sandbox parts do not transfer (see section 10).

## 4. Multi-agent

Where: docs/extend/child-agents.md, docs/guide/superagent.md.

- Mechanism: a parent session hands work to a child through a provider. Built-in children are in-process sessions, either forked from the parent's history or fresh. Tools: send follow-up, interrupt, collect result, list. When a background child finishes or idles, Core writes a completion notice to the parent (wakes an idle parent, queues for a busy one, withdrawn once collected, so it is not delivered twice). (child-agents.md)
- Bounds: default 4 concurrent children; separate nesting-depth limit; running, approval-waiting and recovering children hold a slot, idle ones release it and must re-acquire; allowlists for providers and models (if a model list is set the caller must name a model so an inherited one cannot slip through); a child's budget and tool filters can only narrow the parent's; hitting a limit returns a readable error to the parent; cancelling a parent cancels all unfinished descendants. (child-agents.md)
- Not covered: Jev loop states "no child agents". Per-child cost attribution beyond "budgets can only narrow": unconfirmed.
- Superagent: a default-installed plugin that watches one GitHub repo (and optionally Feishu) and makes one session per ticket that pushes a branch and opens a pull request; humans approve through branch protection. The page says prompts are not a security boundary and ticket sessions run as full-access OS user. No benchmarks. (superagent.md)
- Evidence: authors' claim only.
- What Agent Family could take: for our planned Agent-to-Agent teams: (1) "a child's budget and tool set can only be narrower than its parent's" is the right invariant for per-owner metering; (2) a concurrency slot that is held only while a child is running, not while idle; (3) "cancel parent cancels descendants"; (4) completion notices delivered once ("withdraw after collected"). Note this is agent-to-agent inside one owner's session, not several owners' Agents in one chat, which AGH does not address.

## 5. Memory

Where: docs/extend/memory.md, docs/guide/memory.md (not read), docs/extend/feedback.md.

- Shape: one memory provider pinned per session (default a file-based provider); a bounded index delivered each turn, topic files loaded on demand; the index is stable within a turn. A missing explicitly selected provider fails closed. Knowledge bases are a separate capability.
- Write path: the agent writes through ordinary file tools wrapped by the provider; in ask mode a human approves the exact diff, bound to old and new content hashes and the session and turn; rejected, cancelled or conflicting proposals never reach the context; writers are serialised; a topic file is committed before the index links to it.
- Consolidation: the Host can store task experience as managed paragraphs with states valid, expired, unknown, delivered; expired and unknown are hidden from the agent but visible to humans; a background maintenance job proposes changes committed as one compare-and-swap that is refused if the file changed meanwhile.
- Visibility and control: agent access to memory is off by default; user memory (hand-written) is shown first and agent-saved text is trimmed first; over-budget writes are refused rather than trimmed; credential-like content is rejected (the page admits the detector has limits); telemetry records only counts and sizes, never content; learned memory is "not authorization" and project rules win over learned preferences.
- Feedback to skills: user ratings on replies can seed a proposed Skill that a human must review; publishing needs a passing test hash and an exact match with the reviewed hash. (feedback.md)
- Evidence: authors' claim only; no measurement of retrieval or consolidation quality.
- What Agent Family could take: (1) a validity state on memory entries (expired or uncertain items hidden from the Agent but still shown to the owner) as a gentler alternative to deletion in the nightly consolidation, working well with our undo; (2) compare-and-swap commit so a nightly consolidation cannot overwrite an owner's edit made while it ran; (3) "refuse over-budget writes rather than silently trim" for the vault. We already have owner-only access, review and undo, so the rest is nothing new.

## 6. Model and provider abstraction

Where: docs/guide/local-model.md, docs/reference/capabilities.md, docs/reference/protocol-tiers.md, docs/guide/observability.md, docs/extend/workflow-loops.md. Provider internals live in `packages/ai`, which I did not read.

- Protocols: model adapters are plugins; OpenAI-compatible chat completions with streaming, tool calls and image input is the documented one; the capability matrix mentions OpenAI and Anthropic reachability checks. Others: unconfirmed.
- Capability detection: explicitly NOT inferred from model names. Capacity and capability (context window, output limit, reasoning, image input, tool-call format) are configured per route; discovery reads only model IDs from `/models`. `toolCallFormats` says where tool calls are read from (native field, or text formats such as Hermes-style tags, Qwen syntax, inline JSON); calls are never read from reasoning text; Qwen IDs default to native plus Qwen parsing. (local-model.md) This is the opposite of our per-model automatic detection, so it is a weaker approach for our use.
- Fallback / rate limits / queueing / priorities: not described on any page I read: unconfirmed, probably absent. The Jev side call retries rate limits with a short cap (section 1).
- Cost accounting: one cost record per model call including errors and cancellations; usage recorded as soon as observed, so a known charge is not lost if the call is cancelled; if billing becomes unavailable, further model dispatch is refused for that turn; calls without reported usage are marked as estimates; "credits are not dollars" and the dollar mapping is not described. (observability.md, workflow-loops.md, docs/guide/judgment.md)
- Token counting: not described: unconfirmed.
- Evidence: authors' claim only.
- What Agent Family could take: (1) "record usage the moment it is observed, even if the call is then cancelled" and "mark a row as estimate when the provider reported no usage" are worth checking against our metering; (2) "refuse further dispatch if billing is unavailable" is a clean fail-closed rule; (3) recording per-call stage timings (prepare, dispatch, first output, stream, cleanup) helps tune our planned priority queue. Nothing on queueing, so nothing to take there.

## 7. Interaction

Where: docs/extend/loop-events.md, docs/guide/sessions.md, docs/develop/deferred-invocations.md, docs/guide/judgment.md.

- Streaming: model streams are consumed by the loop; response events fire after a stream succeeds and before the assistant message is saved. Details of UI streaming: unconfirmed.
- Early acknowledgement: none found.
- Mid-run user messages: messages sent while the agent works are queued as "steers" and delivered at the next step boundary, never while tools run. They can be edited or withdrawn before delivery, or the user can interrupt. Pause holds the next step across reloads and restarts. Interrupt cancels cooperatively, collects available results, then moves to the queued input; committed effects stay; calls without a receipt are marked uncertain. A loop must declare these controls; the Jev loop declares none. (loop-events.md, sessions.md)
- Cancellation: abort signals propagate to tools and plugin listeners; an already-ended turn is not replayed on resume. (sessions.md)
- Deferred invocations: a validated tool call queued by a UI action, webhook or schedule runs at the next safe step boundary, at most one per step, never interrupting a planned tool batch; same ID plus same binding returns the original receipt (idempotent); an "executing" state is written before the tool runs. (deferred-invocations.md)
- "Stopped early" check: the optional Sys1 judge asks whether the final text promised a next step and then ended without taking it; at 0.5 or more it prompts one continuation in the same turn; the decision is cached locally for up to 30 days. They state there is no real-session accuracy evidence yet. (judgment.md)
- Evidence: authors' claim only; judgment page admits synthetic tests cover wiring, not accuracy.
- What Agent Family could take: (1) queued mid-run messages that can be edited or withdrawn before delivery and are delivered only at step boundaries, which fits a chat product; (2) for our planned "acknowledge first, deliver later" and background tasks, the idempotent queued-call receipt (same ID returns the same receipt) prevents duplicate deliveries after a retry; (3) the promised-but-did-not-do check is a candidate for our small judge model, but run it as an experiment first (log only) because there is no evidence it is accurate, consistent with the owner's "observe before enabling" rule.

## 8. Evaluation and testing

Where: docs/extend/testing.md, docs/extend/workflow-loops.md, docs/maintainers/verification.md, docs/guide/local-model.md.

- Scripted stubs: a scripted provider returns predefined model event sequences with no live provider; tests can see the requests received and how many scripted replies remain.
- Record and replay: record one live exchange to a fixture; the recorder redacts credentials, sensitive fields and named private values and never overwrites a fixture; replay runs offline, rejects changed requests and exhausted scripts, and an `assertConsumed()` check fails if a recorded script was not fully used. The model adapter can also record replies to a new file.
- Fault injection: a localhost-only server simulates HTTP 429 and 503, delays, truncated or malformed SSE streams and recovery, and checks that every scripted fault was consumed.
- Fixtures: lightweight (one tool, direct call) and full (a real host with isolated SQLite ledgers, covering approvals, refusals, durable facts, version upgrades).
- Loop contract test: `verifyLoopExecutionContract(factory)` checks cancellation, approval rejection, usage settlement, unknown outcomes, cold restore and stale scope for any custom loop; `driveLoop` is the fast deterministic driver.
- Repository guards: file and function size budgets that can only tighten; performance gates as regression budgets, not claims; the doc says a filtered run that executes zero tests proves nothing.
- Benchmarks: only the ALE leaderboard line in the README; no harness-level benchmark described.
- Evidence: the test tooling exists as documented; breadth and counts unconfirmed.
- What Agent Family could take: (1) a fault-injection server that returns 429, 503, truncated and garbled streams and fails when a scripted fault was never hit, directly useful for our worker loop (garbled-call handling, stale-run sweep, worst-case holds); (2) "assert every scripted reply was consumed" in our model-stub tests; (3) redacting record-and-replay fixtures from one real exchange; (4) a shared contract test our loop must pass for cancellation, usage settlement and restart, which maps onto our metering (charge on reported usage even when cancelled).

## 9. Security

Where: docs/guide/security.md, docs/guide/credentials.md (not read), docs/guide/fact-chain.md.

- Tool output as data: model output, web pages, MCP results, skills and plugin config never count as user authorization; after untrusted output enters a turn, later sensitive actions may need confirmation (the page says "may"; the exact rule is unconfirmed). Approval cards show the real target and command and say when content is truncated; free-text rejection reasons are truncated, sanitised and labelled as the user's words.
- Outward actions always require a person, in every permission mode; only certain actor roles can answer; a timeout or disconnect never counts as a human rejection.
- Config-changing paths (AGENTS.md, agent home) need per-call approval even under broader permissions. Repository plugins and hooks are disabled until the user trusts their exact contents.
- Secrets: private state directories are blocked from file tools even in full access; only secret references appear in public config; the MCP command line rejects plaintext tokens; logs and traces can still contain sensitive data.
- Honest limits: command-text rules are best effort; ordinary plugins run as trusted in-process code; the local web UI is not internet authentication; the Superagent page says "Prompts are not a boundary".
- Evidence: authors' claim only; no adversarial testing results published in what I read.
- What Agent Family could take: (1) the "untrusted context has its own small budget channel" idea for text from other people's messages in a group: it cannot crowd out our own instructions; (2) "a timeout or a missing answer is never treated as consent" for any approval we add; (3) label user rejection text as the user's words, not instructions. The rest assumes a single local operator.

## 10. Anything else, and what does not transfer

Relevant extras:
- Hash-chained append-only ledger with continuity checks and "refuse to open if tampered" (docs/guide/sessions.md, docs/guide/fact-chain.md). "Trust the recorded facts, not the agent's description of its work" is a good principle for our run records, but a hash chain is more than we need.
- Pinned plugin code per session so upgrades never change a running conversation's behaviour (README, limitations.md): not needed for us now.
- Presenting unknowns as unknown: UI shows gaps and unknown outcomes rather than guessing (fact-chain.md). Fits our audit of removal and revocation paths.
- Honest "limitations" page as a model for our own README.

Does not transfer to a hosted multi-user chat product:
- Single operator, local trust: the Web workbench is local-only; ordinary plugins run in-process as trusted code; there is no multi-tenant isolation.
- OS shell sandbox, file workspace tools, LSP, computer use, device protocol (MHS), GitHub ticket Superagent, Feishu bridge: coding and enterprise-deployment features.
- Approval by one human at one terminal: our approvals involve several people and owners.
- No group-chat concept: no judge for unasked replies, no per-owner metering, no priority queue, no worst-case holds, no whispers, no Agent-to-Agent across owners.
- Credits with no stated dollar mapping, and no concurrency or queue design, so nothing for our endpoint priority queue.
- Capability configured by hand, which is weaker than our automatic per-model detection.

Unconfirmed items (not found in the docs I read): how the default loop handles garbled tool calls or caps steps; how tokens are counted; provider fallback; rate-limit queueing; compaction thresholds; breadth and counts of tests; the very first commit; whether the leaderboard number can be reproduced.
