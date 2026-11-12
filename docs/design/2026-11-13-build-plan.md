# Web + LINE implementation plan

Approved direction: previous proposal, with all implementation decisions delegated. Deadline 09:00 JST, 2026-11-13. No user interruptions during work.

1. Inspect Cebus for reusable modules versus bounded integration cost; choose maintained SDKs and UI primitives. Record reuse decisions and notices.
2. Build persistent, authenticated private workspaces and rooms; agent membership and model configuration; server-only credentials.
3. Implement streaming independent answers, targeted answers, and bounded discussion with cancellation, errors, quotas and reconnect-safe history.
4. Build a responsive Chinese-first app: onboarding, room creation, messages, member editing, settings, LINE setup, export and empty/error states.
5. Implement official LINE webhook verification, event deduplication, safe room binding, role sender presentation, async queue and reply/push behavior. Live connection is conditional on provided credentials.
6. Verify with automated API/security tests and browser desktop/mobile flows. After implementation use CanalAPI for bounded real-model acceptance tests.
7. Package startup/deployment instructions, run the usable app, document exact verification and remaining external setup.

Definition of done: real usable Web conversations with durable history and independent agents; robust tested LINE adapter with clear connection setup; no exposed secrets, unsafe public signup or unbounded tools; no inert primary controls; startup instructions and evidence.
