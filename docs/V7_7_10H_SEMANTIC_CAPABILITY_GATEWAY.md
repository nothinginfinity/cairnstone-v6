# V7.7.10h — Semantic Capability Gateway / Decision Plane

Status: **IN PROGRESS — V7.7.10h.0 decision contract is under implementation; first-party Workers AI scoring is the next planned scorer slice.**
Relationship: V7.7.10g Context Retention is the first major consumer; V7.7.10h generalizes the same bounded decision pattern across tools, retrieval, models, executors, and Persistent Code Mode.

## Thesis

CairnStone should add a small, provider-neutral **decision plane** for typed, bounded choices.

The motivating observation from Jev is not merely that a small model can compact context. The more general capability is that a small decision-oriented model can cheaply answer questions such as:

- which valid tool/capability best fits this request?
- which snippets should be expanded?
- should a result stay resident, become a ref, or leave active context?
- should this request use deterministic utility execution, retrieval, a larger reasoning model, or a coding executor?
- which already-valid candidate should be selected?
- should the system escalate, rehydrate, continue, or stop?

The large reasoning model should do difficult synthesis/reasoning. The decision plane should perform **small typed judgments between deterministic choices**.

CairnStone remains the gateway and authority boundary. CairnStone-native Workers AI is the default first-party model-assisted scorer path. Jev and BYOK small models remain optional interchangeable scorer adapters behind the same contract, never authority systems.

## Architectural position

V7.7.10h sits across existing CairnStone routing/runtime layers:

```text
natural-language task / agent state
        ↓
deterministic candidate generation
(Tool Vault / capability registry / Scope / executor/model registry)
        ↓
cairnstone-decision-v1
        ↓
decision ladder
(deterministic clear winner -> Workers AI -> optional Jev/BYOK/stronger scorer)
        ↓
validated typed decision
        ↓
CairnStone policy + authorization
        ↓
hydrate / read / retrieve / route / propose
        ↓
receipt + exact provenance
```

The decision plane must never become a second tool registry, skill authority, executor registry, model registry, Scope authority, or accepted-state authority.

## Core invariant

> **The model may choose among valid doors; CairnStone decides which doors exist and whether they may open.**

A scorer may rank or select only from a deterministic candidate set. It cannot invent a tool, capability, model, executor, skill, source, or mutation target and have that invention become executable.

## Canonical contracts

Working schemas:

- `cairnstone-decision-v1` — one bounded decision request/result;
- `cairnstone-capability-candidate-v1` — compact valid candidate metadata;
- `cairnstone-decision-receipt-v1` — provider/model/deterministic source, candidate-set identity, selected result, confidence/scores, fallback and policy outcome.

Working canonical runtime primitive:

- `cairnstone_capability_route` or equivalent provider-neutral name.

Canonical façade:

- `cairnstone_capability_route` (or equivalent provider-neutral name) — the CairnStone-owned semantic gateway over deterministic candidates, scorer adapters, Tool Vault hydration, and existing policy.

Optional adapter façade:

- `ask_jev` — an experimental/compatibility surface proving that Jev can back the same contract without becoming a dependency.

The architecture must not depend on Jev, `ask_jev`, or any external scorer API.

## Decision kinds

Initial supported decision kinds should remain explicit and typed:

- `tool_route` — select/rank a tool or abstract capability;
- `snippet_rank` — rank retrieval/search candidates for expansion;
- `retain` — V7.7.10g working-set retention action;
- `expand` — choose exact refs/contracts/artifacts to hydrate;
- `model_route` — choose from policy-valid model candidates;
- `executor_route` — choose from capability/policy-valid executor candidates;
- `escalate` — determine whether a stronger reasoning path is warranted;
- `next_action` — choose from an explicit workflow/state-machine candidate set.

No free-form `execute_anything` decision kind.

## Deterministic candidate boundary

Every model-assisted decision starts with deterministic discovery.

Examples:

```text
Tool Vault search
  -> [cairnstone_find_scope, cairnstone_find_v2, cairnstone_ask_scope]
  -> scorer ranks only these IDs
```

```text
Capability resolver
  -> [unit.convert, finance.lookup, repo.search]
  -> scorer selects one capability
  -> CairnStone resolves it to a valid concrete tool
```

```text
Executor registry
  -> [deterministic-mcp, github-copilot, cursor-cloud]
  -> policy removes ineligible candidates
  -> scorer may rank remaining candidates
```

The request/result must bind to a candidate-set digest and relevant registry/snapshot identity so a scorer result cannot be replayed against a different candidate set.

If deterministic policy already yields a clear winner, skip the scorer. This follows the proven V6.10 Skills Sub-Agent pattern: AI is an ambiguity resolver, not a mandatory tax on every route.

## Tool-gateway / provider-neutral pilot

The first pilot should expose one CairnStone-owned front door while keeping the actual tool surface behind CairnStone. The default model-assisted scorer should use Workers AI through the existing Cloudflare runtime; Jev remains an optional adapter for parity/benchmarking.

Initial modes:

### 1. `route`

Input: task + bounded context.

Output:

- abstract capability;
- ranked valid tool candidates;
- selected candidate;
- confidence/scores;
- candidate-set identity;
- no execution.

### 2. `hydrate`

Runs `route`, then hydrates the exact selected tool contract through the canonical Tool Vault.

Output additionally includes:

- exact canonical tool name;
- input schema;
- `schema_hash`;
- risk class;
- authorization mode;
- registry identity.

No tool execution.

### 3. `read`

Runs `route -> hydrate -> policy`.

Only when the selected tool is already classified:

```text
risk_class = read
authorization = automatic
broker_eligible = true
```

may the gateway invoke the existing governed `cairnstone_tool_execute` path.

Any mutation/execution/human-confirmation requirement stops at a proposal/authorization boundary.

The scorer itself never executes the tool.

## Relationship to Deferred Tool Hydration / Tool Vault

V7.6 solved tool-schema scale by making the normal portable path:

```text
tool_search
  -> get_tool_contract
  -> policy_preview
  -> tool_execute
```

V7.7.10h adds semantic selection in front:

```text
task
  -> compact deterministic candidates
  -> decision plane
  -> selected capability/tool
  -> get exact contract
  -> policy
  -> governed action
```

This can allow a client to start from an extremely small MCP surface while retaining access to a very large server-side Tool Vault.

A possible future core profile becomes:

```text
health
resume
find
capability_route / ask_jev
policy / authorization
```

The complete catalog remains server-side and discoverable without putting thousands of schemas into model context.

## Abstract capabilities before concrete tools

Prefer stable capability vocabulary where possible:

```text
repo.read
repo.search
repo.diff
repo.patch
web.search
unit.convert
stone.search
scope.retrieve
code.test
message.send
model.reason
executor.code
```

A user/model should be able to ask for a capability without knowing:

- which MCP server owns it;
- the concrete tool name;
- the transport;
- the provider;
- whether the tool is currently native or deferred.

CairnStone resolves abstract capability -> valid implementation candidates -> exact tool contract.

V7.9 Skills vNext can reuse this capability vocabulary instead of hard-coding host tool names.

## Persistent Code Mode integration

Persistent Code Mode is a priority integration because the Code Session supplies strong semantic state for routing.

The decision input may include compact, policy-safe projections of:

- active task;
- blockers;
- changed paths;
- latest checkpoint;
- recent execution receipts;
- live leases/concurrent actors;
- environment profile;
- current workspace/Git identities;
- next-action candidates.

Examples:

```text
active blocker = failing test
candidate actions =
  [read failing log, inspect changed file, rerun test, search repo, ask stronger model]

decision plane
  -> inspect changed file
  -> Tool Vault selects exact repo.read implementation
```

or:

```text
task state = review
candidate actions =
  [checkpoint, diff, test, handoff]

decision plane
  -> diff
  -> policy-safe read path
```

