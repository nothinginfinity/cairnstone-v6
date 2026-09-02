# CairnStone V7 Roadmap

Status: **V7.3 COMPLETE; V7.4 COMPLETE — V7.4.0 operational grounding, generalized provider-neutral profile registry/rules, and V7.4.1 true cross-project profile reuse are live-accepted on runtime 0.5.19. `repo-debugger` now runs against the independent `praxiq-call` chain while its canonical instructions remain sourced from the profile-owning CairnStone chain under dual-chain race protection. Final strict acceptance run `33020784647` at runtime/workflow commit `8a780939fe69eca2dd075b7a45162af78c3fbd6e` passed targeted + full regression checks, deployment, real Workers AI and DeepSeek routing under identical package/request/profile/classification identity, exact live repo-drift grounding, fail-closed unlisted-chain scope, and unchanged accepted state on both chains. V7.5 is now IN PROGRESS: V7.5.0 has canonically started as a design-first paid-service contract + deterministic pre-execution quote/identity slice; real payment settlement remains intentionally gated.**
Predecessor baseline: **V6.10 frozen control plane**

## V7 thesis

V6 established the control plane:

- accepted project memory and path HEADs;
- deterministic orientation/search/freshness;
- AI correspondence;
- grounded Q&A;
- Git-versioned accepted skills;
- downstream skill distribution;
- skill QA;
- advisory Skills Sub-Agent.

V7 builds the provider-neutral agent runtime on top of that control plane.

The central shift is:

> CairnStone defines durable agent state, skills, authority, coordination, and evidence; the LLM becomes a replaceable reasoning engine.

Provider choice must not redefine project memory, accepted skills, canonical instructions, or execution authority.

---

## V7.0 — Deterministic Context Compiler / Agent Bootstrap

### Goal

Create one provider-neutral `cairnstone_agent_bootstrap` operation that compiles the exact context an agent should receive before any model call.

### Inputs

- `actor_id`
- `task`
- `chain`
- bounded tool/capability metadata
- optional already-loaded skills
- explicit context limits

### Output

A `cairnstone-agent-context-v1` package containing:

- canonical chain HEAD and represented path HEADs;
- accepted canonical operating-guide identity + body;
- non-mutating AC1 inbox snapshot;
- deterministic accepted skill recommendations;
- accepted provenance-bearing skill bundle;
- bounded deterministic memory/evidence;
- available/missing capability evidence;
- explicit zero execution/mutation authority;
- stable SHA-256 `package_id`.

### Hard constraints

- zero LLM calls;
- zero provider credentials;
- zero tool execution on behalf of the model;
- zero accepted-state mutation;
- fail closed on authority-generation races;
- mutable Git branches never become authority.

### Acceptance

See `docs/V7_0_CONTEXT_COMPILER_CONTRACT.md`.

V7.0 implementation and live acceptance are complete. The deliberate race-injection gate (Test G) is closed, and deferred cross-provider Test C was closed with real multi-provider evidence in V7.1.3.

---

## V7.1 — Provider-Neutral Model Router

Status: **COMPLETE.** Full R1-R12 live acceptance closed on runtime `0.5.5`. See `docs/V7_1_PROVIDER_NEUTRAL_MODEL_ROUTER.md` for the contract and the canonical V7.1.5 acceptance stone (`project-memory/v71-5-r1-r12-acceptance-closed.md`) for the complete evidence matrix.

Canonical contract: `docs/V7_1_PROVIDER_NEUTRAL_MODEL_ROUTER.md`

### Goal

Make the reasoning engine interchangeable without changing accepted agent state.

### Architecture

```text
V7.0 immutable context package
          ↓
cairnstone-model-request-v1
(provider-neutral request IR)
          ↓
explicit route envelope
(provider/model/credential/failover policy)
          ↓
Cloudflare AI Gateway / AI REST API
          ↓
Workers AI or third-party provider
          ↓
cairnstone-model-result-v1
(text + normalized tool intents only)
```

V7.1 preserves two identities:

- `package_id` — exact V7.0 accepted agent context;
- `request_ir_id` — exact provider-neutral reasoning request derived from that package.

Provider/model choice changes neither identity.

### Current accepted implementation state

- **V7.1.0 — contract + fixtures:** complete.
- **V7.1.1 — router core + mock adapters:** complete.
- **V7.1.2 — Workers AI adapter:** complete and live-accepted.
- **V7.1.3 — third-party / BYOK adapters:** complete and live; capability registry covers 12 providers/models; real Workers AI, DeepSeek, and OpenAI routing preserved one V7.0 `package_id` and one provider-neutral `request_ir_id`.
- **V7.1.4 — explicit failover + observability:** complete and live-accepted on runtime `0.5.5`; real primary-provider failure (credential-resolution failure) triggered real fallback to Workers AI with identity fully preserved and a complete ordered attempts history recorded.
- **V7.1.5 — full R1-R12 live acceptance closure:** complete. All twelve acceptance items closed with live and/or unit evidence; see the acceptance matrix in `project-memory/v71-5-r1-r12-acceptance-closed.md`.
- **R3 / deferred V7.0 Test C:** closed with real non-mocked cross-provider evidence and formally re-certified in V7.1.5.
- Provider secrets remain outside V7.0 packages, request IR, CairnStone stones, AC1, and normal model-visible payloads -- confirmed by scanning every captured live request/result payload from this session for secret material (none found).

