# V7.7.11g — Safe Adaptive UI / Surface Composer

Status: **PLANNED / FOLLOW-ON WITHIN V7.7.11 — implementation not started.**

Primary implementation home: `nothinginfinity/cairnstone-v6-console`.

External design reference: `vercel-labs/json-render` at immutable commit `3ad381881194e7011ad3ccd6d668033495a06c29` (Apache-2.0), preserved in CairnStone chain `reference:vercel-labs/json-render`.

## Why this slice exists

CairnStone now has enough stable runtime primitives that its UI no longer needs to be one fixed pile of manually assembled cards for every possible state.

The useful idea from json-render is not “let an LLM write arbitrary UI.” It is the opposite:

- the application owns a bounded catalog of components and actions;
- UI is represented as declarative data;
- a renderer maps that data into trusted UI components;
- state/data bindings are explicit;
- specs are validated before rendering;
- partial/streamed updates can progressively materialize;
- actions remain separate from presentation;
- multiple renderers can share the same conceptual spec.

json-render's experimental Jev composer reinforces a pattern CairnStone already adopted in V7.7.10h: the application supplies bounded valid candidates, a decision model may choose/rank/group/order them, and deterministic code assembles/validates the result. Model choice is advisory composition, not authority.

This is a strong fit for CairnStone Console, especially Home, Work, Chat, Inbox, Guided Mode, and mobile/PWA surfaces.

## Product boundary

V7.7.11g does **not** replace the V7.7.9 Console UX architecture.

The stable human-designed shell remains authoritative for presentation rules:

```text
Chat · Work · Universe · Inbox · More
```

The distinct Authorize / Human Commit boundary remains visually and operationally protected.

Adaptive composition is allowed only inside registered **surface regions**, for example:

- Home dashboard card area;
- Chat contextual action/evidence tray;
- Work / Code Session summary region;
- Inbox priority/attention region;
- Guided Mode contextual panel;
- selected Universe/Scope detail panel;
- optional future product-specific Home surfaces.

The composer cannot remove required navigation, hide security-critical state, or turn a consequential action into an ordinary automatic button.

## Core principle

> **Models may compose trusted UI primitives; CairnStone owns the primitives, data, actions, policy, and authority.**

The first implementation should prohibit arbitrary model-generated HTML, JavaScript, CSS, event handlers, URLs with executable semantics, or unregistered component/action IDs.

## Canonical contracts

Working schemas:

- `cairnstone-ui-catalog-v1`
- `cairnstone-ui-surface-v1`
- `cairnstone-ui-surface-patch-v1`
- `cairnstone-ui-composition-receipt-v1`

### `cairnstone-ui-catalog-v1`

A versioned catalog of trusted render primitives and allowed action bindings.

Each component definition should describe at minimum:

```text
component_type
version
prop_schema
allowed_child_types
surface_regions
data_binding_classes
max_instances
accessibility requirements
presentation-only / interactive
```

Illustrative trusted components:

```text
MetricCard
StatusCard
TaskCard
CodeSessionCard
CheckpointCard
TestStatusCard
ActorCard
ThreadCard
EvidenceCard
ProvenanceCard
ScopeCard
AttentionCard
ActionProposalCard
HumanCommitCard
Stack
Grid
List
Section
Disclosure
EmptyState
ErrorState
```

The list is intentionally bounded. A model cannot invent a new component type merely because it can name one.

### Action catalog

Interactive components bind only to registered semantic actions.

Each action definition should include:

```text
action_id
action_class: navigation | read | proposal | mutation | execution
input_schema
availability predicate
policy route
human_commit_required
semantic target id
observable completion state
```

This action vocabulary should reuse V7.7.11e semantic UI target metadata and existing CairnStone intent/tool/policy contracts rather than creating a second execution system.

Examples:

```text
nav.open_work
nav.open_inbox
scope.inspect
code_session.open
checkpoint.inspect
evidence.expand
thread.open
give_access.propose
task.assign.propose
authorization.open
human_commit.review
```

A surface containing an action is not authorization to execute it.

## `cairnstone-ui-surface-v1`

A safe declarative rendered-surface description.

Illustrative shape:

```text
surface_id
surface_kind
surface_region
catalog_id / catalog_digest
context_snapshot
  scope_id / authority_digest when applicable
  conversation_id
  code_session_id
  checkpoint_id
  object refs
  freshness identity
root_id
elements{}
  id
  component_type
  props
  binding_refs
  children[]
  visibility / priority
  semantic_target_id
actions{}
layout_metadata
composition
  mode: deterministic | model_assisted
  provider/model or heuristic identity
  candidate_set_digest
  decision_receipt_ref
created_at
expires_or_refresh_policy
```

