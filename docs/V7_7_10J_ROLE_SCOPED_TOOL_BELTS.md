# V7.7.10j — Role-Scoped Tool Belts / Capability Profiles

Status: **PLANNED / CONTRACT + THREAT-MODEL NEXT.**

Implementation authority: **design, linting, and read-only/draft-only prototype work may proceed after the V7.7.10i.0 independent review. Production account-bound mutation-capable activation remains gated on V7.7.10i identity/auth acceptance.**

Parent roadmap: `docs/ROADMAP_V7.md`.

Related accepted architecture:

- V7.3 Permissioned Agent Loop / MCP Tool Broker;
- V7.4 provider-neutral agent profiles;
- V7.6.2 Deferred Tool Hydration / Tool Vault + `/mcp/core`;
- V7.7 Scope, Persistent Code Mode, Conversation Sessions, Task Runs, executors;
- V7.7.10h Semantic Capability Gateway / Decision Plane;
- V7.7.10i CairnStone Account Identity + Connector-Bound Authorization;
- V7.9 Skills vNext / Capability Recipes.

Design input was independently reviewed by Claude, ChatGPT, and Perplexity through AC1 on 2026-09-20. The common conclusion is that the primitive should be larger than route-scoped MCP allowlists: it should be an accepted, versioned **capability projection** that combines role-level tool reachability, accepted skills, scope constraints, and policy ceilings without becoming a second authority system.

---

## 1. Thesis

CairnStone should be able to construct stable agent roles independently of the underlying LLM provider.

```text
model / reasoning engine
  + accepted Tool Belt
  + accepted Skill Pack
  + Scope / Stones
  + CairnStone account + actor / connection principal
  + object grants + broker policy
  + session / checkpoints / receipts
  = CairnStone-constructed agent
```

The model supplies reasoning. CairnStone defines the model's reachable operational world, authoritative knowledge, permitted operations, and evidence trail.

Tool exposure is therefore part of the agent's operational context. A reviewer that never receives source-mutation capabilities is more strongly constrained than a reviewer that merely receives an instruction saying not to edit. The same principle should reduce tool-selection ambiguity, schema/context pressure, and accidental out-of-role behavior.

---

## 2. Tool Belt is not a URL

A route such as `/mcp/t/reviewer` may be useful as a client-facing selector, but it is not the Tool Belt itself.

A Tool Belt is a versioned accepted artifact, working schema name:

`cairnstone-tool-belt-v1`

The route is transport. Identity comes from V7.7.10i. Authority comes from the intersection of authenticated principal, grants, belt policy, broker policy, object/Scope constraints, and runtime state.

`/mcp-b` remains only the client tool-catalog cache twin and must never acquire semantic belt meaning.

`/mcp/core` remains the universal bounded bootstrap / deferred Tool Vault profile. Tool Belts constrain what that surface may discover, hydrate, or execute for a role.

---

## 3. Authority model

Effective authority is an intersection:

```text
effective capability
  = account grant
  ∩ authenticated actor / connection principal
  ∩ accepted Tool Belt policy
  ∩ object / Scope grant
  ∩ canonical broker policy + authorization mode
  ∩ live tool availability / contract integrity
  ∩ runtime / session state
```

Hard rule:

> **A Tool Belt may narrow authority but can never widen authority.**

Consequences:

- possession or discovery of a belt URL grants nothing;
- selecting a belt cannot bypass account, workspace, mailbox, object, Scope, tool, mutation, execution, or economic authorization;
- a belt may exclude a tool that an account could otherwise use;
- a belt may never make a tool executable when the canonical broker would deny or require stronger authorization;
- mutation/execution authorization remains independent even when a mutation-capable tool is intentionally included in a role;
- model intent, Decision Plane scoring, skill selection, payment, and route selection remain non-authoritative.

---

## 4. Accepted-state authority and storage

Production belt definitions should follow the same authority discipline as accepted skills:

```text
Git/versioned candidate
  -> deterministic lint / compatibility checks
  -> immutable source identity
  -> CairnStone Stone
  -> accepted path HEAD
  -> compiled runtime cache
```

D1/KV/R2 may cache a compiled belt for performance, but cache state is never authority.

A belt artifact should carry at minimum:

```text
schema
belt_id
version
title
role_class
status
tool_policy
  allow_tool_ids[] / allow_capability_ids[]
  deny_tool_ids[] / deny_capability_ids[]
  max_risk_class
  allowed_authorization_modes[]
skills
  accepted_skill_ids[]
  optional bundle constraints
scope_policy
  allowed scope modes / project constraints
session_policy
  hydration / list-change behavior
privilege_ceiling
compatibility
  minimum runtime / required broker contract versions
revocation / supersession metadata
provenance
```

Tool schemas themselves are not copied into the belt. The canonical contract remains the live Tool Vault contract and its deterministic `schema_hash`.

---

## 5. Canonical tool + belt resolution

The Tool Vault remains the complete capability catalog. The belt is a projection over it.

Resolution should be deterministic:

```text
accepted belt
  -> resolve referenced tool/capability IDs
  -> join canonical live Tool Vault contracts
  -> join broker classification / authorization
  -> verify schema / classification agreement
  -> resolve accepted skills
  -> lint skill requires_tools / capability closure
  -> intersect account + actor + object/Scope grants
  -> compile effective role surface
```

Fail closed when:

- a referenced tool is missing;
- a supposedly executable tool is unclassified;
- live schema disagrees with the broker classification record;
- a required accepted skill is missing or superseded unexpectedly;
- a skill dependency requires a tool/capability outside the belt;
- a belt claims an authorization mode weaker than the broker;
- a runtime/client cannot enforce the profile safely.

---

## 6. Discovery and execution enforcement

`tools/list` filtering improves context but is not a security boundary.

The active belt must be enforced independently at every relevant boundary:

- `tools/list`;
- direct `tools/call`;
- Tool Vault search;
- `cairnstone_get_tool_contract`;
- native `cairnstone_load_tools` hydration;
- V7.7.10h capability routing / candidate generation;
- broker policy preview;
- authorization preparation / request;
- generic `cairnstone_tool_execute`;
- delegated read loops / executor routing where applicable.

Generic primitives are particularly important. A restricted belt that exposes `tool_search` or `tool_execute` without constraining those operations would create an escape hatch.

Native hydration may only add a tool already allowed by the active belt. `notifications/tools/list_changed` may change model-visible schemas but never widen the belt's authority universe.

---

## 7. Skills + Tool Belts

Skills and Tool Belts are complementary:

```text
Tool Belt = WHAT this role can discover / hydrate / invoke
Skill Pack = HOW this role should use those capabilities
Scope/Stones = WHAT this role knows and which state is authoritative
Account/Auth = WHO is wielding the role
Broker/Grants = WHAT authority is usable now
```

An accepted Tool Belt may name a default accepted Skill Pack or skill set. Belt linting should verify:

- every `requires_tools` / future `requires_capabilities` dependency resolves inside the belt;
- dependency closure cannot silently widen the tool set;
- behavioral skills do not imply execution capability;
- a capability recipe may request capability but never grant it;
- skill and belt versions are carried into downstream context/receipt identity.

V7.9 may later generalize these relationships into abstract capability recipes, but 10j should not wait for V7.9 to establish the role-level projection and enforcement boundary.

---

## 8. Relationship to V7.7.10h Decision Plane

The Decision Plane chooses among valid doors; the Tool Belt defines which doors may exist for the role.

```text
accepted Tool Belt
  -> deterministic belt-valid candidate set
  -> V7.7.10h scorer / deterministic selector
  -> validated choice
  -> existing broker / authorization
```

A scorer cannot introduce an out-of-belt tool, capability, skill, model, executor, or permission.

Tool Belts are primarily **role-time narrowing**. V7.7.10h is primarily **task-time selection** within the valid role surface.

---

## 9. Relationship to V7.7.10i identity

V7.7.10i remains P0.

Tool Belt contract, linter, accepted-state representation, and read-only/draft-only prototypes can proceed after the 10i.0 independent review. Production binding of a belt to an account/connector/actor—especially any mutation-capable belt—must use the server-derived account / connection-principal identity from 10i.

Required production binding concept:

```text
authenticated CairnStone account
  -> connection principal
  -> allowed role/belt assignments
  -> selected accepted belt version
  -> object / workspace / Scope grants
  -> effective capability intersection
```

Reconnect may preserve an account-owned role assignment while a reinstall creates a new connection principal. The belt must not use a connector URL, provider account name, wallet address, or actor alias as the durable identity root.

---

## 10. Session, caching, and client behavior

Clients cache MCP tool lists aggressively and inconsistently. A belt system must therefore separate correctness from client refresh behavior.

Requirements:

- session capability state should be namespaced by endpoint/profile + `belt_id` + belt version/hash + authenticated principal when 10i is active;
- one belt session must never bleed hydrated tools into another belt;
- reconnect/reinstall semantics must be explicit;
- changing a belt behind a stable connector URL may leave a client with stale `tools/list`; prefer immutable/versioned profile identity or explicit reconnect/version-bump behavior;
- portable generic Tool Vault execution remains the correctness fallback when native list refresh is unsupported;
- stale client display must not translate into server-side widened authority.

---

## 11. Receipt / audit envelope

Every execution/read/checkpoint path that acts through a belt should be able to answer:

> Why was this exact actor able to use this exact capability against this exact scope at this exact moment?

Receipts should therefore preserve or reference:

- account / connection principal identity;
- actor identity;
- immutable `belt_id` + version + content/Stone identity;
- accepted Skill Pack identity/version;
- Scope/object grant identities;
- tool ID + canonical contract `schema_hash`;
- broker risk class + authorization mode;
- policy/authorization result;
- session / task / conversation / code-session identity where applicable;
- execution/result identity.

Revoking or superseding a belt must not erase historical receipts.

---