### V7.1.5 closure: full R1-R12 acceptance evidence

All twelve acceptance items in the V7.1 contract are closed. Summary (full detail in `project-memory/v71-5-r1-r12-acceptance-closed.md`):

| # | Item | Evidence |
|---|---|---|
| R1 | Package integrity | Unit (tampered/mismatched package_id fails closed) |
| R2 | Request-IR determinism | Unit + live (identical `request_ir_id` across repeat calls) |
| R3 | Cross-provider neutrality / V7.0 Test C | **Live**: same package routed to real Workers AI, DeepSeek, and OpenAI, identical `package_id`/`request_ir_id` on all three |
| R4 | Provider identity separation | Live (R3 evidence) + unit |
| R5 | Tool capability truth | **Live**: `max_output_tokens` beyond model cap -> `model_capability_mismatch` |
| R6 | Tool intent only | **Live**: real DeepSeek tool call normalized to `tool_intent` with `executed:false` |
| R7 | Secret isolation | **Live**: every captured live request/result payload this session scanned for secret material -- none found |
| R8 | Explicit failover | **Live**: real primary-provider failure, real fallback success, identity preserved, full attempts history |
| R9 | Error normalization | Unit (401/429/timeout/bad_request/capacity fixtures) + live (real `provider_auth_failed`) |
| R10 | AI Gateway observability | **Live**: real `gateway_request_id` (Workers AI) and real provider request IDs (DeepSeek/OpenAI) |
| R11 | Advisory skill ambiguity | **Live**: real `cairnstone_skill_agent` call on a genuinely ambiguous task, selection confirmed within deterministic candidates, `advisory_resolution` changes `request_ir_id` only, never `package_id` |
| R12 | Direct MCP acceptance | All evidence gathered via direct JSON-RPC against the production `/mcp` endpoint, not unit tests alone |

**V7.2 complete:** V7.1 remains complete and V7.2 is now canonically closed. Runtime `0.5.8` has three live-accepted primitives: bounded read-only `cairnstone_delegate`, structured immutable AC1 `cairnstone_dispatch_handoff`, and its optional GitHub Inbox mirror transport. The Console client is live-accepted end-to-end and was advanced through the final Operator UX pass at immutable commit `4df875600bfeccf5fd45ee8fe4bf7dcbcec7c700`, with Recent Activity and Stones tabs live. Console chain HEAD `eb4ea74cb9ba453cb112d421d89a41e2f9d21b0addf059f4f3f2ba2880ac3f95`, project-memory HEAD `69d8ee165ac1ab2f3f79b4602134fe358cd36778f3b90da93d6d7852c680534d`, and the closing AC1 handoff together lift the V7.3 gate.

### Transport baseline

For new normal single-model calls, prefer Cloudflare's AI REST API. Treat Dynamic Routing as an explicit optional failover/conditional-routing policy, not as an implicit default. Resolve provider/model IDs and capabilities against the live catalog at implementation and acceptance time.

### Initial provider classes

1. **Workers AI hosted model**
   - live catalog resolution;
   - current DeepSeek/Kimi/GLM-class models are candidates, not architectural constants.

2. **Third-party provider through AI Gateway**
   - OpenAI, Anthropic, xAI, Google, DeepSeek, Groq, Cerebras, Mistral, or another supported provider;
   - Unified Billing or stored BYOK;
   - provider secrets never enter CairnStone context, IR, results, AC1, or normal logs.

### Router responsibilities

- validate the V7.0 package;
- deterministically compile provider-neutral request IR;
- provider/model selection under explicit policy;
- model capability registry;
- provider-specific message/tool translation at adapter boundaries;
- AI Gateway routing/observability;
- rate/cost/error normalization;
- normalized result and tool-intent output;
- optional V6.10 Skills Sub-Agent advisory only for genuine V7.0 ambiguity and only within accepted deterministic candidates.

### Router non-responsibilities

The router cannot:

- choose canonical instructions or accepted memory/path HEADs;
- select unaccepted skills;
- change `package_id`;
- silently change `request_ir_id` because a provider changed;
- execute tools;
- grant execution/mutation authority.

### Acceptance

See the full R1-R12 contract in `docs/V7_1_PROVIDER_NEUTRAL_MODEL_ROUTER.md`.

Key proofs include:

- same V7.0 package + request IR across Workers AI and one third-party provider;
- provider switch leaves `package_id` and `request_ir_id` unchanged;
- real tool call normalizes to `tool_intent` with `executed:false`;
- stored BYOK/Unified Billing secrets never leak into stable artifacts;
- failover is off by default and explicit when enabled;
- AI Gateway/runtime telemetry proves which provider/model actually handled the call;
- cross-provider proof closes V7.0 Test C.

---

## V7.2 — CairnStone Console + Inbox Dispatch