This allows Persistent Code Mode to remain durable while the active reasoning loop uses only the smallest useful set of tools/context at each step.

The decision plane must not acquire leases, mutate workspace files, merge, deploy, or move task state merely because the scorer recommended an action. Those remain governed CairnStone operations.

## V7.7.10g integration

V7.7.10g Context Retention should consume the shared decision contract where useful.

Retention becomes one decision kind:

```text
decision_kind = retain
candidates = [artifact refs]
actions = [PIN, KEEP_FULL, KEEP_REF, DROP_FROM_ACTIVE_CONTEXT]
```

This prevents a Jev-specific scorer interface from being buried only inside compaction code.

10g must still have deterministic fallback and may ship deterministic retention before the shared model adapter is complete.

## Retrieval / snippet gateway

Search and retrieval should remain two-stage:

```text
deterministic/search index
  -> bounded candidate snippets/refs
  -> decision plane ranks expansion value
  -> exact winners expanded
  -> larger reasoning model synthesizes
```

The scorer should not replace exact retrieval. It chooses which already-discovered refs deserve expensive expansion.

Candidate identity/provenance must survive ranking.

## Utility routing

For requests with deterministic answers, the decision plane should route rather than reason.

Example:

```text
"convert 7 cups to milliliters"
  -> capability = unit.convert
  -> deterministic conversion tool
  -> exact result
```

No scorer should be asked to perform arithmetic that an authoritative deterministic utility can perform. The scorer's value is recognizing/selecting the route when deterministic routing is genuinely ambiguous.

## Model and executor routing

The decision plane may assist existing `cairnstone_model_route` and `cairnstone_executor_route`, but only after deterministic policy constructs an eligible set.

Inputs may include:

- required capabilities;
- context mode;
- latency/cost class;
- task class;
- provider availability;
- budget;
- quality policy.

It may not weaken capability requirements, budget ceilings, authorization state, or preferred/manual route constraints.

## MCP gateway boundary

CairnStone is the MCP/capability gateway.

A scorer — Workers AI, Jev, BYOK, or otherwise — does **not**:

- hold MCP credentials;
- receive reusable capability bearers;
- enumerate arbitrary remote tools independently;
- call arbitrary remote MCP servers;
- bypass Tool Vault schema validation;
- bypass broker policy;
- approve a mutation;
- become accepted-state authority.

In the first implementation, route only within CairnStone's known Tool Vault/registries.

Cross-node/external capability routing should later compose with V7.8 StoneLink/federation rather than inventing an unrelated gateway trust model.

## Security / prompt-injection rules

Candidate names/descriptions, search snippets, external MCP metadata, and tool outputs are untrusted data.

The scorer input must:

- separate system decision instructions from candidate data;
- strip raw credentials/secrets/capability bearers;
- impose candidate-count/byte limits;
- bind candidate IDs/digest;
- reject invented IDs;
- validate returned action enum;
- fail safely on malformed/missing output;
- record provider/model/decision source;
- preserve deterministic policy as final authority.

A scorer confidence is evidence, not authorization.

## Initial slices

### V7.7.10h.0 — Decision contract + deterministic candidate envelope

- define `cairnstone-decision-v1`;
- define candidate-set identity/digest;
- define typed decision kinds/actions;
- deterministic-only baseline;
- zero model/tool execution required.

### V7.7.10h.1 — CairnStone-native scorer / semantic route mode

- first-party Workers AI adapter behind the provider-neutral decision interface;
- deterministic clear winners bypass model inference entirely;
- ambiguous bounded candidate sets may be ranked by Workers AI;
- `route` only in the first cut;
- validate every selection against candidate IDs + candidate-set digest;
- deterministic fallback or safe unresolved result on timeout, malformed output, invented IDs, or provider failure;
- no execution/mutation authority;
- keep the scorer adapter interface open so Jev/BYOK/stronger models can later prove parity without changing decision semantics.