## 12. Threat model

Minimum negative cases:

- direct call of a hidden/out-of-belt tool name;
- generic Tool Vault search discovers an out-of-belt capability;
- generic execution attempts an out-of-belt tool;
- native hydration requests an out-of-belt tool;
- Decision Plane scorer returns an out-of-belt candidate;
- a Skill Pack dependency references an out-of-belt tool;
- URL guessing/selecting a privileged belt without account assignment;
- stale belt cache after revocation/supersession;
- session fixation or cross-belt session reuse;
- account A attempts to activate B's belt assignment;
- role changes during an in-flight authorization;
- schema/classification drift between belt acceptance and execution;
- downgraded authorization metadata;
- connector reconnect/reinstall accidentally inherits the wrong principal;
- `/mcp-b` or another cache alias is mistaken for a privileged belt.

All fail closed without widening authority.

---

## 13. Initial role cohort

### researcher / read-only

Examples: Scope resolution, accepted-state retrieval, grounded Q&A, evidence inspection, explicitly granted correspondence reads. No source/workspace/HEAD mutation.

### reviewer / read-only

Examples: repo/Stone diff, CI/test/release evidence, provenance inspection, policy/authorization status. No source mutation.

### code-engineer / draft-only

Examples: workspace and Code Session reads, bounded draft writes/patch preparation, local test/build/lint execution where already authorized, checkpoints and proposal artifacts. No merge, deploy, chain/path HEAD movement, production economic action, or privileged release operation.

Privileged release/deploy/operator belts are deferred until 10i identity + revocation + authorization are accepted live.

---

## 14. Implementation slices

### V7.7.10j.0 — contract + threat model

Freeze `cairnstone-tool-belt-v1`, authority-intersection semantics, role/route/identity separation, revocation/supersession, audit envelope, negative fixtures, and independent review.

### V7.7.10j.1 — deterministic resolver + linter

Resolve accepted belt artifacts against canonical Tool Vault contracts, broker classification, and accepted skills. Fail closed on missing tools, unclassified executable tools, schema disagreement, invalid skill closure, authorization downgrade, or stale accepted identity.

### V7.7.10j.2 — read-only activation

Expose belt-filtered native `tools/list` plus belt-constrained Tool Vault discovery/hydration and matched accepted Skill Pack/context. Prove researcher + reviewer roles without mutation.

### V7.7.10j.3 — server-side enforcement

Enforce the belt beneath `tools/call`, search, contract hydration, native hydration, Decision Plane candidate generation, broker preview, authorization preparation, and generic execution. Add belt identity to sessions and receipts.

### V7.7.10j.4 — code-engineer draft-only + identity binding

Introduce the draft-only engineering profile and bind role assignment to V7.7.10i account/connection principals. Prove revocation, reconnect, reinstall, and workspace/object grant intersections.

### V7.7.10j.5 — cross-model acceptance + harness evaluation

Run the same representative tasks across ChatGPT, Claude, Grok, Perplexity, and at least one lower-cost/local/Workers-AI-class model using identical belt/skill/scope packages.

### V7.7.10j.6 — privileged role gate

Only after 10i production identity acceptance, test narrowly privileged release/operator belts. Prove no self-widening, no route-secret authority, no generic Tool Vault escape, and preserved human-confirmation / scoped-grant boundaries.

---

## 15. Harness evaluation

The architectural hypothesis should be measured rather than assumed.

Compare broad/full tool surfaces against belt-scoped surfaces using:

- serialized tool-schema/context bytes and estimated tokens;
- unnecessary tool calls;
- invalid/out-of-role calls;
- policy denials;
- model turns / latency to first correct action;
- tool-selection accuracy;
- task completion quality;
- verification success;
- cross-model variance;
- cost per verified outcome where measurable.

A useful result would show that role-bounded capability surfaces plus accepted skills reduce operational ambiguity enough that smaller/cheaper models can reliably perform tasks that otherwise require a stronger model or broader prompt context.

---

## 16. Acceptance gate

10j is not complete until live acceptance proves:

- accepted belt artifact identity and path-HEAD authority;
- cache is non-authoritative;
- belt can narrow but never widen account/broker/object authority;
- hidden tool direct-call denial;
- generic search/hydration/execute cannot escape the belt;
- native hydration cannot escape the belt;
- Decision Plane cannot select outside the belt;
- skill dependency closure cannot widen the belt;
- schema/classification drift fails closed;
- read-only researcher and reviewer roles are genuinely read-only;
- code-engineer is draft-only with no merge/deploy/HEAD/economic authority;
- account/connection-principal binding and revocation work after 10i;
- receipts reconstruct belt + skill + scope + identity + tool-contract + authorization context;
- cross-model acceptance passes with the same role contract;
- `/mcp/core` portable fallback remains functional;
- `/mcp-b` remains a transport/cache alias only.

Until then, existing `/mcp`, `/mcp/core`, broker, authorization, Skills, Scope, and V7.7.10i identity boundaries remain authoritative.