Status: **COMPLETE.** Runtime `0.5.8` exposes three live-accepted V7.2 primitives: `cairnstone_delegate`, `cairnstone_dispatch_handoff`, and its optional GitHub Inbox mirror transport (deterministic per-recipient/message artifacts, isolated failure handling, idempotent replay). Live acceptance run `32870621139` at commit `a567a553a66fee61ad85f20f2e7c7b2970c0aed9` additionally proved real Workers AI -> DeepSeek provider switching under the same V7.0 package/request identities, intentional provider-credential failure isolation, successful mirroring, mirror replay, and deliberate mirror-target failure isolation, all with canonical chain/path-head state unchanged. The `nothinginfinity/cairnstone-v6-console` client was initially live-accepted at immutable commit `0a1f1d958c175caa1f770dfb8b12ea3e84c1eb53`, then advanced through the final Operator UX pass at `4df875600bfeccf5fd45ee8fe4bf7dcbcec7c700`, adding Recent Activity and Stones while preserving the same read-only authority boundary. It remains published at `https://nothinginfinity.github.io/cairnstone-v6-console/`; the final Console chain HEAD is `eb4ea74cb9ba453cb112d421d89a41e2f9d21b0addf059f4f3f2ba2880ac3f95` and the closing project-memory HEAD is `69d8ee165ac1ab2f3f79b4602134fe358cd36778f3b90da93d6d7852c680534d`. V7.2 is canonically closed and V7.3 may proceed.

### Goal

Create a human/agent operating surface over the same V7 runtime contracts **and introduce the first bounded server-side delegation primitive** so a caller can send a task to another model without importing the full intermediate repo/context payload into the caller's own chat context.

Preferred repository:

`nothinginfinity/cairnstone-v6-console`

The console is a client of CairnStone/V7, not a competing source of truth.

### Primary surfaces

#### 1. Chat / model selector

- provider selector;
- model selector;
- BYOK/provider state;
- current actor ID;
- current chain/project;
- V7.0 package ID;
- request/response history.

#### 2. Evidence inspector

Show the exact state behind a model response:

- canonical chain HEAD;
- accepted operating-guide commit;
- represented path HEADs;
- skill manifest HEAD;
- selected skills and immutable commits;
- memory evidence/citations;
- tool availability;
- execution/mutation policy;
- provider/model outer envelope.

#### 3. Inbox / correspondence

Native AC1 UI:

- actor inboxes;
- threads;
- unread/read state;
- priority/intent;
- immutable message stone identity;
- compose/reply/handoff.

#### 4. "Send to GitHub Inbox" / asynchronous handoff

Build on the user's existing Email-for-AI Bob/Alice inbox concept, but make CairnStone-specific provenance first-class.

The action should create a compact handoff package containing:

- sender actor;
- recipient agent/inbox identity;
- thread;
- task/intent;
- relevant V7.0 `package_id`;
- CairnStone continuation/stone refs;
- optional GitHub artifact reference;
- no implicit execution authority.

If an external GitHub-backed inbox is used, it should be an asynchronous transport/mirror, not a second authority for CairnStone accepted state.

#### 5. Server-side read-only delegation

Add a bounded delegation operation, working name `cairnstone_delegate` or `cairnstone_agent_run`, that composes existing V7 contracts server-side:

```text
actor + task + chain + provider policy
        ↓
V7.0 bootstrap
        ↓
deterministic accepted-state retrieval / skills
        ↓
V7.1 provider-neutral route
        ↓
selected model
        ↓
compact result + evidence + usage
```

Initial delegation is **read-only**. It may automatically use a narrow allowlist of CairnStone/GitHub read capabilities once that read loop is implemented, but it must not grant mutation or execution authority.

Primary benefit: expensive repo/context inspection can happen inside the delegated runtime while the calling ChatGPT/Claude session receives only a bounded answer, citations/evidence refs, identities, usage, and diagnostics. This is the first V7 feature explicitly intended to reduce primary-chat context/token pressure.

Delegation acceptance should prove:

- the server, not the caller, carries the large V7 package between bootstrap and model routing;
- result preserves `package_id`, `request_ir_id`, provider/model evidence, and source refs;
- output budget is caller-bounded;
- no raw provider credential is exposed;
- no mutation/execution tool can run through the V7.2 delegation path;
- a delegated repo investigation can return a compact diagnosis grounded in accepted stones without requiring the parent chat to ingest the full source corpus.

### UX principles

- mobile-friendly;
- evidence visible without overwhelming the chat;
- clearly distinguish accepted state, historical evidence, freshness, and model output;
- clearly distinguish "send message" from "execute task";
- copy/export handoff to ChatGPT, Claude, Perplexity, etc.;
- preserve actor/thread identity across providers.

### Acceptance

- one user can switch providers while keeping the same V7.0 package visible;
- evidence inspector can independently verify package provenance;
- AC1 inbox message can be composed and read;
- GitHub inbox dispatch produces an inspectable asynchronous handoff artifact;
- dispatch does not grant execution authority;
- model/provider failure does not corrupt correspondence or canonical state.

---

## Later V7 slices

### V7.3 — Permissioned Agent Loop / MCP Tool Broker

