# V7.7.11h — Host-Native Plugin / App Surfaces + Mini-Stone Workflow Products

Status: **ROADMAP-ACCEPTED / DESIGN-FIRST.** This slice extends V7.7.11 Guided Mode / Simple Stones into host-native ChatGPT-style app/plugin surfaces without making any single host's recommendation/ranking system part of CairnStone correctness.

## Motivation

Current AI hosts increasingly surface apps/plugins inside normal conversation. That creates a distribution window for narrow utilities that solve a recognizable task at the moment the user needs it. CairnStone should exploit that window with thin host-native surfaces backed by provider-neutral durable state.

The durable product is **not the plugin**. The plugin is a host adapter over CairnStone.

## Core decision: mini-stones are constrained Stones, not a second persistence layer

A `mini-stone` is a compact workflow/product contract carried by the existing Stone system. It should use normal Stone identity, provenance, chain/path placement, LOD, graph edges, path HEADs where accepted state is intended, and existing AC1/Scope semantics.

Candidate `cairnstone-mini-stone-v1` fields:

- `kind`: workflow | meeting | decision | handoff | hypothesis;
- `title`;
- `user_intent`;
- `inputs`;
- `outputs`;
- `steps`;
- `success_criteria`;
- `evidence_refs`;
- `related_refs`;
- `status`;
- optional `supersedes` / `documents` / `references` edges.

Mini-stones do not gain execution authority merely because a host app created them. Operational/session state may remain non-authoritative until explicitly accepted.

## Host architecture

```text
conversation trigger / app recommendation
  -> thin host-native plugin/app surface
  -> semantic CairnStone operation
  -> mini-stone contract validation
  -> user/account chain or workspace
  -> normal Stone/AC1/Scope persistence
  -> optional rich UI panel
  -> same artifact reusable from ChatGPT, Claude, Grok, Console, or future hosts
```

Host metadata, ranking, sidebar placement, or recommendation eligibility are distribution inputs only. They never become accepted-state authority.

## Initial product cohort

### 1. Meeting Notes Compressor — P0 distribution candidate
Natural trigger phrases:
- "summarize these meeting notes"
- "pull out decisions and action items"
- "save what we decided"
- "update the notes from this meeting"

Output: compact meeting mini-stone with LOD summary, decisions, actions, owners/dates when present, source refs, and supersedes links for later meeting updates.

Why first: high-frequency, low-explanation workflow; obvious mid-conversation trigger; strong persistence value.

### 2. Decision Log — P0 distribution candidate
Natural trigger phrases:
- "record this decision"
- "save why we chose this"
- "what did we decide and why?"
- "log the alternatives we rejected"

Output: immutable decision mini-stone containing decision, alternatives, evidence, rationale, date/actors, and related Stone refs.

Why first: maps directly to CairnStone's strongest provenance/graph model and demonstrates durable reasoning continuity.

### 3. Handoff Pack — P0/P1 distribution candidate
Natural trigger phrases:
- "make a handoff"
- "summarize this so another AI can continue"
- "create a start-here for my teammate"
- "what does the next agent need to know?"

Output: bounded start-here mini-stone with current identity, open questions, next actions, relevant refs, and AC1-ready continuation metadata.

Why first: uniquely differentiating cross-model value; especially strong for long-running software/research work.

### 4. Workflow-to-Stone — P1
User describes a repeated manual task; app produces a reusable workflow mini-stone with inputs, outputs, steps, success criteria, required capabilities, and verification expectations.

Externally, avoid CairnStone jargon in discovery copy. Prefer "turn this workflow into a reusable playbook" over "create a Stone."

### 5. Plugin Idea Scout — P2 / internal growth tool
Given a domain, produce several host-app concepts using literal user-language phrases plus a hypothesis mini-stone containing target trigger, expected user value, monetization assumption, and traction metric.

Useful for CairnStone's own distribution experiments; weaker as the first public app.

## Distribution ranking

Recommended initial shipping order:

1. Meeting Notes Compressor
2. Decision Log
3. Handoff Pack
4. Workflow Playbook
5. Plugin Idea Scout

The first three map to recognizable conversational intents and require little explanation. Handoff Pack is the strongest differentiator even if Meeting Notes has broader demand.

## Monetization shape

Do not charge for the act of creating one small artifact. Monetize the durable network around it:

- free: create/view a bounded number of personal mini-stones;
- paid individual: larger persistent history, cross-session retrieval, richer exports, advanced LOD/evidence, reusable workflows;
- team: shared workspace chains, decision/handoff history, permissions, team search, audit/provenance;
- creator/developer: packaged workflow profiles / capability recipes / distribution analytics;
- later: paid execution through existing CairnStone economic-authority boundaries, never through plugin presence itself.

## Security and authority invariants

- host recommendation != authorization;
- app installation != CairnStone account authority;
- mini-stone creation != accepted-state promotion unless the workflow explicitly performs the normal acceptance boundary;
- model intent != execution authority;
- no plugin may bypass V7.7.10i account/connection identity or V7.3/V7.7.10e mutation/commit policy;
- host-private data is stored only under explicit access and provenance rules.

## Acceptance

V7.7.11h is accepted only when:

- at least three host-native workflow surfaces map to one provider-neutral mini-stone contract;
- the same mini-stone can be created in one host and read/continued in another;
- ranking/recommendation changes in a host do not alter artifact identity or availability;
- repeated meeting/decision/handoff updates produce deterministic graph/version relationships;
- host uninstall/reinstall does not destroy account-owned durable state;
- mobile use works without requiring the CairnStone Console for the normal path;
- plugin surfaces preserve existing identity, access, mutation, execution, and economic-authority boundaries.

## Source context

Originating AC1 message:
- message: `msg:47e34fc0-ee1f-44b4-9902-5c66111d82d2`
- thread: `chatgpt-plugins-cairnstone-mini-stones-2026-10`
- source Stone: `2953150bdf5e0e2cb34c4a5aa5a194b784a39c3705c3eb680059f6bec37333dd`

This slice is intentionally complementary to V7.9 Skills vNext: mini-stones are compact durable workflow/product state; accepted capability recipes define how executable workflows are performed and verified.
