# V7.7.10g — Context Retention Plane / Semantic Working-Set GC

Status: **PLANNED / AFTER V7.7.10f ACCEPTANCE — implementation not started.**

## Why this slice exists

CairnStone already compresses durable knowledge and authority through Stones/LOD, sparse authority envelopes, deferred tool hydration, grounded response LOD, Conversation Sessions, Code Sessions/checkpoints, and content-addressed refs. What is still missing is a runtime mechanism that continuously reduces the **model-visible working set** during a long-lived conversation or code session without deleting the durable objects behind it.

The motivating pattern is Jev-style compaction: instead of rewriting an old conversation into a lossy prose summary, score older tool calls/results for whether the model still needs them. The reference implementation reviewed for this design is `tamaratran/fast-jev-compaction`, which asks a decision model whether each old tool call and result should remain and preserves ordinary conversation text. CairnStone should borrow the decision shape, not become dependent on Jev or import its authority model.

The target property is:

> **Semantically lossy active context, structurally lossless durable state.**

The reasoning model may forget bytes; CairnStone must retain enough exact identity and provenance to recover the object deterministically.

## Architectural position

V7.7.10g extends the Persistent Conversational Control Plane. It is not a replacement for:

- Stone LOD storage;
- V7.6 sparse bootstrap / Context Compiler;
- Deferred Tool Hydration / Tool Vault;
- grounded response LOD;
- Code Session checkpoints;
- immutable execution/authorization receipts;
- accepted project memory.

Those systems determine what exists, what is authoritative, what is accepted, and how exact content is retrieved. The Context Retention Plane determines only what subset of already-known working material should remain **inline in the next model-visible context projection**.

Conceptual flow:

```text
durable objects / authority / receipts / conversation turns
        ↓
retention artifact ledger
        ↓
candidate classification + deterministic pins
        ↓
optional decision scorer
(Jev / Workers AI / BYOK / deterministic heuristic)
        ↓
CairnStone retention policy
        ↓
PIN | KEEP_FULL | KEEP_REF | DROP_FROM_ACTIVE_CONTEXT
        ↓
bounded active-context projection
        ↓
reasoning model
        ↓
exact lazy rehydration by object/content ref when needed
```

Provider/model output is advisory evidence. CairnStone policy makes the final retention decision.

## Core contract

Working schema name: `cairnstone-context-retention-v1`.

A retention candidate should carry compact metadata such as:

- stable candidate/turn/tool identity;
- artifact class;
- current task / Conversation Session / Code Session binding;
- exact `object_ref` or content-addressed retrieval ref when available;
- source/provenance identity;
- byte/token estimate;
- last-use / dependency hints;
- whether the artifact is reproducible or only rehydratable;
- current-blocker / current-task relevance;
- authority/provenance protection flags;
- secret/capability classification;
- retention decision + reason + scorer evidence;
- rehydration route.

Initial decision set:

- **PIN** — must remain fully visible; policy/scorer cannot evict it.
- **KEEP_FULL** — keep full model-visible content for the current projection.
- **KEEP_REF** — remove bulky body, retain compact identity/summary/ref sufficient for exact rehydration.
- **DROP_FROM_ACTIVE_CONTEXT** — omit from the next model-visible projection while preserving any durable underlying object that already exists.

`DROP_FROM_ACTIVE_CONTEXT` is never permission to delete canonical or durable storage.

## Candidate classes

Initial candidates may include:

- completed tool calls and tool results;
- repository/file reads with immutable refs;
- CairnStone search/expand payloads;
- web/search evidence with stable refs where possible;
- hydrated tool schemas after the active tool phase ends;
- superseded intermediate analysis artifacts;
- repeated diagnostic output;
- bounded assistant-generated operational context that is recoverable from durable refs.

Normal user intent, current task text, unresolved blockers, active mutation guards, and recent turns should be pinned or strongly protected by deterministic policy before any scorer is consulted.

## Hard exclusions: never destructively compact

The retention plane must never delete, rewrite, or probabilistically redefine:

- chain HEADs or path HEADs;
- Stone content or Stone identity;
- immutable Git commit/source provenance;
- accepted skill identity/manifest/path heads;
- authorization requests, approvals/denials, or mutation guards;
- access grants/revocations/audit state;
- execution receipts, Work Receipts, or checkpoint evidence;
- Code Session checkpoints/task ledger authority;
- Scope/authority snapshot identities;
- grounded-response identity/evidence/claim skeleton;
- provider credential material or capability bearers;
- any object whose retention semantics are required by policy, audit, replay, legal, billing, or security invariants.

Secrets/capability bearers should not enter scorer-visible state at all.

## Retention artifact ledger

Do not repeatedly resend the full raw transcript to a decision model merely to decide what to remove. Compile a compact ledger first.

Example:

```text
t47 github.read
  ref=repo:nothinginfinity/foo@<sha>/src/a.ts
  bytes=31200
  current_task=false
  referenced_by_active_turn=false
  rehydratable=true

t48 sandbox.test
  receipt=receipt:xyz
  status=FAIL
  current_blocker=true
  rehydratable=true
```

The ledger is a runtime projection, not accepted-state authority. It should be content-identifiable where useful so repeated scorer calls can be cached/compared.

## Scorer interface

V7.7.10g should use the shared provider-neutral decision contract defined by **V7.7.10h — Semantic Capability Gateway / Decision Plane** once that contract exists, rather than creating a Jev-specific retention-only API. Until 10h is implemented, 10g.0/10g.1 may ship deterministic retention logic independently.