Presentation state is never accepted project authority.

## Surface candidate compiler

Before any model is consulted, CairnStone/Console compiles a bounded candidate set from current state.

Examples for a Code Session:

```text
current task
blocking test
latest checkpoint
working tree status
active actors / leases
latest receipts
pending proposal
relevant evidence
```

Examples for Home:

```text
runtime health
START HERE
unread inbox
pending human actions
active sessions
recent agent activity
current Scope
```

Each candidate has a stable ID, trusted component type, bounded props/data refs, priority hints, and allowed action IDs.

No scorer sees reusable credentials, capability bearers, authorization tokens, or unrestricted raw application state.

## Deterministic-first composition

The initial composer must work without any model.

Deterministic rules choose a safe default surface using:

- required components;
- severity / blocker status;
- recency where semantically valid;
- explicit user preferences / Saved View;
- viewport/surface constraints;
- accessibility constraints;
- bounded density limits;
- action risk class.

This deterministic baseline is the fallback for every model-assisted mode.

## V7.7.10h / Jev-assisted composition

After V7.7.10h exposes the shared Decision Plane, adaptive UI becomes another bounded consumer.

Potential decision kinds:

- `ui_select` — which approved candidate instances should be visible;
- `ui_group` — which candidates belong together;
- `ui_order` — priority/order inside a registered region;
- `ui_layout` — select from an explicit set of allowed layout templates.

The scorer receives candidate IDs and compact semantic metadata, not arbitrary executable UI source.

Example:

```text
candidate set
  A current failing test
  B latest checkpoint
  C active Grok task
  D old successful test
  E unread high-priority handoff

Jev / Decision Plane
  select A,B,C,E
  group A+B under "Current Work"
  order E,A,C,B
  layout = compact_stack

validator
  -> confirms IDs, layout, bounds, risk visibility
  -> renders trusted components
```

The scorer never creates an action ID, changes risk classification, grants capability, approves a mutation, or executes anything.

## Relationship to json-render

CairnStone should **adapt the architecture, not make json-render a required runtime dependency in the first slice**.

Useful patterns retained from the reference:

1. **Catalog-driven generation** — bounded trusted components/actions.
2. **Declarative tree/spec** — UI as validated data rather than arbitrary code.
3. **State bindings** — data references are explicit and can refresh independently from layout.
4. **Validation** — reject/fix invalid specs before interaction.
5. **Streaming/patching** — progressively update a surface without rebuilding everything.
6. **Action separation** — UI generation does not execute actions.
7. **Renderer portability** — one spec may later target Console/PWA/native surfaces.
8. **Devtools/inspection** — inspect what spec/candidates/decisions produced the UI.
9. **Jev-style bounded composition** — decision model chooses among application-supplied candidates rather than generating unrestricted UI.

An implementation spike may compare direct json-render package use against a CairnStone-native minimal renderer, but framework adoption requires measured value and must not force a Console rewrite.

## Streaming and patch safety

A later slice may stream `cairnstone-ui-surface-patch-v1` updates.

Every patch must:

- reference the exact current `surface_id` and prior revision;
- preserve stable element/action IDs;
- validate against the active catalog;
- stay within depth/element/byte limits;
- reject unknown component/action IDs;
- never silently rebind a consequential action;
- preserve required security/authority indicators;
- detect stale source/context identity.

If the underlying Scope, checkpoint, authorization, or other action-sensitive state changes, consequential actions should disable/re-resolve before use rather than remaining live against stale context.

## Human Commit / Authorize invariants

Adaptive UI must never weaken the trusted-human boundary.

- mutation/execution proposals remain visibly distinguishable from automatic reads/navigation;
- a composer may surface a pending Human Commit card but cannot approve it;
- required risk/material-effect text cannot be hidden by a layout decision;
- an adaptive layout cannot demote or visually disguise an authorization step;
- consequential actions use the existing proposal/authorization/guard/CAS paths;
- action execution produces the same receipts as non-adaptive UI;
- user-visible UI composition is never treated as proof that an action was authorized.

## Guided Mode / Simple Stone integration

V7.7.11e/11f already define semantic UI anchors and portable workflows.

Generated/adaptive elements should participate through the same semantic target registry.

A Simple Stone may target:

```text
work.current-task
work.test-blocker
inbox.needs-response
evidence.current
human-commit.review
```

but should not depend on fragile generated element instance IDs unless explicitly scoped to one surface revision.

The composer may arrange registered targets; it cannot change their meaning or risk class.

Guided Mode should be able to explain why a card is visible using the composition receipt.

## V7.7.11d general schema integration

The existing `Source + View + Action + Appearance` experiment becomes more concrete:

```text
Source
  -> trusted data adapter / current refs

View
  -> cairnstone-ui-surface-v1

Action
  -> registered semantic action / existing policy route

Appearance
  -> trusted renderer + theme + allowed layout template
```

This makes the Home Surface abstraction portable without turning presentation configuration into an execution system.

## Context Retention integration

V7.7.10g may retain a compact surface identity/spec/ref while large underlying data bodies leave active model context.

The active model can reason from:

```text
surface_id
visible element summaries
binding refs
current action states
composition receipt
```

and rehydrate exact source evidence only when needed.

Do not treat a UI spec as a substitute for underlying authoritative objects.

## Devtools / explainability

Add an operator/developer inspection mode inspired by json-render devtools concepts.

For any adaptive surface, expose:

- catalog/version identity;
- surface spec/revision;
- candidate set;
- deterministic required candidates;
- scorer/provider/decision receipt if used;
- selected/omitted candidates and reasons where available;
- data-binding refs/freshness;
- action IDs, risk classes, and policy routes;
- validation warnings/errors;
- fallback reason.

This should make “why am I seeing this card?” answerable without reading raw model prompts.

## Initial slices

### V7.7.11g.0 — UI catalog + safe surface schema

- define `cairnstone-ui-catalog-v1` and `cairnstone-ui-surface-v1`;
- seed a small set of existing Console primitives;
- define semantic actions by reference to existing Console/runtime routes;
- fixtures + validator;
- arbitrary HTML/JS prohibited.

### V7.7.11g.1 — Deterministic surface compiler + renderer prototype

- implement one bounded adaptive region, preferably Mobile Home or Code Session summary;
- deterministic-only selection/layout;
- stable fallback;
- iPhone + desktop rendering;
- no new runtime authority.

### V7.7.11g.2 — 10h/Jev advisory composition

- feed only bounded candidate metadata to shared Decision Plane;
- validate candidate IDs and layout enum;
- deterministic fallback on timeout/error/malformed/invented output;
- composition receipt;
- no action execution by scorer.

### V7.7.11g.3 — State bindings + validated incremental patches

- safe binding refresh;
- partial/streamed surface patch contract;
- stale-state invalidation;
- stable IDs/focus preservation;
- layout-jump/accessibility acceptance.

### V7.7.11g.4 — Actions + Guided Mode integration

- generated cards bind to existing semantic targets/actions;
- automatic read/navigation only where already policy-allowed;
- proposal/mutation/execution paths preserve existing Human Commit;
- Guided Mode can target/explain adaptive elements.

### V7.7.11g.5 — Devtools + cross-device acceptance

- inspect candidate/spec/decision/action state;
- deterministic vs model-assisted comparison;
- mobile/PWA + desktop;
- accessibility/reduced-motion;
- performance/context-cost telemetry.

## Acceptance

V7.7.11g is complete only when live acceptance proves:

- the stable V7.7.9 Console information architecture remains reachable and predictable;
- adaptive composition is confined to registered surface regions;
- every rendered component/action exists in the exact active catalog;
- unknown/invented component IDs, action IDs, or layout enums fail closed;
- deterministic mode produces useful surfaces without a model;
- scorer/model unavailability falls back safely;
- a Jev/10h scorer cannot execute an action or widen its risk/authorization class;
- arbitrary executable HTML/JS is not accepted in the initial surface contract;
- data bindings retain exact source/ref/freshness identity where required;
- stale action-sensitive state disables/re-resolves before consequential use;
- Human Commit / Authorize remains visually distinct and operationally identical to the existing authority path;
- rendering/composition alone moves zero chain/path HEADs and grants zero capabilities;
- Guided Mode semantic targets remain stable across deterministic/model-assisted layouts;
- at least one surface (Home or Work) demonstrates materially improved relevance/density without hiding supported capability;
- iPhone and desktop preserve keyboard/focus/touch accessibility;
- composition receipts explain candidate set, selection mode, scorer/fallback, and action policy;
- framework adoption (json-render package or otherwise) is evidence-based rather than mandatory.

## Repository placement

Keep this in the CairnStone/Console workstream.

Do **not** create a new canonical repository for the adaptive renderer yet.

If the same surface spec/catalog/renderer later powers at least three distinct products/sources and its release lifecycle separates naturally from Console, apply the existing V7.7.11 standalone-repo extraction gate.

## Non-goals

- no LLM-generated arbitrary application code;
- no replacement of the V7.7.9 fixed shell/navigation contract;
- no second tool/action authorization system;
- no UI-generated accepted project state;
- no hidden automatic mutation;
- no raw secret/capability-bearing scorer context;
- no forced React/framework rewrite of the current Console;
- no dependency on Jev for correctness;
- no claim that json-render source itself is CairnStone authority.