Status: **COMPLETE. V7.3.0 through V7.3.3 are live-accepted.** V7.3.3 human-confirmed guarded mutation closed on runtime `0.5.16` with canonical closure Stone `eca9e8417dbb7c921ef10bb1f1263da5bb537fb5b20d7ee4f53651683ed1d169` and final acceptance evidence `9573757ff6501e374c41ae21416d4a9fe5e39e641729b5fd43e6b103a12a1f79`. The invariant remains: **model intent is never execution authority.** Canonical contract: `docs/V7_3_PERMISSIONED_AGENT_LOOP_MCP_TOOL_BROKER.md`. V7.3.0 adds `cairnstone_tool_registry` and `cairnstone_tool_policy_preview`, with deterministic risk/authorization decisions and an explicit hard boundary that no preview can execute a tool (`can_execute_now:false`, `executed:false`, `tools_executed:0`). Live acceptance run `32890344073` proved automatic-read eligibility, human-confirmed mutation gating, and unchanged chain/path authority. V7.3.1 adds `cairnstone_tool_execute`, which re-derives the identical policy verdict and only executes read+automatic intents outside any provider adapter, under output/turn budgets, with an immutable execution receipt on `cairnstone-v7-tool-execution-receipts`; run `32907348014` closed its live acceptance. V7.3.2 adds `cairnstone_tool_authorization_request`, which records a model-proposed mutation as an immutable pending authorization request on `cairnstone-v7-tool-authorization-requests` while refusing all embedded approval/execute bypass fields and performing zero target mutation. Live acceptance run `32908958516` proved a real `cairnstone_commit_v2` proposal stopped at `human_confirmation`, persisted the pending request, remained non-executable through `cairnstone_tool_execute`, and left canonical project-memory HEAD/path state unchanged.

Turn normalized V7.1 model tool intents into a governed multi-turn execution loop. This is the point where a routed model becomes a real tool-using subagent rather than only a reasoning subcontractor.

Key rule:

> model intent is not execution authority.

The V7.3 broker should expose normalized tool schemas to the model, validate every returned intent against the V7.0 capability evidence and an explicit runtime policy, execute only authorized tools, return tool results to the same reasoning loop, and issue immutable execution receipts.

Policy tiers:

- **read-only automatic** — CairnStone search/expand/resume/freshness and approved GitHub/MCP reads can execute without confirmation;
- **low-risk mutation with scoped capability** — narrowly defined writes may execute only under an explicit profile/policy grant and concurrency guard;
- **human-confirmed mutation/execution** — GitHub patches, deploys, financial actions, or other consequential operations require explicit confirmation unless a later accepted policy says otherwise;
- **prohibited/high-risk** — never execute.

MCP bridge requirements:

- connected tools do not become available merely because ChatGPT or another client has them; each downstream MCP must be explicitly registered behind the CairnStone broker;
- normalize tool identity, JSON schema, risk class, availability, and required authorization independent of model/provider;
- never expose connector credentials/secrets to the model;
- keep tool execution outside the provider adapter;
- record requested intent, policy decision, actual tool call, result identity, mutation receipt, and subsequent model turn.

V7.3 acceptance should include a real bounded coding/debug loop: delegated model searches accepted stones/repo evidence, requests additional read tools, diagnoses an error, proposes a GitHub change, stops at the configured mutation boundary, receives explicit authorization, applies a guarded patch, verifies tests/live state, and returns an execution receipt linked to the originating `package_id` and model/provider envelope.

### V7.4 — Cross-project agent profiles + reusable subagent identities

Status: **COMPLETE. V7.4.0 and V7.4.1 are live-accepted on runtime `0.5.19`.** V7.4.0 established the first reusable provider-neutral profile, `cairnstone-maintainer`, deterministic grounding classes, and real Workers AI/DeepSeek operational-current grounding. The broader V7.4 generalization then replaced profile-specific branching with `AGENT_PROFILE_REGISTRY`, explicit `scope.allowed_chains`, and declarative JSON-serializable grounding-classification rules, adding `repo-debugger` and `release-reviewer` without expanding the mutation/execution surface. V7.4.1 closed the literal cross-project requirement: `repo-debugger` was explicitly allowed on the independent `praxiq-call` chain, and strict live run `33020784647` at commit `8a780939fe69eca2dd075b7a45162af78c3fbd6e` proved a real `cairnstone_reconcile_repo` read against PraXiQ, identical provider-neutral package/request/profile/classification identity on Workers AI and DeepSeek, zero tools exposed to either model, zero mutation/execution authority, fail-closed rejection of unlisted `praxiq-int`, and unchanged CairnStone + PraXiQ accepted state. That proof uncovered and fixed two real cross-project gaps: reconciliation evidence is now preserved in bounded model grounding, and V7.0 bootstrap can internally source canonical instructions from the validated profile-owning chain while keeping the target project chain authoritative for project state/memory and race-checking both chains. This satisfies the V7.4 acceptance criterion; additional profile-catalog growth is incremental rather than a gate.

Create reusable provider-neutral agent profiles that configure how a CairnStone agent operates without becoming accepted project-memory authority.

Profile fields should include:

- stable agent/profile identity and AC1 correspondence identity;
- default chain(s) / project scope;
- preferred provider/model plus explicit fallback policy;
- accepted skill preferences;
- read/mutation/execution tool allowlists;
- per-tool/risk-class confirmation policy;
- context, retrieval, output, cost, and turn budgets;
- delegation depth / child-agent limits;
- compact-result contract for parent agents;
- optional schedule/service metadata without granting authority by itself.

Target examples include `repo-debugger`, `release-reviewer`, `cairnstone-maintainer`, and other narrow agents whose model can be swapped without changing their durable identity or policy.

V7.4 acceptance should prove the same profile can run on at least two compatible providers, use the same permitted MCP/tool surface, preserve the same CairnStone authority boundary, and produce comparable receipts/evidence while provider/model remains an outer runtime choice.

### V7.5 — x402 / paid sub-agent runtime

Status: **IN PROGRESS — V7.5.0 contract/quote boundary STARTED; real settlement NOT YET AUTHORIZED.** Canonical project-memory HEAD: `0d4346fa4a9e352256654c42fddc58e5b0c3883a79560026fbd6d4fa9c74142e` (`project-memory/v750-paid-subagent-contract-start.md`). The first candidate paid capability is the already live-accepted `repo-debugger` profile. V7.5.0 intentionally freezes identities, ordering, replay rules, and the x402 integration boundary before any wallet signing or settlement is enabled.

Expose selected V7.4 profiles as bounded, metered agent services callable by other agents or applications.

#### V7.5.0 — Paid service contract + deterministic quote boundary

The bounded first slice defines four provider-neutral identities/contracts:

- `cairnstone-paid-agent-service-v1` — immutable service descriptor binding service/profile identity, profile version, chain scope, compact-result contract, tool/risk policy, budgets, and x402 pricing route;
- `cairnstone-paid-agent-request-v1` — caller + service/profile + target chain + task + generation/output bounds + exact V7 `package_id`, with deterministic `service_request_id = sha256(canonical request)`;
- `cairnstone-paid-agent-quote-v1` — binds `service_request_id` + `package_id` to the x402 challenge/payment-requirement digest, price, asset, network, payee, and expiry; price authority comes from x402 policy evaluation, never from the model/profile;
- `cairnstone-paid-agent-result-v1` — compact answer plus package/request/profile identity, provider/model envelope, tool receipts, x402 settlement receipt, and replay status.

Mandatory execution ordering:

```text
resolve service/profile
  → validate profile scope
  → deterministic V7 bootstrap
  → service_request_id
  → x402 quote/challenge
  → caller payment authorization
  → REVALIDATE service_request_id + package_id/current accepted authority
  → only then x402 verify/settle
  → execute bounded profile delegation
  → persist/link compact result + execution/model/payment receipts
```

Critical race rule: if accepted chain/path authority changed after quote, fail `paid_agent_context_race` **before settlement** and require a fresh quote. A caller must never pay for context A and receive work against context B.

Replay/idempotency rule: exact replay of the same settled `service_request_id` returns the existing paid result/receipt with no second model call, tool call, or settlement; conflicting quote/payment reuse fails closed. Provider failover may change provider/model attempts, but it must not change `package_id`, `service_request_id`, price challenge, profile identity, or the accepted-authority boundary.

Payment architecture boundary: `nothinginfinity/x402-sub-agent-mcp` remains the external x402 payment-policy plane. CairnStone consumes that service (starting from its `evaluate_request` policy primitive) rather than duplicating wallet custody/signatures, facilitator verification/settlement logic, payment rules, leases, or usage accounting. Payment never grants mutation authority, and provider/model credentials remain isolated from stable CairnStone artifacts.

V7.5.0 engineering sequence:

1. implement pure service-catalog/request/quote helpers and unit tests in `nothinginfinity/cairnstone-v6`, initially for `repo-debugger`, with **zero settlement**;
2. expose deterministic quote/preview output;
3. add the x402 adapter/service binding and prove a live `402` challenge without moving money;
4. only after those gates pass, run one tiny real Base Sepolia paid `repo-debugger` acceptance proving package identity, model route, tool receipts, payment receipt, and no double-charge on replay.

The paid unit is not raw inference. It is a narrow CairnStone-defined capability backed by:

- immutable context/package identity;
- provider-neutral agent/profile identity;
- accepted skills;
- explicit tool policy and budgets;
- compact evidence-bearing result contract;
- execution receipts for any permitted tool use;
- x402 pricing, authorization, settlement, replay/idempotency, and audit evidence.

V7.5 should support a caller asking for a bounded outcome such as `inspect this accepted repo state and return a cited diagnosis` or `run this permitted release check`, with price/capability known before execution and model/provider choice remaining an implementation detail unless the caller explicitly constrains it.

Acceptance should prove at least one real paid subagent call end-to-end: x402 payment/authorization, deterministic CairnStone context selection, model routing, permitted tool usage if needed, compact result, execution/model receipts, idempotent replay behavior, and settlement evidence.

---

## V7.6 — Context Efficiency & MCP Surface Optimization

Status: **PLANNED / BASELINE-FIRST.** Optimize the existing canonical CairnStone V7 codebase in-place behind additive compatibility boundaries; do not fork a competing optimized repo. Production defaults remain unchanged until parity, rollback, and live-canary gates close.

Primary goals:

- add exact context-cost telemetry for MCP schemas and V7 bootstrap packages;
- reduce model-visible bootstrap size with a sparse, cryptographically complete authority envelope while keeping the full accepted path-head set authoritative server-side;
- add compact orientation/manifest response modes for mature chains;
- make **Deferred Tool Hydration / the CairnStone Tool Vault** the first behavior-changing optimization after the V7.6.0 profiler: keep full tool contracts server-side, expose a tiny core MCP surface, search/select only relevant capabilities, hydrate exact contracts on demand, and preserve the full `/mcp` surface as compatibility/rollback;
- consider a Git-versioned, CairnStone-accepted runtime instruction brief only after lower-risk authority/tool-surface wins are measured;
- preserve legacy full-context behavior as a rollback path until optimized behavior is live-accepted.

Initial measured baseline (2026-08-30): connected production MCP `0.5.19` advertises 51 tools; minimal V7 bootstrap measured 44,133 bytes with zero memory hits/inbox items; a normal bounded bootstrap measured 57,563 bytes. GitHub `main` is already ahead at commit `ecf7442da977c0b7790b3e0f39f4e564cb9eb9fc` / package version `0.5.20`, so repo SHA and live deployed runtime must be recorded separately in every acceptance result.

### V7.6.0 — Exact context-cost profiler

First implementation slice; **no behavioral/default change**. Measure serialized tool-schema bytes, estimated schema tokens, bootstrap section bytes/tokens, provider actual input/output tokens when available, total estimated CairnStone startup footprint, and context-window percentage. Measurements must derive from exact server-exposed definitions and serialized packages, not hand-maintained estimates.

### V7.6.1 — Sparse authority envelope

Add opt-in `optimized_sparse` bootstrap alongside current `legacy_full`. Preserve canonical chain HEAD plus a deterministic digest/root over the complete accepted path-head set; transmit only task-relevant represented path HEADs to the reasoning model and expose deterministic expansion for omitted heads. Sparsity changes transmission, not authority.

### V7.6.2 — Deferred Tool Hydration / CairnStone Tool Vault

Status: **NEXT BUILD AFTER V7.6.0 PROFILER.** V7.6.0 remains the required no-behavior-change measurement pass so the before/after savings are exact; V7.6.2 is the first behavior-changing context optimization to implement once that baseline is recorded. The previously planned sparse-authority and compact-read work remain in V7.6, but tool-schema deferral moves ahead of them because the current 51-tool catalog is a large avoidable startup tax and the existing V7.3 registry/policy/execute primitives already provide much of the required control plane.

Keep the existing full `/mcp` surface intact as the legacy/full compatibility profile. Add a portable deferred-tool profile, working name `/mcp/core`, whose boot-visible schema set stays small even as the server-side catalog grows from 51 to hundreds or thousands of tools.

#### V7.6.2a — Portable deferred-tool mode

The server owns a canonical **Tool Vault** containing every full tool schema plus tool identity, availability, risk class, authorization requirement, policy metadata, and registry/version identity. Those full contracts are not model-visible at boot unless the caller chooses the legacy/full profile.

The core profile should expose only the minimum boot/runtime primitives needed to discover and safely invoke everything else, targeting roughly 6-8 native schemas rather than the full catalog. The exact names may reuse or extend existing V7.3 primitives, but the capability contract should include:

- health/status and bootstrap/resume;
- bounded evidence find/search;
- `cairnstone_tool_search(query, top_k)` — returns only a compact ranked candidate set, not the full catalog;
- `cairnstone_get_tool_contract(tool_id)` — returns one exact on-demand contract including full input schema, `schema_hash`, risk class, authorization policy, availability, and registry identity;
- `cairnstone_tool_policy_preview` — preserves the current deterministic policy boundary;
- `cairnstone_tool_execute` — governed generic execution after exact contract validation;
- the existing authorization lifecycle for human-confirmed mutations/execution where required.

The normal flow becomes:

```text
user task
  -> tiny /mcp/core boot surface
  -> tool_search(task/top_k)
  -> 1-3 compact candidate records
  -> get_tool_contract(selected tool)
  -> exact schema + schema_hash
  -> policy preview / authorization as required
  -> governed tool_execute(tool_id, schema_hash, arguments)
  -> execution/read-back receipt
```

`schema_hash` is a concurrency and integrity guard, not decoration. The executor must re-resolve the canonical registered contract server-side, validate arguments against it, and fail closed if the supplied contract hash is stale or mismatched. A generic executor must never become a policy bypass: **model intent remains non-authoritative, payment remains non-authoritative, and V7.3 human-confirmation/mutation boundaries remain unchanged.**

Tool discovery should be search-first rather than `list all tools` by default. Adding the 500th or 5,000th server-side capability must not linearly increase the boot-visible schema payload; only selected candidate metadata and hydrated contracts should enter model-visible context.

The physical storage format is secondary. Full schemas may live in code/static memory, KV, D1, R2, or compressed artifacts. Gzip can reduce storage/transfer cost, but the context win comes from **not materializing unused schemas into the model prompt at all**.

#### V7.6.2b — Optional native dynamic hydration