For retention, the shared decision kind is `retain` over a bounded artifact candidate set, with allowed actions `PIN | KEEP_FULL | KEEP_REF | DROP_FROM_ACTIVE_CONTEXT`.

An implementation may use:

- Jev / TypeSafe decision questions;
- Workers AI;
- an existing BYOK provider;
- deterministic heuristics;
- hybrid policy + model scoring.

The scorer may return probabilities/confidence for retention actions or narrower facts such as:

- does the call identity still matter?
- does the full result still matter?
- is exact rehydration sufficient?
- is this artifact still relevant to the active task?

The scorer never receives authority to delete storage, move HEADs, mutate project state, grant access, or execute tools.

## Deterministic retention policy

Model probabilities must be filtered through deterministic CairnStone policy.

Examples:

- policy-protected artifact → `PIN` regardless of model score;
- current blocker/test failure → at least `KEEP_REF`, usually `KEEP_FULL`;
- exact immutable/retrievable file body with no active dependency → eligible for `KEEP_REF`;
- redundant successful read already represented by a newer immutable ref → eligible for `DROP_FROM_ACTIVE_CONTEXT`;
- missing/ambiguous rehydration identity → cannot be dropped merely to save tokens;
- scorer failure/malformed output → fail safely to the prior context or deterministic-only policy.

No retention optimization may weaken V7.3 authorization, V7.6 authority parity, V7.7 session continuity, or evidence provenance.

## Rehydration

A compacted artifact should be recoverable through the narrowest exact route available:

- `stone:` / CairnStone ref expansion;
- `repo:owner/repo@sha/path`;
- checkpoint / receipt ID;
- Conversation Session turn/content ref;
- Code Session object;
- AC1/message ref where access policy allows;
- other content-addressed R2/D1 objects.

Rehydration must preserve the original identity/provenance and should not silently replace an old snapshot with current mutable state. If the original artifact cannot be recovered exactly, the retained ref must say so and policy should be more conservative about eviction.

## Relationship to V7.6

V7.6 reduces initial/bootstrap/schema context cost. V7.7.10g applies the same principle **over time** inside an active long-lived session:

```text
V7.6: transmit less at bootstrap
V7.7.10g: keep less inline as the session evolves
both: preserve exact underlying authority and provide deterministic expansion
```

This should integrate with context-cost telemetry so retention can be evaluated by measured token/byte reduction rather than intuition.

## Initial slices

- **V7.7.10g.0 — Retention contract + protected classes**
  - define `cairnstone-context-retention-v1`;
  - define candidate classes, protection rules, and action semantics;
  - prove zero accepted-state mutation.

- **V7.7.10g.1 — Artifact ledger + deterministic baseline**
  - compile compact ledger from Conversation Session / Code Session context;
  - implement deterministic PIN/KEEP_REF rules before any external scorer;
  - add context-size telemetry.

- **V7.7.10g.2 — Shared Decision Plane scorer integration**
  - consume the provider-neutral `cairnstone-decision-v1` / `retain` contract from V7.7.10h;
  - first pilot may use Jev while retaining deterministic fallback;
  - redact secrets/capabilities and bound scorer-visible state;
  - validate selections/actions against the deterministic retention candidate set;
  - record decision evidence/telemetry without granting authority.

- **V7.7.10g.3 — Exact lazy rehydration**
  - rehydrate selected refs into the active context;
  - snapshot-safe immutable retrieval;
  - negative cases for unavailable/stale refs.

- **V7.7.10g.4 — Cross-host/session acceptance**
  - ChatGPT + Claude + Grok or another independent host;
  - long-running Conversation Session and Code Session cases;
  - compare deterministic-only vs scorer-assisted retention;
  - verify continuity after fresh-chat/session resume.

## Acceptance

V7.7.10g is complete only when live acceptance proves:

- materially lower model-visible context bytes/tokens on long sessions;
- no chain/path HEAD, Stone, skill, receipt, grant, checkpoint, authorization, or provenance loss;
- compacted bodies can be lazily rehydrated by exact identity when promised;
- retained refs distinguish immutable snapshot retrieval from re-running against mutable current state;
- scorer failure degrades safely without corrupting the session;
- provider/model swaps do not change authority semantics;
- deterministic policy can override unsafe scorer recommendations;
- secret/capability material never enters scorer state;
- Conversation Session and Code Session continuity survive repeated compaction cycles;
- a fresh client can resume from durable refs without depending on the original model transcript;
- telemetry records before/after context size, decisions by reason, rehydration rate, scorer cost, and fallback rate;
- no implicit accepted-state mutation occurs anywhere in retention or rehydration.

## Non-goals

- Do not train or clone a Jev foundation model as part of this slice.
- Do not make TypeSafe/Jev a required CairnStone dependency.
- Do not replace Stone LOD or grounded-response LOD.
- Do not use probabilistic retention to decide accepted-state authority.
- Do not delete durable audit/provenance objects to save inference tokens.
- Do not promote ordinary conversation history into accepted project memory merely because it survived retention.

## Relationship to V7.7.10h

V7.7.10g owns **working-set retention semantics**. V7.7.10h owns the reusable **decision/capability-routing contract**. This avoids duplicating one Jev adapter inside compaction and another inside tool routing.

The intended sequence is compatible with incremental delivery:

```text
10f closes
  -> 10g.0 / 10g.1 deterministic retention can begin
  -> 10h.0 / 10h.1 shared decision contract + ask_jev pilot
  -> 10g.2 adopts 10h decision interface
  -> 10h expands to Tool Vault / Persistent Code Mode / retrieval / model-executor routing
```

Neither slice depends on Jev for correctness.

Reference inspiration: https://github.com/tamaratran/fast-jev-compaction
