# V7.7.8 — Progressive Grounded Chat LOD

Status: **IN PROGRESS — V7.7.8a/b implemented in-repo; V7.7.8c/d deferred**
Slice: `V7.7.8`
Implementation started: `true`
Activation gate: V7.7.7 Persistent Code Mode is sufficiently stable that chat answers can bind to one durable Scope / authority snapshot without inventing a second continuity model.

**Implemented now:** `docs/V7_7_8A_GROUNDED_RESPONSE_CONTRACT.md` (V7.7.8a contract + deterministic identity; V7.7.8b lazy LOD renderers/expand).
**Deferred:** V7.7.8c Console Answer Depth UX; V7.7.8d cross-provider/stale acceptance polish.

## Product thesis

CairnStone should make complexity **zoomable**.

The default chat response should be the smallest sufficient grounded answer. The user can then expand the *same answer* through progressively deeper levels of detail without asking the model to independently regenerate a longer answer from scratch.

Core interaction:

```text
user question
  -> resolve Scope / accepted authority snapshot
  -> retrieve bounded evidence
  -> compile one grounded answer object
  -> render response_lod 1
  -> expand the same answer object on demand to response_lod 2..5
```

The design principle is:

> **CairnStone complexity grows inward, not outward.**

The runtime may use deep accepted-state context, multi-chain Scope, evidence, model routing, tools, Code Sessions, receipts, and persistent memory, while the user still receives a concise default answer.

## Naming / semantic separation

CairnStone already has a Stone storage LOD ladder where `lod5` is the cheapest summary and `lod1` points toward raw/deep content.

Chat response LOD intentionally uses the human-facing direction:

- `response_lod: 1` = shortest / smallest sufficient answer
- `response_lod: 5` = deepest grounded explanation

Do not silently overload the existing Stone LOD field. Keep these as separate typed concepts:

```text
stone_lod      = lod5 -> lod1   # storage retrieval: cheap -> deep/raw
response_lod   = 1 -> 5         # human answer depth: concise -> deep
```

The Console may label `response_lod` simply as **LOD** or **Answer Depth**.

## Response LOD contract

### LOD 1 — Answer

Default.

Typical content:
- direct answer;
- next action / conclusion;
- one important blocker or caveat when material.

Target: usually 1–3 short sentences.

### LOD 2 — Context

Adds:
- why the answer is correct;
- current state;
- major dependency / blocker;
- minimal roadmap or project context.

### LOD 3 — Evidence

Adds:
- relevant START HERE / roadmap / accepted Stone identities;
- chain / repo / path / immutable commit provenance;
- accepted-vs-historical authority classification;
- important citations / receipts.

### LOD 4 — Analysis

Adds:
- architecture implications;
- alternatives considered;
- risks / tradeoffs;
- unresolved decisions;
- why the selected next action dominates nearby alternatives.

### LOD 5 — Deep trace

Adds the bounded deepest useful explanation:
- complete evidence set used by the answer;
- authority snapshot identity;
- provenance and receipt trail;
- relevant historical decisions;
- detailed technical reasoning and failure/recovery context.

LOD 5 remains bounded. It is not permission to dump the entire vault or raw repo into the chat.

## One grounded answer object, not five independent answers

The central invariant is that LOD expansion must preserve one answer identity.

Define a provider-neutral response record, working name:

`cairnstone-grounded-response-v1`

Minimum identity/state:

- `response_id`;
- user question identity / normalized question;
- actor / thread / optional Code Session identity;
- exact `scope_id`;
- exact accepted `authority_digest` / participating chain HEAD snapshot;
- evidence-set identity / digest;
- answer-skeleton identity;
- conclusion / direct answer;
- claims;
- evidence refs;
- uncertainty / caveats;
- next action;
- generated-at metadata;
- highest materialized `response_lod`;
- provider/model envelope for generated prose;
- explicit zero accepted-state mutation authority.

LOD 2–5 must expand this same answer object. They must not independently re-run an unconstrained "answer again, but longer" prompt that can silently change the conclusion or evidence basis.

A useful conceptual shape:

```text
Question
  -> Scope snapshot
  -> Evidence set
  -> Grounded answer skeleton
       conclusion
       claims
       evidence
       uncertainty
       next_action
  -> LOD renderers 1..5
```

Provider/model may change between expansions only if the response identity, authority snapshot, evidence identity, and claim contract remain preserved and the change is visible in the outer envelope.

## Freshness / authority race behavior

An answer expansion is snapshot-bound.

If accepted authority changes after LOD 1 is generated but before the user opens a deeper LOD:

- do not silently mix old and new accepted state;
- surface `stale_response` / `authority_changed`;
- allow **View original snapshot**;
- allow **Refresh answer** against the new authority;
- a refresh creates a new `response_id`.

The user must be able to distinguish "expand this answer" from "recompute using current project state."

## Progressive generation / cost behavior

Do not eagerly generate all five levels.

Preferred flow:

1. resolve authority and evidence once;
2. compile the answer skeleton;
3. materialize LOD 1;
4. generate/render deeper levels only when requested;
5. cache identity-bound materialized levels when safe;
6. invalidate/recompute only under explicit refresh or authority/evidence mismatch.

This should reduce model output tokens, network transfer, visual clutter, and inference cost while preserving deep inspectability.

## Console UX

Default chat cards should be mobile-first and compact.

Example:

```text
Next: V7.7.8 — Progressive Grounded Chat LOD.

Default CairnStone chat answers become concise, snapshot-grounded responses
that can expand through deeper evidence and analysis without changing answer identity.

Authority: Current ✓    Evidence: 3 refs

LOD 1   [2] [3] [4] [5]
```

Supported user interaction should include both controls and natural language:

- tap `2`, `3`, `4`, or `5`;
- "LOD 3 that.";
- "Give me the LOD 5 version.";
- "Keep this conversation at LOD 1 unless I expand.";
- "Use LOD 2 by default for this Code Session."

A stored user/session default is presentation state only and never accepted project authority.

## Scope and Persistent Code Mode integration

V7.7.8 should compose existing/future primitives rather than inventing parallel state:

- V7.7 Scope selects the bounded project/repo/chain universe;
- grounded search/Q&A provides evidence and citation validation;
- V7.7.7 Code Session / checkpoints may supply durable task and working-state context;
- AC1 may carry response/handoff refs;
- V7.3 tool receipts and authorization evidence may appear in deeper LODs;
- GitHub remains immutable source/version-control provenance;
- CairnStone chain/path HEADs remain accepted-state authority.

Ordinary non-code questions must still support response LOD without requiring a Code Session.

## Initial implementation sequence

1. **V7.7.8a — Response contract + deterministic identity**
   - define `cairnstone-grounded-response-v1`;
   - bind response to Scope / authority / evidence / claim skeleton;
   - define race and refresh semantics.

2. **V7.7.8b — LOD renderers + lazy expansion**
   - LOD 1–5 output contracts;
   - lazy materialization;
   - stable answer identity;
   - bounded output budgets and cost telemetry.

3. **V7.7.8c — Console Answer Depth UX**
   - LOD controls on every grounded chat response;
   - natural-language expansion;
   - mobile-first presentation;
   - per-thread / per-Code-Session default depth.

4. **V7.7.8d — Cross-provider + stale-state acceptance**
   - provider swap while preserving response identity/evidence;
   - accepted-state change between LOD expansions;
   - original-snapshot vs refresh behavior;
   - real multi-repo / roadmap / Code Session examples.

## Acceptance

V7.7.8 is complete only when live acceptance proves:

- default response is LOD 1 and materially shorter than a conventional full answer;
- LOD 2–5 expand the same `response_id` and same answer/evidence identity;
- no LOD expansion silently changes accepted authority or mixes authority snapshots;
- an authority change after LOD 1 is detected before deeper expansion;
- refresh creates a new response identity while original-snapshot expansion remains inspectable;
- all claims/citations shown in evidence-bearing levels resolve to supplied evidence;
- user can move from LOD 1 -> 5 without re-asking the original question;
- natural-language commands such as "LOD 3 that" work;
- per-thread/session default depth affects presentation only;
- deeper levels are lazy, not eagerly generated by default;
- output/token telemetry demonstrates the default path avoids unnecessary verbose generation;
- single-chain, multi-chain Scope, roadmap, and Persistent Code Mode questions all work;
- provider/model swapping does not change response authority/evidence identity;
- response generation and expansion cause zero implicit chain/path-HEAD mutation;
- Stone storage LOD semantics remain unchanged and are never confused with response LOD.

## Non-goals

- No replacement of Stone LOD storage semantics.
- No five independent model answers for one question.
- No raw vault/repo dump merely because LOD 5 was requested.
- No auto-refresh that silently discards the snapshot the user was reading.
- No model-selected accepted-state authority.
- No requirement that every response persist permanently as a Stone.
- No requirement for Persistent Code Mode on ordinary informational chat.

## Roadmap placement

`V7.7.8` follows `V7.7.7 — Persistent Code Mode / Durable Multi-Agent Code Sessions`.

It should **not** preempt or move the active V7.7.6 credential/invitation lifecycle work. Until V7.7.7 reaches the activation conditions defined by its own roadmap Stone, this item remains an accepted future roadmap slice rather than the canonical START HERE.

The first bounded implementation step when activated is:

**V7.7.8a — Grounded Response Contract + deterministic answer identity.**

After V7.7.8d is live-accepted, the planned UX continuation is **V7.7.9 — Console UX Architecture + Responsive Shell**. V7.7.8c owns the first Answer Depth UI; V7.7.9 then incorporates that accepted response-LOD contract into the whole-Console information architecture, Chat-first shell, Work surface, communications consolidation, progressive disclosure, and Bird's Eye / Universe v2. Canonical follow-on contract: `docs/V7_7_9_CONSOLE_UX_ARCHITECTURE.md`.
