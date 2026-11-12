# Product
<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
Delegated by the user: use mature open-source components. Final stack determined after inspecting the Cebus implementation and package compatibility. Web and LINE share a server-authoritative chat core.

## Users
Primary: nontechnical people chatting with multiple AI companions. Secondary: developers working independently or collaboratively, and companies with knowledge and workflow needs. Public product, invited internal testing first.

## Product Purpose
One conversation with distinct AI members backed by GPT, Claude, Gemini or configured models. Point at a member, get independent views, or have a bounded discussion. LINE is a first-class entry point through one official account.

## Operating Context
User approved the proposal and delegated all implementation decisions. Deadline 2026-11-13 09:00 JST. User is sleeping and explicitly requested no interruptions before completion. Model tests may use the workspace CanalAPI credential file, which must never be committed, sent to the browser, or shown in logs.

## Capabilities and Constraints
Build a high-completion usable version, preserving room history, true model identity, stop behavior, limits, and workspace isolation. LINE live activation requires account credentials; do not fake a connected state. Advanced coding execution and enterprise write tools remain bounded by implemented controls.

## Brand Commitments
Agent Family, a friendly multi-agent group chat. Chinese-first UI, clear nontechnical copy, honest connection states. Name remains a working brand.

## Product Principles
- Reuse established libraries and official SDKs.
- Members stay distinguishable, and disagreement remains visible.
- Stop means no new work is scheduled.
- Secrets and authorization are server-owned.
- No false seed conversations, metrics, or connected badges.