After the portable deferred mode is live-accepted, add native MCP dynamic hydration as an optimization for clients that prove they support it reliably. A `cairnstone_load_tools(tool_ids[])`-style operation may update a session-scoped enabled-tool set and use MCP tool-list change semantics so the client re-fetches `tools/list` and exposes the selected native schemas directly.

Do **not** make correctness depend on this path. ChatGPT, Claude, and at least one additional MCP client (preferably Cursor or another independent host) must prove mid-session refresh/rebinding behavior. Clients that do not support it must automatically remain fully capable through the portable `tool_search -> get_tool_contract -> governed tool_execute` path.

Compatibility profiles therefore remain explicit:

```text
/mcp              -> full legacy/native catalog; maximum compatibility
/mcp/core         -> deferred Tool Vault; tiny portable boot surface
/mcp/core + native hydration when proven -> tiny boot + selected native schemas
```

Acceptance for V7.6.2 must prove:

- V7.6.0 records exact full-vs-core serialized schema bytes/tokens before claims are made about savings;
- the core profile has a bounded boot schema count independent of total Tool Vault size;
- the complete catalog remains discoverable server-side without preloading every schema;
- tool search uses bounded deterministic ranking/tie-breaking and returns compact candidates only;
- on-demand contracts carry stable identity + `schema_hash`, and stale/mismatched hashes fail closed before execution;
- full `/mcp` and deferred `/mcp/core` produce policy-equivalent results for the same permitted tool call;
- read-only automatic execution, human-confirmed mutation, replay/idempotency, secret isolation, and receipt semantics remain parity-equivalent with V7.3;
- ChatGPT, Claude, and one additional MCP client can complete orientation, evidence retrieval, and at least one governed tool workflow through the core profile;
- native dynamic hydration, if enabled, falls back cleanly to portable deferred execution when a client cannot refresh/rebind schemas;
- growing the Tool Vault does not materially increase core startup schema bytes except for explicitly added core primitives.

Execution priority inside V7.6 is now: **V7.6.0 exact profiler -> V7.6.2a portable Deferred Tool Hydration -> V7.6.2b native hydration experiment/interop gate -> V7.6.1 sparse authority -> V7.6.3 compact reads -> V7.6.4 instruction brief only if still worthwhile -> V7.6.5 canary/default flip.**

### V7.6.3 — Compact orientation/manifest reads

Add bounded/detail-aware resume and manifest responses for mature chains: chain HEAD + provenance, authority digest/counts, relevant/recent path heads as requested, HEAD edges, and delta support, with explicit full expansion still available. Replace fixed-size documentation claims with measured size telemetry.

### V7.6.4 — Canonical instruction runtime brief

Higher-risk and deferred until earlier wins are measured. The full `docs/AI_OPERATING_GUIDE.md` remains canonical authority. Any runtime brief must be Git-versioned, CairnStone-accepted, identity-bound to the full guide, coverage-tested for safety/authority rules, and fail closed to the full guide when stale or mismatched. Never optimize by arbitrary truncation.

### V7.6.5 — Canary/default flip

Only after V7.6.0-.4 parity gates: run the full V7.0-V7.5 regression matrix, cross-provider identity checks, deliberate authority-race tests, tool-policy/human-confirmed mutation tests, secret-isolation tests, and live canary. Keep one-step rollback to legacy behavior before making optimized mode recommended/default.

Initial quantitative targets: >=50% reduction in mature-chain bootstrap bytes; >=50% reduction in tool-schema bytes for the recommended core profile; approximately 8k-15k combined startup tokens where task complexity permits; zero authority/policy regression and no extra model calls merely to reconstruct deterministic CairnStone state.

Canonical detailed plan: `project-memory/v76-context-efficiency-optimization-plan.md`.

---

## V7.7 — Vault / Workspace Navigation + Multi-Chain Intelligence

Status: **PLANNED / READ-FIRST.** Begin after the active V7.6 optimization/interop work reaches its own acceptance gate. V7.7 must work through the portable CairnStone runtime and cannot make correctness depend on experimental V7.6.2b native tool hydration.

### Goal

Turn CairnStone from a Console centered on one manually entered chain into a navigable semantic workspace over every stoned project, while preserving the existing chain and path-HEAD authority model. A user should be able to select one chain, one repository, several repositories/chains, or the bounded vault and then use the same scope across Chat, Evidence, Activity, Stones, and relevant handoff/correspondence views.

The core rule is: **scope is navigation and retrieval context, never a new source of canonical authority.** V7.7 must not create a synthetic global HEAD. Every participating chain keeps its own canonical chain HEAD and accepted path HEADs, and every cross-chain answer must preserve the chain/repo/stone/path/commit provenance and authority class of its evidence.

### V7.7.0 — Vault catalog + scope contract

Add a read-only vault/chain discovery primitive and a versioned `cairnstone-scope-v1` contract. The catalog should expose normalized chain descriptors, repository provenance when present, canonical HEAD identity, path-head/stone counts, and bounded activity metadata. Chains with no GitHub repository provenance must remain visible. Repository membership is derived from CairnStone accepted provenance, not from mutable Git branches.