### V7.7.10h.2 — Tool Vault hydrate + brokered read

- `hydrate` exact selected contract;
- preserve `schema_hash`;
- `read` mode only for broker-classified automatic reads;
- mutation/human-confirmation stops at proposal/authorization;
- receipts/telemetry.

### V7.7.10h.3 — Persistent Code Mode integration

- feed bounded Code Session state;
- route retrieval/tool/next-action candidates;
- integrate with `cairnstone_code_session_compile_context`;
- no implicit task/workspace mutation;
- test multi-agent handoff/resume.

### V7.7.10h.4 — Shared decision consumers

Integrate the same decision contract with:

- V7.7.10g retention;
- snippet expansion/ranking;
- skill ambiguity routing where appropriate;
- model routing;
- executor routing;
- escalation decisions.

### V7.7.10h.5 — Cross-host / scale / cost acceptance

Prove equivalent semantics across ChatGPT, Claude, Grok, and one additional host where practical.

Benchmark:

- route accuracy;
- invalid/invented candidate rejection;
- deterministic-skip rate;
- scorer latency/cost;
- tool-schema bytes avoided;
- larger-model calls avoided;
- context reduction;
- wrong-route recovery;
- fallback rate.

## Acceptance

V7.7.10h is complete only when live acceptance proves:

- one tiny gateway surface can resolve tasks into exact Tool Vault contracts without exposing the full catalog;
- every model-assisted selection, including Workers AI/Jev/BYOK adapters, is restricted to deterministic candidate IDs;
- deterministic clear winners bypass the model;
- scorer failure returns deterministic fallback or a safe unresolved result;
- route/hydrate modes execute nothing;
- read mode executes only broker-eligible automatic reads through existing policy;
- mutation/execution/human-confirmed tools never auto-run from scorer output;
- every selected tool contract is exact/canonical and schema-hash guarded;
- secrets/capability bearers never enter scorer state;
- Persistent Code Mode can use the decision plane without changing checkpoint/lease/task authority semantics;
- V7.7.10g can reuse the same provider-neutral decision interface;
- the CairnStone-native Workers AI scorer and at least one alternate implementation (deterministic-only, Jev, or BYOK) can back the same contract without changing authority semantics;
- a large Tool Vault does not cause linear boot-schema growth;
- route receipts expose candidate-set identity, selection source, provider/model where used, confidence/scores, policy outcome, and any governed execution receipt;
- accepted CairnStone state remains unchanged by route/hydrate/read decisions except when an independently authorized downstream mutation is explicitly performed through the existing authority path.

## Repository placement

Implement the canonical Decision Plane in `nothinginfinity/cairnstone-v6` because it is an extension of the Tool Vault, policy broker, model/executor routers, Conversation Sessions, and Persistent Code Mode.

Do **not** create a separate canonical repo for this architecture now.

A future small adapter repo analogous to `afo-ask-copilot` may be justified only if a standalone public/private Remote MCP façade for `ask_jev` becomes independently deployable and useful outside CairnStone. That adapter would remain a transport/product surface over the CairnStone contract, not the source of authority.

## Non-goals

- do not clone/train Jev as part of this slice;
- do not require Jev for CairnStone correctness;
- do not replace deterministic utilities with probabilistic answers;
- do not allow a scorer to invent or install arbitrary tools;
- do not turn a semantic route into execution authority;
- do not expose the whole Tool Vault to the scorer when a bounded candidate set suffices;
- do not create a second policy/broker implementation;
- do not make gateway convenience a bypass around human commit, CAS, capability, economic, or accepted-state boundaries.

Reference inspirations:
- Jev-style typed decision scoring as observed through the fast-jev-compaction pattern.
- CairnStone V6.10 Skills Sub-Agent deterministic-candidate/advisory-model boundary.
- CairnStone V7.6 Deferred Tool Hydration / Tool Vault.
- AFO Ask Copilot single-tool Remote MCP façade pattern.