Scopes must support single-chain, repository, explicit multi-chain/multi-repository, and vault-wide modes. Server resolution produces an exact bounded set of chains plus the chain HEAD identities used for that request, with a stable scope/snapshot identity and fail-closed race semantics when authority pointers change during compilation.

### V7.7.1 — Server-side multi-chain search

Extend the current vault search plane with explicit multi-chain scope rather than requiring the browser to fan out N independent searches and merge them. Preserve per-hit `chain`, `repo`, `stone_hash`, `path`, immutable commit provenance when available, and authority classification (`CHAIN_HEAD`, `PATH_HEAD`, historical/derived). Apply deterministic ranking, bounded expansion, and fairness so a large chain cannot dominate solely because it contains more refs.

### V7.7.2 — Cross-chain grounded Q&A

Add scope-grounded Q&A, working name `cairnstone_ask_scope`. Resolve the scope deterministically, inject the canonical orientation for each participating chain within explicit budgets, prefer accepted path HEADs, label historical evidence, synthesize only after retrieval, and validate every citation against evidence actually supplied to the model. Answers must make repo/chain provenance visible enough to distinguish conclusions across projects.

If a participating authority pointer changes during scope compilation or citation grounding, fail closed or deterministically re-resolve; never silently combine evidence from two authority snapshots. Persisted cross-scope answers, if later enabled, belong only in a derived workspace/ask chain and never move any source chain or path HEAD.

### V7.7.3 — Console global Scope navigation

Replace the current single Chain field with a mobile-first **Scope** control. The selector should expose `All CairnStone`, repositories with their child chains, explicit multi-select, and the raw chain IDs needed for advanced operation. A compact summary such as `2 repos · 4 chains` should remain visible after selection.

The resolved Scope becomes shared Console state for Chat, Evidence, Activity, and Stones, with Handoff/Inbox filtering only where real message metadata supports the association. Do not fabricate repository ownership for correspondence that has no such provenance. The Console remains a client of CairnStone authority, never a competing source of truth.

### V7.7.4 — Saved workspaces + cross-repo operating views

After core scope semantics are accepted, add named convenience scopes such as `CairnStone Platform`, `Music Projects`, or `Everything`, plus cross-repo views for recent accepted work, handoffs, evidence, and activity. Saved workspace definitions are operational/user convenience state only; local persistence may ship first and cross-device persistence may remain deferred. Workspace state must never grant execution/mutation authority or alter accepted-state pointers.

### V7.7.5 — Live acceptance + scale gate

Acceptance must prove at minimum:

- every known chain is discoverable, including chains without repo provenance;
- single-chain scope remains parity-compatible with current single-chain search/Q&A;
- one-repo scope resolves all relevant chains without leaking unrelated chains;
- explicit multi-repo scope returns evidence only from selected scope and can ground one answer in multiple repositories;
- vault-wide scope remains bounded and deterministic;
- per-chain canonical HEAD/path-HEAD authority classification survives retrieval and citation;
- authority changes during a compiled scope are detected rather than silently mixed;
- every cross-chain citation resolves to supplied evidence with chain/repo/stone/path/commit provenance where available;
- scope reads and saved workspaces cause zero source chain/path-HEAD mutation and grant zero execution authority;
- server-side ranking has deterministic limits and protects smaller chains from corpus-size starvation;
- the Console applies one global Scope consistently across supported panels on mobile with no horizontal overflow;
- live tests cover at least three genuinely stoned repositories and exercise single-chain, repo, multi-repo, and vault modes;
- the milestone works through full `/mcp` and portable `/mcp/core` Tool Vault paths without relying on native dynamic hydration.

Canonical detailed plan: `project-memory/v77-vault-workspace-multi-chain-intelligence-plan.md`.

---

## Phase ordering

```text
V6.10 FROZEN CONTROL PLANE
        ↓
V7.0 Context Compiler Contract
        ↓
V7.0 implementation + live acceptance
        ↓
V7.1 Provider-Neutral Router (COMPLETE -- V7.1.0 through V7.1.5, R1-R12 closed)
        ↓
V7.2 Console + Inbox Dispatch + read-only server-side delegation (COMPLETE — runtime 0.5.8, native AC1 handoff, GitHub mirror, and final Console Operator UX live-accepted)
        ↓
V7.3 Permissioned Agent Loop + MCP Tool Broker (COMPLETE — V7.3.0 through V7.3.3 live-accepted)
        ↓
V7.4 Cross-project agent profiles (COMPLETE — V7.4.0 + generalized profile system + V7.4.1 true cross-project acceptance)
        ↓
V7.5 x402 paid sub-agent runtime (IN PROGRESS — V7.5.0 contract/quote boundary started; settlement gated)
        ↓
V7.6 Context Efficiency & MCP Surface Optimization (PLANNED — active optimization/interop track; complete its acceptance gate first)
        ↓
V7.7 Vault / Workspace Navigation + Multi-Chain Intelligence (PLANNED / READ-FIRST — catalog + scope contract → multi-chain search → grounded Q&A → Console Scope → saved workspaces → live scale/citation gate)
```

Do not skip V7.0.

Without a stable context contract, each provider adapter and UI would independently reconstruct "the agent," recreating the fragmentation V6 was built to eliminate.
