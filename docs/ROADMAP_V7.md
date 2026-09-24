# CairnStone V7 Roadmap

Status: **V7.3 COMPLETE; V7.4 COMPLETE â€” V7.4.0 operational grounding, generalized provider-neutral profile registry/rules, and V7.4.1 true cross-project profile reuse are live-accepted on runtime 0.5.19. `repo-debugger` now runs against the independent `praxiq-call` chain while its canonical instructions remain sourced from the profile-owning CairnStone chain under dual-chain race protection. Final strict acceptance run `33020784647` at runtime/workflow commit `8a780939fe69eca2dd075b7a45162af78c3fbd6e` passed targeted + full regression checks, deployment, real Workers AI and DeepSeek routing under identical package/request/profile/classification identity, exact live repo-drift grounding, fail-closed unlisted-chain scope, and unchanged accepted state on both chains. V7.5 is now IN PROGRESS: V7.5.0 has canonically started as a design-first paid-service contract + deterministic pre-execution quote/identity slice; real payment settlement remains intentionally gated.**
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

## V7.0 â€” Deterministic Context Compiler / Agent Bootstrap

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

## V7.1 â€” Provider-Neutral Model Router

Status: **COMPLETE.** Full R1-R12 live acceptance closed on runtime `0.5.5`. See `docs/V7_1_PROVIDER_NEUTRAL_MODEL_ROUTER.md` for the contract and the canonical V7.1.5 acceptance stone (`project-memory/v71-5-r1-r12-acceptance-closed.md`) for the complete evidence matrix.

Canonical contract: `docs/V7_1_PROVIDER_NEUTRAL_MODEL_ROUTER.md`

### Goal

Make the reasoning engine interchangeable without changing accepted agent state.

### Architecture

```text
V7.0 immutable context package
          â†“
cairnstone-model-request-v1
(provider-neutral request IR)
          â†“
explicit route envelope
(provider/model/credential/failover policy)
          â†“
Cloudflare AI Gateway / AI REST API
          â†“
Workers AI or third-party provider
          â†“
cairnstone-model-result-v1
(text + normalized tool intents only)
```

V7.1 preserves two identities:

- `package_id` â€” exact V7.0 accepted agent context;
- `request_ir_id` â€” exact provider-neutral reasoning request derived from that package.

Provider/model choice changes neither identity.

### Current accepted implementation state

- **V7.1.0 â€” contract + fixtures:** complete.
- **V7.1.1 â€” router core + mock adapters:** complete.
- **V7.1.2 â€” Workers AI adapter:** complete and live-accepted.
- **V7.1.3 â€” third-party / BYOK adapters:** complete and live; capability registry covers 12 providers/models; real Workers AI, DeepSeek, and OpenAI routing preserved one V7.0 `package_id` and one provider-neutral `request_ir_id`.
- **V7.1.4 â€” explicit failover + observability:** complete and live-accepted on runtime `0.5.5`; real primary-provider failure (credential-resolution failure) triggered real fallback to Workers AI with identity fully preserved and a complete ordered attempts history recorded.
- **V7.1.5 â€” full R1-R12 live acceptance closure:** complete. All twelve acceptance items closed with live and/or unit evidence; see the acceptance matrix in `project-memory/v71-5-r1-r12-acceptance-closed.md`.
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

## V7.2 â€” CairnStone Console + Inbox Dispatch

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
        â†“
V7.0 bootstrap
        â†“
deterministic accepted-state retrieval / skills
        â†“
V7.1 provider-neutral route
        â†“
selected model
        â†“
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

### V7.3 â€” Permissioned Agent Loop / MCP Tool Broker

Status: **COMPLETE. V7.3.0 through V7.3.3 are live-accepted.** V7.3.3 human-confirmed guarded mutation closed on runtime `0.5.16` with canonical closure Stone `eca9e8417dbb7c921ef10bb1f1263da5bb537fb5b20d7ee4f53651683ed1d169` and final acceptance evidence `9573757ff6501e374c41ae21416d4a9fe5e39e641729b5fd43e6b103a12a1f79`. The invariant remains: **model intent is never execution authority.** Canonical contract: `docs/V7_3_PERMISSIONED_AGENT_LOOP_MCP_TOOL_BROKER.md`. V7.3.0 adds `cairnstone_tool_registry` and `cairnstone_tool_policy_preview`, with deterministic risk/authorization decisions and an explicit hard boundary that no preview can execute a tool (`can_execute_now:false`, `executed:false`, `tools_executed:0`). Live acceptance run `32890344073` proved automatic-read eligibility, human-confirmed mutation gating, and unchanged chain/path authority. V7.3.1 adds `cairnstone_tool_execute`, which re-derives the identical policy verdict and only executes read+automatic intents outside any provider adapter, under output/turn budgets, with an immutable execution receipt on `cairnstone-v7-tool-execution-receipts`; run `32907348014` closed its live acceptance. V7.3.2 adds `cairnstone_tool_authorization_request`, which records a model-proposed mutation as an immutable pending authorization request on `cairnstone-v7-tool-authorization-requests` while refusing all embedded approval/execute bypass fields and performing zero target mutation. Live acceptance run `32908958516` proved a real `cairnstone_commit_v2` proposal stopped at `human_confirmation`, persisted the pending request, remained non-executable through `cairnstone_tool_execute`, and left canonical project-memory HEAD/path state unchanged.

Turn normalized V7.1 model tool intents into a governed multi-turn execution loop. This is the point where a routed model becomes a real tool-using subagent rather than only a reasoning subcontractor.

Key rule:

> model intent is not execution authority.

The V7.3 broker should expose normalized tool schemas to the model, validate every returned intent against the V7.0 capability evidence and an explicit runtime policy, execute only authorized tools, return tool results to the same reasoning loop, and issue immutable execution receipts.

Policy tiers:

- **read-only automatic** â€” CairnStone search/expand/resume/freshness and approved GitHub/MCP reads can execute without confirmation;
- **low-risk mutation with scoped capability** â€” narrowly defined writes may execute only under an explicit profile/policy grant and concurrency guard;
- **human-confirmed mutation/execution** â€” GitHub patches, deploys, financial actions, or other consequential operations require explicit confirmation unless a later accepted policy says otherwise;
- **prohibited/high-risk** â€” never execute.

MCP bridge requirements:

- connected tools do not become available merely because ChatGPT or another client has them; each downstream MCP must be explicitly registered behind the CairnStone broker;
- normalize tool identity, JSON schema, risk class, availability, and required authorization independent of model/provider;
- never expose connector credentials/secrets to the model;
- keep tool execution outside the provider adapter;
- record requested intent, policy decision, actual tool call, result identity, mutation receipt, and subsequent model turn.

V7.3 acceptance should include a real bounded coding/debug loop: delegated model searches accepted stones/repo evidence, requests additional read tools, diagnoses an error, proposes a GitHub change, stops at the configured mutation boundary, receives explicit authorization, applies a guarded patch, verifies tests/live state, and returns an execution receipt linked to the originating `package_id` and model/provider envelope.

### V7.4 â€” Cross-project agent profiles + reusable subagent identities

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

### V7.5 â€” Paid sub-agent runtime (x402 first adapter)

Status: **IN PROGRESS â€” V7.5.0 contract/quote boundary STARTED; real settlement NOT YET AUTHORIZED.** Canonical project-memory HEAD: `0d4346fa4a9e352256654c42fddc58e5b0c3883a79560026fbd6d4fa9c74142e` (`project-memory/v750-paid-subagent-contract-start.md`). The first candidate paid capability is the already live-accepted `repo-debugger` profile. V7.5.0 intentionally freezes identities, ordering, replay rules, and the x402 integration boundary before any wallet signing or settlement is enabled.

Expose selected V7.4 profiles as bounded, metered agent services callable by other agents or applications.

#### V7.5 architecture amendment â€” x402 is the first payment adapter, not the service identity

V7.5 remains the first paid-agent implementation path, but the durable CairnStone service/job contract must be **payment-rail neutral**. x402 is the first accepted adapter because the existing x402 policy plane and quote-preview work already exist; it must not become part of the semantic identity of the agent service itself.

Architecture invariants:

- stable service/job/request/result identities belong to CairnStone and must survive a change of payment adapter;
- x402, MPP, AP2/UCP/card/bank/stablecoin flows, managed facilitators, and future rails are adapter/provider choices, not accepted-state authority;
- wallet custody, signature mechanics, facilitator operation, global procurement, and rail-specific settlement logic remain outside CairnStone behind bounded adapters;
- payment authorization never grants mutation/execution authority, and model/provider choice never grants economic authority;
- price/settlement evidence may come from an external payment policy plane, but the durable job must bind that evidence to the exact principal, capability/job identity, accepted context, budget, result, and replay state;
- V7.7.10 Task Runs / Conversation Sessions / Persistent Code Sessions are the durable execution fabric that later economic authority must bind to rather than creating a parallel paid-job subsystem.

Compatibility note: existing V7.5.0 x402-specific quote fields may remain for the first adapter and acceptance path. Generalization should happen through an explicit adapter-neutral contract/version rather than silently changing the meaning of already accepted V7.5 identities.

#### V7.5.0 â€” Paid service contract + deterministic quote boundary

The bounded first slice defines four provider-neutral identities/contracts:

- `cairnstone-paid-agent-service-v1` â€” immutable service descriptor binding service/profile identity, profile version, chain scope, compact-result contract, tool/risk policy, budgets, and x402 pricing route;
- `cairnstone-paid-agent-request-v1` â€” caller + service/profile + target chain + task + generation/output bounds + exact V7 `package_id`, with deterministic `service_request_id = sha256(canonical request)`;
- `cairnstone-paid-agent-quote-v1` â€” binds `service_request_id` + `package_id` to the x402 challenge/payment-requirement digest, price, asset, network, payee, and expiry; price authority comes from x402 policy evaluation, never from the model/profile;
- `cairnstone-paid-agent-result-v1` â€” compact answer plus package/request/profile identity, provider/model envelope, tool receipts, x402 settlement receipt, and replay status.

Mandatory execution ordering:

```text
resolve service/profile
  â†’ validate profile scope
  â†’ deterministic V7 bootstrap
  â†’ service_request_id
  â†’ x402 quote/challenge
  â†’ caller payment authorization
  â†’ REVALIDATE service_request_id + package_id/current accepted authority
  â†’ only then x402 verify/settle
  â†’ execute bounded profile delegation
  â†’ persist/link compact result + execution/model/payment receipts
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

## V7.6 â€” Context Efficiency & MCP Surface Optimization

Status: **COMPLETE + LIVE-ACCEPTED through V7.6.5 on runtime `0.5.24`.** The canary/default flip is closed: `optimized_sparse` is the production default, while `legacy_full` remains an explicit caller/config rollback path through `CAIRNSTONE_BOOTSTRAP_DEFAULT_MODE`; missing or invalid config fails safely to `legacy_full`. Final full acceptance run `33934342560` at deployed behavior SHA `e48380c21f8f4c35f8e0ca218dcdf54665dcc7a4` passed the V7.0/V7.2/V7.3/V7.4/V7.6 regression matrix plus full syntax/regression checks. Real rollback run `33934232845` at rollback SHA `973090a51b5cc32b9354b7253d4bb459fca917d6` proved omitted-mode `legacy_full` behavior at about 63,261 / 64,000 bytes before the deliberate flip back to sparse. The production bootstrap ceiling remains **64K**. Sparse mode still cryptographically commits the complete accepted path-head vector; BM25/search remains supplemental only; `docs/AI_OPERATING_GUIDE.md` remains canonical instruction authority and the runtime brief remains only its identity-bound compiled representation; no provider credentials enter model-visible packages; models gain no mutation/execution authority; human-confirmed mutation boundaries remain intact; V7.5 real settlement remains separately gated. Native hydration remains optional; portable Tool Vault behavior remains the correctness path for clients that do not dynamically rebind.

Primary goals:

- add exact context-cost telemetry for MCP schemas and V7 bootstrap packages;
- reduce model-visible bootstrap size with a sparse, cryptographically complete authority envelope while keeping the full accepted path-head set authoritative server-side;
- add compact orientation/manifest response modes for mature chains;
- make **Deferred Tool Hydration / the CairnStone Tool Vault** the first behavior-changing optimization after the V7.6.0 profiler: keep full tool contracts server-side, expose a tiny core MCP surface, search/select only relevant capabilities, hydrate exact contracts on demand, and preserve the full `/mcp` surface as compatibility/rollback;
- consider a Git-versioned, CairnStone-accepted runtime instruction brief only after lower-risk authority/tool-surface wins are measured;
- preserve legacy full-context behavior as a rollback path until optimized behavior is live-accepted.

Initial measured baseline (2026-08-30): connected production MCP `0.5.19` advertises 51 tools; minimal V7 bootstrap measured 44,133 bytes with zero memory hits/inbox items; a normal bounded bootstrap measured 57,563 bytes. GitHub `main` is already ahead at commit `ecf7442da977c0b7790b3e0f39f4e564cb9eb9fc` / package version `0.5.20`, so repo SHA and live deployed runtime must be recorded separately in every acceptance result.

### V7.6.0 â€” Exact context-cost profiler

First implementation slice; **no behavioral/default change**. Measure serialized tool-schema bytes, estimated schema tokens, bootstrap section bytes/tokens, provider actual input/output tokens when available, total estimated CairnStone startup footprint, and context-window percentage. Measurements must derive from exact server-exposed definitions and serialized packages, not hand-maintained estimates.

### V7.6.1 â€” Sparse authority envelope

Status: **COMPLETE + LIVE-VERIFIED.** `cairnstone_agent_bootstrap` now supports explicit opt-in `optimized_sparse` alongside unchanged/default `legacy_full`. Sparse mode preserves the canonical chain HEAD, hashes the complete sorted accepted `(path, stone_hash)` pointer set into `path_heads_digest`, binds that root plus chain HEAD/count into `authority_manifest_id`, transmits only deterministic task-relevant represented path HEAD metadata, and exposes deterministic full expansion through `cairnstone_resume_chain`. Initial/final compile race fingerprints still cover every accepted path HEAD, including omitted heads, and sparse `package_id` commits to the complete authority root so an omitted accepted-head change changes identity and fails race/integrity checks as appropriate. Historical evidence is never promoted into accepted authority.

Strict production acceptance run `33700403342` at runtime/workflow commit `e9076c9d52d6ec41ab535dc47b1929d75aebbf96` passed the full regression suite, deployment, legacy/default compatibility, deterministic sparse repeat identity, complete-root tamper rejection, accepted-state immutability, and real Workers AI + DeepSeek routing with provider-neutral package/request identity preserved. The live mature-chain measurement was **63,345 B legacy package vs 61,153 B sparse package (-3.46%)**, while the authority section fell from **22,579 B to 5,594 B (-75.22%)** with **24/117** accepted path heads represented and all 117 cryptographically committed. The smaller envelope also retained additional bounded memory evidence that legacy size discipline had to trim, so whole-package savings are intentionally reported separately from authority-section savings. The overall V7.6 >=50% mature-chain package target therefore remains an optimization-track target rather than a V7.6.1-only claim.

The acceptance process also surfaced and fixed a pre-existing determinism weakness in memory retrieval: equal-BM25 FTS rows and fallback rows now have stable `stone_hash` / `ref_id` tie-breaking. `legacy_full` remains the production/default rollback path; no default flip occurred. V7.6.3 compact orientation/manifest reads are now complete; V7.6.4 is next if still worthwhile after the measured compact-read win.

### V7.6.2 â€” Deferred Tool Hydration / CairnStone Tool Vault

Status: **NEXT BUILD AFTER V7.6.0 PROFILER.** V7.6.0 remains the required no-behavior-change measurement pass so the before/after savings are exact; V7.6.2 is the first behavior-changing context optimization to implement once that baseline is recorded. The previously planned sparse-authority and compact-read work remain in V7.6, but tool-schema deferral moves ahead of them because the current 51-tool catalog is a large avoidable startup tax and the existing V7.3 registry/policy/execute primitives already provide much of the required control plane.

Keep the existing full `/mcp` surface intact as the legacy/full compatibility profile. Add a portable deferred-tool profile, working name `/mcp/core`, whose boot-visible schema set stays small even as the server-side catalog grows from 51 to hundreds or thousands of tools.

#### V7.6.2a â€” Portable deferred-tool mode

The server owns a canonical **Tool Vault** containing every full tool schema plus tool identity, availability, risk class, authorization requirement, policy metadata, and registry/version identity. Those full contracts are not model-visible at boot unless the caller chooses the legacy/full profile.

The core profile should expose only the minimum boot/runtime primitives needed to discover and safely invoke everything else, targeting roughly 6-8 native schemas rather than the full catalog. The exact names may reuse or extend existing V7.3 primitives, but the capability contract should include:

- health/status and bootstrap/resume;
- bounded evidence find/search;
- `cairnstone_tool_search(query, top_k)` â€” returns only a compact ranked candidate set, not the full catalog;
- `cairnstone_get_tool_contract(tool_id)` â€” returns one exact on-demand contract including full input schema, `schema_hash`, risk class, authorization policy, availability, and registry identity;
- `cairnstone_tool_policy_preview` â€” preserves the current deterministic policy boundary;
- `cairnstone_tool_execute` â€” governed generic execution after exact contract validation;
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

#### V7.6.2b â€” Optional native dynamic hydration

Status: **IMPLEMENTATION COMPLETE + LIVE-VERIFIED** at immutable repo commit `3ae8bd8f490d1aff1d60c16c3a7bc8d919ecc529`, GitHub Actions run `33633072811`. Production `/mcp/core` now supports D1-backed bounded session state, `cairnstone_load_tools(tool_ids[])`, session-scoped `tools/list` / `tools/call`, `capabilities.tools.listChanged` only when a real session is established, genuine `notifications/tools/list_changed` delivery before the tool result for SSE-capable callers, honest `portable_fallback_required:true` for JSON-only callers, isolated sessions, mutation-class hydration rejection, expiry/delete lifecycle, and fail-closed deleted/unknown-session behavior. Migration `0011_v7_6_2b_mcp_core_sessions.sql` is applied live. Full `/mcp` remains unchanged. Runtime remains `0.5.20`; the live catalog now advertises 54 full tools and 9 core tools including `cairnstone_load_tools`. The 296-test suite and targeted live acceptance passed, and accepted `src/index.js` / `src/mcp-session.js` stones are AST-lint clean.

The **separate recommendation/default interop gate remains open**: ChatGPT, Claude, and at least one independent MCP host still need to prove that their clients actually refresh/rebind native schemas mid-session. This does not reopen V7.6.2b implementation correctness and does not block portable Tool Vault correctness; clients that do not support refresh remain fully capable through `tool_search -> get_tool_contract -> governed tool_execute`.

After the portable deferred mode is live-accepted, native MCP dynamic hydration is available as an optimization for clients that prove they support it reliably. `cairnstone_load_tools(tool_ids[])` updates a session-scoped enabled-tool set and uses MCP tool-list change semantics so capable clients can re-fetch `tools/list` and expose the selected native schemas directly.

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

Execution priority inside V7.6 is now closed: **V7.6.0 exact profiler COMPLETE -> V7.6.2a portable Deferred Tool Hydration COMPLETE -> V7.6.2b native hydration implementation COMPLETE (cross-client recommendation gate remains separate) -> V7.6.1 sparse authority COMPLETE -> V7.6.3 compact reads COMPLETE -> V7.6.4 canonical instruction runtime brief COMPLETE -> V7.6.5 canary/default flip COMPLETE + final-live-accepted.**

### V7.6.3 â€” Compact orientation/manifest reads

Status: **COMPLETE + LIVE-VERIFIED on runtime 0.5.21.** Full `cairnstone_resume_chain` remains the backward-compatible default. Explicit `detail=compact` now returns canonical HEAD + provenance, the complete V7.6.1 `cairnstone-sparse-authority-v1` root/digest/counts, every edge touching HEAD, an accepted-state cursor, and only exact requested `paths[]` and/or accepted path heads updated since an ISO cursor. `cairnstone_manifest_v2 detail=orientation` exposes the same bounded authority-preserving orientation surface, while explicit full expansion remains available and identity-bound to the compact response.

Strict production acceptance run `33705805798` at deployed acceptance/workflow commit `d0d96950ea07a3e022cf053e0cfbe0bee6c8c61a` passed the full regression suite, deployment, exact authority-root/digest parity with V7.6.1 `optimized_sparse`, requested-path selection, zero-path orientation, future-cursor delta behavior, manifest-orientation parity, explicit full-expansion identity, serialized-size ordering, and unchanged accepted chain/path-head state. The mature-chain measurement at **118 accepted paths** was **30,414 B full resume -> 4,606 B compact one-path (-84.85%)**, with **4,337 B** for zero-path compact orientation and **4,634 B** for one-path manifest orientation. Fixed-size documentation claims were removed in favor of measured telemetry.

No default flip occurred. Full resume remains the compatibility/rollback path; compact/orientation reads are additive opt-in modes. V7.6.4 is next only if a canonical instruction runtime brief remains worthwhile after these measured lower-risk gains.

### V7.6.4 â€” Canonical instruction runtime brief

Status: **COMPLETE + LIVE-VERIFIED on runtime `0.5.24`.** The full `docs/AI_OPERATING_GUIDE.md` remains sole canonical instruction authority; `docs/AI_RUNTIME_BRIEF.json` is an accepted, Git-versioned, identity-bound compiled representation that `cairnstone_agent_bootstrap` may select under explicit opt-in `optimized_sparse` mode. `legacy_full` remains the production/default rollback path.

`docs/AI_RUNTIME_BRIEF.json` is CairnStone-accepted at path HEAD `fd077d0f4a7832696a6506bc6df1de96eacb28420af9d39ba8ca664f9b88bb46`, Git-backed at immutable commit `3bc60af184f664431eeb1980a3b59b0d6d75f8c7`, and identity-bound to the accepted full-guide stone `ceda7249c1e624133fde669405b0e5a6c477bf4b3cd25624651da809d1977260` (guide commit `4bf89402e87fdd86d2d01f749ce236902bd2d8c4`, 24,674 bytes, SHA-256 `52eb1ec4278a0150d7f00e05810090596d354c513e7adb1da08cc11d13feb550`).

Two live acceptance phases passed on final implementation/workflow commit `3bc60af184f664431eeb1980a3b59b0d6d75f8c7`:

- **Phase 1 (`33778437564`)** â€” pre-acceptance safety branch: with no accepted runtime-brief path HEAD, explicit `optimized_sparse` fell back to the complete accepted guide with typed `runtime_brief_unaccepted` semantics; full regression and deployment passed.
- **Phase 2 (`33780053649`)** â€” after acceptance: proved accepted `runtime_brief` selection, retained full-guide canonical identity, deterministic repeat package/transmitted-content identity, package-ID-bound selection metadata, fail-closed `invalid_context_package`/`package_id_hash_mismatch` on deliberate stone-hash tamper, and unchanged accepted project state from bootstrap/model-route acceptance.

Measured live reduction from run `33780053649`: full guide instructions 24,674 B vs runtime-brief instructions 4,728 B (-80.84%, 5.22x smaller); legacy bootstrap package 61,113 B vs optimized bootstrap package 20,683 B (-66.16%, 2.95x smaller). This clears the V7.6 mature-chain >=50% package-reduction target for the accepted sample.

All V7.6.4 changed repo paths are re-stoned/accepted at final immutable commit `3bc60af184f664431eeb1980a3b59b0d6d75f8c7` with zero drift: `docs/AI_RUNTIME_BRIEF.json`, `src/agent-bootstrap.js`, `test/agent-bootstrap.test.js`, `src/index.js`, `docs/V7_0_CONTEXT_COMPILER_CONTRACT.md`, and `.github/workflows/deploy-cloudflare.yml`. All three supported JS/test stones (`src/agent-bootstrap.js`, `src/index.js`, `test/agent-bootstrap.test.js`) AST-lint with 0 errors. JSON/Markdown/YAML changes were validated through the two live acceptance runs rather than AST lint.

Invariants preserved: `docs/AI_OPERATING_GUIDE.md` remains sole canonical instruction authority; the runtime brief never expands authority; after V7.6.5, `optimized_sparse` is the production default and `legacy_full` remains an explicit/config rollback path.

### V7.6.5 â€” Canary/default flip

Status: **COMPLETE + FINAL-LIVE-ACCEPTED.** The production default is now `optimized_sparse`. Final full acceptance run `33934342560` at behavior SHA `e48380c21f8f4c35f8e0ca218dcdf54665dcc7a4` passed the selected V7.0-V7.6 gates together, including authority-first retrieval, bounded read-only delegation, tool-broker policy, mutation stop boundary, cross-provider/profile grounding, sparse authority, compact orientation, canonical runtime brief, native hydration/transport semantics, and the full syntax/regression suite. A post-run omitted-mode live bootstrap returned runtime `0.5.24`, `optimized_sparse`, `runtime_brief`, 129 total accepted path heads with 24 represented / 105 omitted, full authority digest/vector commitment, a bounded 16,821 / 64,000 byte package, no provider credentials, and zero execution/mutation authority. The real config-only rollback was exercised at SHA `973090a51b5cc32b9354b7253d4bb459fca917d6`, run `33934232845` (SUCCESS), where omitted mode returned `legacy_full` at about 63,261 / 64,000 bytes; production was then deliberately flipped back to `optimized_sparse`. Explicit caller mode still overrides config, and invalid/missing config fails safely to `legacy_full`. Do not raise the 64K production ceiling.

Initial quantitative targets: >=50% reduction in mature-chain bootstrap bytes; >=50% reduction in tool-schema bytes for the recommended core profile; approximately 8k-15k combined startup tokens where task complexity permits; zero authority/policy regression and no extra model calls merely to reconstruct deterministic CairnStone state.

Canonical detailed plan: `project-memory/v76-context-efficiency-optimization-plan.md`.

---

## V7.7 â€” Vault / Workspace Navigation + Multi-Chain Intelligence

Status: **ACTIVE EVOLUTION â€” V7.7.7f Persistent Code Mode Console UX is COMPLETE / LIVE-VERIFIED; V7.7.8 Progressive Grounded Chat LOD is the next planned product slice; V7.7.9 Console UX Architecture + Responsive Shell is planned immediately after V7.7.8.** V7.7 must continue to work through the portable CairnStone runtime and cannot make correctness depend on experimental native tool hydration.

### Goal

Turn CairnStone from a Console centered on one manually entered chain into a navigable semantic workspace over every stoned project, while preserving the existing chain and path-HEAD authority model. A user should be able to select one chain, one repository, several repositories/chains, or the bounded vault and then use the same scope across Chat, Evidence, Activity, Stones, and relevant handoff/correspondence views.

The core rule is: **scope is navigation and retrieval context, never a new source of canonical authority.** V7.7 must not create a synthetic global HEAD. Every participating chain keeps its own canonical chain HEAD and accepted path HEADs, and every cross-chain answer must preserve the chain/repo/stone/path/commit provenance and authority class of its evidence.

### V7.7.0 â€” Vault catalog + scope contract

Add a read-only vault/chain discovery primitive and a versioned `cairnstone-scope-v1` contract. The catalog should expose normalized chain descriptors, repository provenance when present, canonical HEAD identity, path-head/stone counts, and bounded activity metadata. Chains with no GitHub repository provenance must remain visible. Repository membership is derived from CairnStone accepted provenance, not from mutable Git branches.

Scopes must support single-chain, repository, explicit multi-chain/multi-repository, and vault-wide modes. Server resolution produces an exact bounded set of chains plus the chain HEAD identities used for that request, with a stable scope/snapshot identity and fail-closed race semantics when authority pointers change during compilation.

### V7.7.1 â€” Server-side multi-chain search

Extend the current vault search plane with explicit multi-chain scope rather than requiring the browser to fan out N independent searches and merge them. Preserve per-hit `chain`, `repo`, `stone_hash`, `path`, immutable commit provenance when available, and authority classification (`CHAIN_HEAD`, `PATH_HEAD`, historical/derived). Apply deterministic ranking, bounded expansion, and fairness so a large chain cannot dominate solely because it contains more refs.

### V7.7.2 â€” Cross-chain grounded Q&A

Add scope-grounded Q&A, working name `cairnstone_ask_scope`. Resolve the scope deterministically, inject the canonical orientation for each participating chain within explicit budgets, prefer accepted path HEADs, label historical evidence, synthesize only after retrieval, and validate every citation against evidence actually supplied to the model. Answers must make repo/chain provenance visible enough to distinguish conclusions across projects.

If a participating authority pointer changes during scope compilation or citation grounding, fail closed or deterministically re-resolve; never silently combine evidence from two authority snapshots. Persisted cross-scope answers, if later enabled, belong only in a derived workspace/ask chain and never move any source chain or path HEAD.

### V7.7.3 â€” Console global Scope navigation + Bird's Eye / Universe view

Replace the current single Chain field with a mobile-first **Scope** control with two complementary projections: a fast searchable list/recents selector for known targets and an optional full-screen **Bird's Eye / Universe** spatial navigator for large stoned accounts. The spatial view should expose `All CairnStone`, repository nodes, bounded child-chain unfold, explicit multi-select, and search-to-focus while resolving to the exact same `cairnstone-scope-v1` selectors as the list UI. A compact summary such as `2 repos Â· 4 chains` remains visible after selection.

The resolved Scope becomes shared Console state for Chat, Evidence, Activity, and Stones, with Handoff/Inbox filtering only where real message metadata supports the association. The Universe is a **projection, not authority**: coordinates, clustering, animation, and semantic proximity never create accepted-state or CairnStone graph relationships. Permanent visual edges require grounded stored relationships; temporary search/retrieval/reasoning paths must remain visibly non-persistent. Use semantic LOD so repo overview does not render every chain or stone. The initial renderer may reuse/adapt interaction patterns from `nothinginfinity/prax-your-universe` (Three.js orbit/zoom, sphere/grid projections, raycast selection) without adopting its persistence/domain model. Do not fabricate repository ownership for correspondence that has no such provenance. The Console remains a client of CairnStone authority, never a competing source of truth.

### V7.7.4 â€” Saved workspaces + cross-repo operating views

After core scope semantics are accepted, add named convenience scopes such as `CairnStone Platform`, `Music Projects`, or `Everything`, plus cross-repo views for recent accepted work, handoffs, evidence, and activity. Saved workspace definitions are operational/user convenience state only; local persistence may ship first and cross-device persistence may remain deferred. Workspace state must never grant execution/mutation authority or alter accepted-state pointers.

### V7.7.5 â€” Live acceptance + scale gate

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
- fast list/search and Bird's Eye / Universe selection resolve to the same canonical Scope, with semantic LOD, bounded unfold, multi-select, search-to-focus, and a usable list fallback when WebGL/spatial rendering is unavailable;
- visual layout/proximity never creates accepted authority or stored graph edges, and temporary retrieval/reasoning paths are visibly non-persistent;
- live tests cover at least three genuinely stoned repositories and exercise single-chain, repo, multi-repo, and vault modes;
- the milestone works through full `/mcp` and portable `/mcp/core` Tool Vault paths without relying on native dynamic hydration.

### V7.7.6 â€” Console Workspace Invitations + Capability lifecycle

Status: **COMPLETE / CLOSED.** Principal-bound workspace invitations, trusted-human mailbox capability issuance, recipient-authenticated claims, and cross-model lifecycle acceptance are now part of the live Console/runtime path. Correspondence and invitation transport remain non-authoritative; workspace capabilities remain scoped authority and are never persisted into Stones/chat.

### V7.7.7 â€” Persistent Code Mode / Durable Multi-Agent Code Sessions

Status: **COMPLETE / LIVE-VERIFIED through V7.7.7f on runtime 0.5.36.** Durable Code Sessions now cover deterministic resume context, immutable checkpoints, task transitions, leases, repo-scale working trees and Git/GitZip transport, environment manifests, disposable sandbox attachment, execution receipts, and the Console Code Session operator surface. This is the functional base for the later Work UX redesign.

### V7.7.8 â€” Progressive Grounded Chat LOD

Status: **IN PROGRESS â€” V7.7.8a/b/d in-repo (worker `0.5.38`); V7.7.8c Console Answer Depth UX live-verified separately.** Default grounded answers become the smallest sufficient response and expand lazily through `response_lod` 1â†’5 while preserving one `response_id`, one Scope/authority snapshot, one evidence-set identity, and one claim/conclusion skeleton. Cross-provider envelope reattribution and stale/view_original/refresh acceptance are covered by V7.7.8d. Canonical contract: `docs/V7_7_8_PROGRESSIVE_GROUNDED_CHAT_LOD.md`. Implementation notes: `docs/V7_7_8A_GROUNDED_RESPONSE_CONTRACT.md`, `docs/V7_7_8D_CROSS_PROVIDER_STALE_ACCEPTANCE.md`.

### V7.7.9 â€” Console UX Architecture + Responsive Shell

Status: **PLANNED / AFTER V7.7.8.** This is the deliberate whole-Console information-architecture pass. Chat becomes the normal landing surface; primary navigation collapses toward a task-oriented `Chat Â· Work Â· Universe Â· Inbox Â· More` model (or acceptance-tested equivalent); Runtime/Scope/provider/session state moves into compact contextual controls; V7.7.7f Code evolves into a Work surface; Inbox/Handoff/Activity become a coherent communications experience; Evidence/Stones become contextual drill-downs; Authorize remains a visibly distinct trusted-human boundary; and progressive disclosure/LOD-style interaction becomes a Console-wide design rule.

V7.7.9 also carries the **Bird's Eye / Universe v2** follow-on: semantic zoom from Vault â†’ Repo â†’ Chain â†’ Intelligence, richer mobile spatial interaction using `prax-your-universe` patterns where useful, list/grid parity, search-to-focus, selection preservation, and bounded current-LOD loading. Spatial presentation remains projection metadata only and creates no authority or graph edges.

Initial slices:

- `V7.7.9a` â€” Information Architecture + Responsive Shell
- `V7.7.9b` â€” Chat + contextual evidence integration
- `V7.7.9c` â€” Work + communications consolidation
- `V7.7.9d` â€” Universe v2
- `V7.7.9e` â€” Progressive disclosure + Saved Views
- `V7.7.9f` â€” Cross-device UX acceptance

Canonical detailed plan: `docs/V7_7_9_CONSOLE_UX_ARCHITECTURE.md`.

Canonical V7.7 multi-chain plan: `project-memory/v77-vault-workspace-multi-chain-intelligence-plan.md`.

### V7.7.10 â€” Persistent Conversational Control Plane + Agent Execution Fabric

Status: **IN PROGRESS â€” V7.7.10d.1 native vs compiled executor context on worker `0.5.43` (builds on 10d `0.5.42` tip `939e9d8cc6fdface58331a6c06bac73d6e73ea7b`; 10d COMPLETE gate `7a9fb4b06a4ba9879e3f431cc906a2994f65028a6cac7b278072c103bd5c4d4d`).** Hold 10e. Worker slice contract: `docs/V7_7_10D_MODEL_AGENT_EXECUTION_ROUTING.md` + `project-memory/v7710d1-native-context-implementation-note.md`.

Family slices (authoritative; do not invent alternate numbering):

- `V7.7.10a` â€” Conversation Session contract + persistence (**complete / live-verified** on `0.5.39`)
- `V7.7.10b` â€” Typed attachments + Give Access / Assign entry points (**complete** on `0.5.40`)
- `V7.7.10c` â€” Deterministic Intent Router (**complete** on `0.5.41`)
- `V7.7.10d` â€” Model + Agent Execution Routing (COMPLETE gate on `0.5.42`)
- `V7.7.10d.1` â€” CairnStone-native vs compiled executor context (**this worker slice** on `0.5.43` â€” hold 10e)
- `V7.7.10e` â€” Human Proposal / Commit Boundary
- `V7.7.10f` â€” Live Event Plane + Agent Tree
- `V7.7.10g` â€” Context Retention Plane / Semantic Working-Set GC (**planned after 10f acceptance**)
- `V7.7.10h` â€” Semantic Capability Gateway / Decision Plane (**planned; shared decision layer for tools, retrieval, routing, and Persistent Code Mode**)
- `V7.7.10i` â€” Connector-Bound Identity + Zero-Friction Bootstrap (**P0 identity gate; advance before new Console feature expansion, multi-account onboarding, and federation**)
- `V7.7.10j` â€” Role-Scoped Tool Belts / Capability Profiles (**design + read-only contract may proceed after 10i.0 review; account-bound mutation-capable activation remains gated on 10i identity**)

Conversation Session is operational D1 only (`accepted_state_authority: false`); it never moves chain/path HEADs and never bulk-promotes chat history into project memory.

#### V7.7.10g â€” Context Retention Plane / Semantic Working-Set GC

Status: **PLANNED / AFTER V7.7.10f ACCEPTANCE â€” implementation not started.**

Add a provider-neutral runtime retention layer for long-lived Conversation Sessions and Code Sessions. The plane may score old tool calls/results and other recoverable working artifacts for `PIN | KEEP_FULL | KEEP_REF | DROP_FROM_ACTIVE_CONTEXT`, but it only changes the next **model-visible context projection**. It never deletes or probabilistically redefines durable authority/provenance.

The design is inspired by Jev-style compaction, but Jev/TypeSafe is an optional initial scorer rather than a required dependency. A compact CairnStone artifact ledger is evaluated first; deterministic policy protects authority, unresolved blockers, guards, and non-rehydratable evidence; optional scorer output is advisory; exact refs allow lazy rehydration.

Hard invariant:

> **Semantically lossy active context, structurally lossless durable state.**

Chain/path HEADs, Stones, immutable Git provenance, accepted skills, Scope snapshots, access/authorization state, checkpoints, execution/Work Receipts, grounded-response identity/evidence, and other audit/security objects are outside destructive compaction authority. Secrets/capability bearers never enter scorer-visible state.

This extends V7.6's context-efficiency principle over time: V7.6 transmits less at bootstrap; V7.7.10g keeps less inline as a session evolves, while exact underlying state remains recoverable.

Initial slices:
- `V7.7.10g.0` â€” retention contract + protected classes;
- `V7.7.10g.1` â€” compact artifact ledger + deterministic baseline;
- `V7.7.10g.2` â€” shared Decision Plane scorer integration via V7.7.10h, with Jev as an optional pilot;
- `V7.7.10g.3` â€” exact lazy rehydration;
- `V7.7.10g.4` â€” cross-host/session acceptance + context-cost telemetry.

Canonical detailed plan: `docs/V7_7_10G_CONTEXT_RETENTION_PLANE.md`.

#### V7.7.10h â€” Semantic Capability Gateway / Decision Plane

Status: **IN PROGRESS â€” V7.7.10h.0 deterministic/provider-neutral decision contract is under implementation; first-party Workers AI scoring follows.**

Add a provider-neutral decision layer for small, typed judgments between **deterministically valid candidates**. CairnStone owns the contract, candidate generation, validation, policy, and authority. Workers AI is the default first-party model-assisted scorer path; Jev/BYOK scorers are optional interchangeable adapters, not correctness dependencies.

Core pattern:

```text
task / Code Session / query
  -> deterministic candidate generation
  -> cairnstone-decision-v1
  -> deterministic clear winner / Workers AI / optional Jev-BYOK scorer
  -> validated selection
  -> exact tool/capability hydration
  -> existing CairnStone policy / authorization
  -> read, route, proposal, or stop
```

The scorer may rank/select only candidates supplied by CairnStone. It cannot invent tools, capabilities, models, executors, skills, mutation targets, or permissions.

Initial decision kinds:

- `tool_route`;
- `snippet_rank`;
- `retain`;
- `expand`;
- `model_route`;
- `executor_route`;
- `escalate`;
- `next_action`.

The provider-neutral CairnStone gateway should begin with three bounded modes:

- `route` â€” recommend/rank valid capabilities/tools; execute nothing;
- `hydrate` â€” return the exact selected Tool Vault contract + schema hash; execute nothing;
- `read` â€” permit only already-classified `read + automatic` tools through the existing broker and receipt path.

Mutation/execution/human-confirmation tools stop at the normal proposal/authorization boundary. **No scorer receives execution authority.**

Persistent Code Mode is a priority integration. Code Session task/blocker/checkpoint/receipt/lease state can supply compact semantic context so the Decision Plane chooses the next useful read/retrieval/tool/model/executor path without growing one giant tool surface or chat transcript. V7.7.10g retention is another consumer of the same decision contract, with `retain` as a typed decision kind.

This should remain inside `nothinginfinity/cairnstone-v6`. A separate `ask_jev` Remote MCP repo is deferred unless the faÃ§ade later proves independently useful outside CairnStone, analogous to `afo-ask-copilot`.

Initial slices:

- `V7.7.10h.0` â€” decision contract + deterministic candidate envelope;
- `V7.7.10h.1` â€” CairnStone-native Workers AI scorer + route-only semantic pilot, with deterministic skip/fallback;
- `V7.7.10h.2` â€” Tool Vault hydrate + brokered automatic-read mode;
- `V7.7.10h.3` â€” Persistent Code Mode integration;
- `V7.7.10h.4` â€” shared consumers: 10g retention, snippet ranking, skills/model/executor ambiguity;
- `V7.7.10h.5` â€” cross-host, scale, latency, cost, and routing-quality acceptance.

Canonical detailed plan: `docs/V7_7_10H_SEMANTIC_CAPABILITY_GATEWAY.md`.

---

### V7.7.10i â€” CairnStone Account Identity + Connector-Bound Authorization

Status: **P0 / REVIEW-CORRECTED â€” account-root identity contract accepted for V7.7.10i.0 design work; runtime implementation not started.**

This is the immediate identity/security gate for ecosystem scale. The durable identity root is now the **CairnStone account / Console home**, not a provider account, MCP host installation, wallet account, wallet address, routing alias, or model actor string.

Core chain:

```text
CairnStone account
  -> approved authenticator
  -> OAuth-authorized MCP connection
  -> immutable connection principal
  -> mailbox / workspace memberships + entitlements
  -> existing tool / mutation / execution policy
```

Economic state stays orthogonal:

```text
CairnStone account
  -> optional wallet account link
  -> explicit economic authority / budget
  -> x402 or other settlement adapter
```

The first canary remains additive and reversible:

- add `/mcp/core-auth`; leave `/mcp`, `/mcp/core`, and `/mcp-b` unchanged during canary/rollback;
- reuse/adapt the x402 OAuth/PKCE/token kernel, but do **not** inherit its single-user/provider-family identity assumptions;
- use wallet-backed sign-on as the first authenticator path because that lifecycle already exists, while making `account_id` the durable identity root;
- allow zero-balance wallet-account provisioning with no funding/payment/spend requirement;
- CairnStone mints `connection_id`, immutable per-connection `principal_id`, and `token_family_id`; no universal stable host installation ID is required;
- prefer a separate authenticated D1 security realm for the canary, or fail closed with separate `auth_*` tables plus mandatory realm/tenant/principal predicates;
- carry server-derived identity through Core, `cairnstone_tool_execute`, `cairnstone_load_tools`, hydrated tools, AC1, workspaces, and Persistent Code Mode;
- prefer current MCP authorization semantics: Protected Resource Metadata, PKCE S256, Client ID Metadata Documents where supported, issuer binding, Resource Indicators, short access tokens, refresh rotation/reuse detection, and revocation;
- use the second Perplexity account as the first same-provider isolation proof;
- advance `off -> shadow -> canary -> required` one connector at a time.

Identity invariants:

> **CairnStone account != authenticator != MCP connection != connection principal != wallet account != wallet/payment instrument.**

> **Authentication authority != resource authority != execution authority != mutation authority != economic authority.**

Reconnect semantics are explicit: a valid refresh resumes the same connection/principal; a reinstall or fresh authorization may create a new connection/principal under the same authenticated account while resuming account-owned inbox/workspace/PCM state.

Initial slices:

- `V7.7.10i.0` â€” freeze account/authenticator/connection-principal/token-family contracts, authenticated storage realm, current-MCP OAuth profile, threat model, negative fixtures, and independent review;
- `V7.7.10i.1` â€” additive `/mcp/core-auth`, first wallet-backed authenticator, resource-bound tokens, issuer binding, refresh rotation/reuse detection, principal propagation through indirect tools;
- `V7.7.10i.2` â€” authenticated account/authenticator/connection registry, realm isolation, reconnect/reinstall rules, recovery and wallet/authenticator rotation;
- `V7.7.10i.3` â€” AC1 sender/inbox ownership plus workspace/invite principal binding;
- `V7.7.10i.4` â€” zero-friction account mailbox/workspace/tool/Persistent Code Mode bootstrap;
- `V7.7.10i.5` â€” Console account, authenticators, connections, wallets, tenant selection, link/unlink/revoke/recovery, advanced evidence;
- `V7.7.10i.6` â€” second-Perplexity canary followed by cross-provider multi-user replay/revocation/rollback/isolation acceptance.

Acceptance must prove at minimum:

- URL possession grants no private access;
- legacy callers cannot enumerate/select/act as authenticated principals;
- account A cannot read/send/claim/session-act as B;
- two same-provider accounts never collide;
- one account may hold multiple distinct connection principals;
- connector reinstall can create a new principal without duplicating or losing account-owned durable state;
- wallet rotation/removal does not replace the CairnStone account;
- resource/audience binding blocks cross-resource token replay/substitution; same-resource bearer replay has separate token-lifecycle mitigations;
- secrets never enter Stones, AC1, GitHub, model context, tool JSON, receipts, or ordinary logs;
- mutation/execution/economic authority remain governed by their existing explicit policy boundaries.

Canonical detailed contract: `docs/V7_7_10I_CONNECTOR_BOUND_IDENTITY.md`.

---

### V7.7.10j â€” Role-Scoped Tool Belts / Capability Profiles

Status: **PLANNED / CONTRACT + THREAT-MODEL NEXT â€” no production mutation-capable activation before V7.7.10i identity is implemented and accepted.** Design, linting, and read-only/draft-only prototypes may proceed after the 10i.0 independent review.

Tool Belts make the agent's operational world an explicit CairnStone artifact. The model remains a replaceable reasoning engine; CairnStone defines the reachable action vocabulary, accepted procedures, authoritative knowledge, identity, policy, and evidence trail.

Core constructed-agent model:

```text
model
  + accepted Tool Belt       -> what this role may discover / hydrate / invoke
  + accepted Skill Pack      -> how this role should operate
  + Scope / Stones           -> what this role knows and which state is authoritative
  + Account / Actor identity -> who is wielding the role
  + grants / broker policy   -> what authority is actually usable now
  + session / receipts       -> continuity, evidence, audit
  = CairnStone-constructed agent
```

A Tool Belt is **not** merely an MCP URL and is **not** a second tool registry. It is a versioned, accepted, policy-constrained capability projection over the canonical Tool Vault / broker registry. Routes such as `/mcp/t/:belt` may be convenient transport/profile selectors, but the pathname is never identity or authority.

Effective authority is always an intersection, never an additive grant:

```text
effective capability
  = account grant
  âˆ© authenticated actor / connection principal
  âˆ© accepted Tool Belt policy
  âˆ© object / Scope grant
  âˆ© canonical broker policy + authorization mode
  âˆ© live tool availability / contract integrity
  âˆ© runtime / session state
```

A belt may narrow authority but can never widen it.

#### Authority + storage invariants

- Accepted/versioned belt artifacts are authority. D1/KV may cache compiled belts for performance but cache/config never becomes authority.
- Belt manifests reference canonical Tool Vault tool IDs / abstract capability IDs and immutable accepted skill identities; they do not duplicate live tool schemas.
- Canonical `schema_hash` and risk/authorization classification still come from the live Tool Vault + broker overlay. Missing, unclassified, or schema-disagreeing tools fail closed for executable belt resolution.
- `tools/list` filtering is context shaping only. `tools/call`, generic execution, authorization, and broker policy independently enforce the active belt.
- Generic primitives including tool search, contract hydration, native hydration, capability routing, policy preview, authorization preparation, and tool execution are belt-aware. They cannot discover or execute around the belt.
- Native hydration may only add contracts already allowed by the active belt; `notifications/tools/list_changed` can never widen beyond that belt.
- A URL path or connector name is a selector, not a principal. V7.7.10i account/connection identity determines which belt profiles a caller may activate.
- Every tool/execution/checkpoint receipt should record immutable `belt_id` + version/hash, accepted skill-bundle identity, actor/principal, Scope/object grants, tool-contract/schema hashes, and authorization context.
- Revocation or supersession of a belt prevents new capability resolution while preserving old receipts for audit.

#### Relationship to existing CairnStone layers

- `/mcp/core` remains the universal tiny bootstrap / deferred Tool Vault surface.
- Tool Vault + native hydration answer **which capability does this task need now.ï¿½×›§uçâço¿½wï¿½**
- Tool Belt answers **which capability universe should this role inhabit at all?**
- V7.7.10h Decision Plane may rank/select only candidates already inside the active belt.
- Skills define procedures and verification over belt-available capabilities; skill dependency closure must never introduce a prohibited capability.
- Scope/Stones remain knowledge and accepted-state authority; a belt never promotes evidence or creates synthetic authority.
- `/mcp-b` remains only the client catalog-cache twin and must not acquire semantic belt meaning.

#### Initial role cohort

Begin with deliberately bounded roles:

1. **researcher / read-only** â€” Scope, accepted-state retrieval, grounded Q&A, evidence inspection, correspondence reads as explicitly granted; no writes.
2. **reviewer / read-only** â€” repo/Stone diff, tests/CI/release evidence, provenance, policy inspection; no source mutation.
3. **code-engineer / draft-only** â€” workspace/code-session reads plus draft/patch/test/checkpoint capabilities; no merge, deploy, accepted-state HEAD movement, or economic authority.

Release/deploy/operator belts remain deferred until account-root identity, revocation, and privileged authorization have live acceptance.

#### Initial slices

- `V7.7.10j.0` â€” freeze `cairnstone-tool-belt-v1` contract, threat model, authority-intersection semantics, revocation/supersession model, receipt/audit envelope, route-vs-identity rules;
- `V7.7.10j.1` â€” deterministic belt resolver + linter against canonical Tool Vault classifications/schema hashes and accepted skill dependencies; accepted artifact/path-HEAD workflow; fail-closed drift handling;
- `V7.7.10j.2` â€” read-only activation: belt-filtered `tools/list`, belt-constrained Tool Vault search/hydration, matched accepted Skill Pack + bounded context projection;
- `V7.7.10j.3` â€” server-side enforcement beneath `tools/call`, generic discovery/hydration, Decision Plane routing, broker preview, authorization preparation, and execution; session state namespaced by belt identity/version;
- `V7.7.10j.4` â€” code-engineer draft-only profile + V7.7.10i account/connection-principal binding, revocation, reconnect/reinstall behavior;
- `V7.7.10j.5` â€” cross-model acceptance on at least ChatGPT, Claude, Grok, Perplexity plus one lower-cost/local/Workers-AI-class model; compare the same tasks with full vs belt-scoped surfaces;
- `V7.7.10j.6` â€” privileged/release belt gate only after 10i identity + authorization acceptance; prove no role can widen itself, no path-secret authorization, and no generic Tool Vault escape.

#### Evaluation

Measure the harness hypothesis rather than treating it as an assumption. Compare belt-scoped vs broad/full surfaces using:

- tool-schema/context bytes and tokens;
- unnecessary/invalid tool calls;
- policy denials and attempted out-of-role calls;
- time / model turns to the first correct action;
- tool-selection accuracy;
- completion quality and verification success;
- cross-model variance for the same role/belt/skill/scope package.

The durable principle is:

> **The model supplies reasoning; CairnStone defines the agent's reachable world, authoritative knowledge, permitted operations, and evidence trail.**

Canonical detailed plan: `docs/V7_7_10J_ROLE_SCOPED_TOOL_BELTS.md`.

---

## V7.7.10k â€” Portable Response Profiles / Team Presentation Contracts

Status: **PLANNED / CONTRACT NEXT AFTER V7.7.10i/10j PREREQUISITES.** Add a versioned accepted presentation and deliverable policy for teams that already use different AI host apps. It is **not** model-weight fine-tuning, a Tool Belt, an agent role, a new authorization system, or a claim of identical rendering across apps.

The model and host supply reasoning and native UI. CairnStone supplies project knowledge, accepted response preferences, relevant skills, authorized capability constraints, and verifiable evidence. A profile such as `visual-comparison` should be publishable once for a team/project and resolved in ChatGPT, Claude, and other connected models, with capability-aware native output and honest text/export fallback.

Contract: `cairnstone-response-profile-v1`. Resolve accepted Git/Stone profile identity, version, owner/tenant, nonsecret defaults, effective preference layering, bounded examples, approved skill refs, optional trusted UI-surface preferences and host-renderer compatibility. Use deterministic team/project/member/task preference precedence, but **presentation cannot override platform safety, authenticated principal, object grants, Tool Belt policy, accepted-state evidence or Human Commit**. One account may have multiple connector principals; a team profile never joins accounts or grants access on its own.

The existing standalone browser/PWA CairnStone Console remains the permanent configuration and diagnostic workbench for authorized team/project/member preferences and custom tools. The optional 11h in-chat mini-Console reads the *same* accepted profiles and cannot become the only path to configure or audit them.

Sub-slices: `10k.0` contract/threat model; `10k.1` accepted catalog, linter and visual-comparison pilot; `10k.2` principal-aware read-only resolver + Context Compiler; `10k.3` native-first ChatGPT/Claude compatibility adapters; `10k.4` Console team/project/member controls; `10k.5` optional trusted 11g UI surface and 11h in-chat Console binding; `10k.6` cross-host acceptance and comparative quality/cost evaluation.

Initial acceptance: the same accepted profile and evidence produces semantically consistent, appropriately native outputs across at least two supported hosts; the renderer reports compatibility and falls back safely; members see only authorized team/project profiles; versions/revocation/citations are inspectable; visual choices cannot widen tools, access, mutation or execution authority. Start with a high-quality grounded comparison and actual downloadable document, not a fabricated export.

Canonical detailed plan: `docs/V7_7_10K_PORTABLE_RESPONSE_PROFILES.md`.

---

## V7.7.10l â€” Standalone CairnStone Messages Mini MCP

Status: **IMPLEMENTATION UNDERWAY / TESTER 0.1.3 LIVE / P0 AUTH BRIDGE NEXT.** CairnStone Messages now exists as an independent repo, Worker and isolated D1-backed MCP service. Explicit tester send/idempotency/receipts are implemented, but the current Messages authorization path still parses unverified JWT claims and is **not production identity**. Core remains separate and becomes a client only after standalone acceptance.

The standalone connector exposes only account identity, permission-scoped contacts, thread list/read, explicit send, and read receipts. It owns human communications state in an independent Messages Worker + Messages D1/R2 boundary and must not expose Stones, code execution, arbitrary Tool Vault hydration, wallets, project search or the full Core catalog. Reuse AC1 concepts such as stable message/thread IDs, delivery state and idempotency, but private human message bodies are **not accepted project-memory Stones by default**.

The product must work through ordinary MCP tools first, with an optional trusted Inbox/Thread/Composer MCP App on compatible hosts and an independent mobile-first Messages PWA fallback. A Messages-only account is valid; connecting Core is an optional upgrade. Prefer one CairnStone account/auth root with resource/audience-scoped authorization for the separate Messages resource server rather than a second identity universe. Coreâ†’Messages integration may use an internal Worker service binding/RPC boundary, but downstream user/service authorization must remain explicit.

Current sequence: `10l.0` product/security contract **frozen**; `10l.1` independent Worker + isolated Messages D1 **live**; `10l.2` 1:1 store + explicit tester send/idempotency/receipts **implemented**; **`10l.3` 10i-compatible Messages Auth Bridge is P0 next**; `10l.4` invitation/contact bootstrap; `10l.5` authenticated cross-host hero acceptance; `10l.6` trusted MCP App + standalone Messages PWA; `10l.7` CairnStone Core service bridge; `10l.8` notifications/privacy operations/controlled beta. Email, calendar, voice/video, attachments, group channels, federation and paid/x402 communications remain separate later modules.

10l.3 temporarily closes tester send, replaces `decodeUnverifiedJwt()` authority with server-verified 10i account-root authorization, and reopens send only after forged/random/expired/revoked/wrong-resource/wrong-scope/cross-account tests pass. Because Core-auth currently uses opaque `csat_*` access tokens, the first bridge should consume a narrow server-side verification/introspection contract (preferably Worker Service Binding/RPC) rather than create a second JWT identity universe or bind Messages directly to Core/Auth D1. **Invites come after auth and before the PWA.**

Hero proof: **ChatGPT-connected A sends â†’ independently authorized Claude-connected B reads/replies â†’ A sees the same thread/receipt state in Messages PWA, while unrelated C cannot enumerate the thread and no Core project is required.** Measure the â€œsticky connectorâ€ hypothesis with activation, first reply, cross-host reply and returning-user metrics rather than assuming retention.

Canonical candidate plan: `docs/V7_7_10L_STANDALONE_MESSAGES_MCP.md`.

---

## V7.7.11 â€” Mobile Home Surface / Installable PWA Dashboard + Guided/Adaptive UI

Status: **PLANNED / AFTER V7.7.10 ACCEPTANCE.** Preserve the independent full browser/PWA CairnStone Console as the permanent operator control center for all permission-scoped messages, backend observability, team/project settings, custom-tool/skill test and inspection, connection/access administration and Human Commit. The in-chat Console is an optional, smaller host-native projection over the same secured server contracts, never a replacement or the exclusive route to a backend function. Start inside `nothinginfinity/cairnstone-v6-console`, using the proven InfinityPaste PWA pattern. First deliver an installable iPhone Home Screen PWA and compact CairnStone dashboard, then test a generalized `Source + View + Action + Appearance` surface schema. Do **not** create a standalone repo until the schema proves useful across at least three distinct sources/products including a non-CairnStone source and the renderer/configuration lifecycle is clearly separable from Console releases. No new accepted-state or execution authority is introduced.

Later family slices extend that surface safely:

- `V7.7.11e` â€” Guided Mode / Conversational Cursor + Simple Stone workflows over stable semantic UI targets;
- `V7.7.11f` â€” Simple Stone Library / portability;
- `V7.7.11g` â€” **Safe Adaptive UI / Surface Composer**: bounded component/action catalog, declarative validated surface specs, deterministic-first composition, and optional V7.7.10h/Jev advisory selection among application-supplied UI candidates.

- `V7.7.11h` â€” **In-Chat CairnStone Console / Host-Native App Surfaces**: optional compact authenticated Home/Work/Inbox/Evidence/10k Profile cards through supported host MCP Apps, backed by the same 11g trusted catalog, backend and 10i account principals. The permanent full standalone web/PWA Console retains complete authorized message inspection, system administration, custom tool testing, configuration and audit; it is never deprecated by 11h. Require host capability detection, functional read-only Markdown/deep-link fallback and an `Open Full Console` path. A rendered card grants nothing; consequential actions continue through the independent Human Commit/broker path.


- `V7.7.11i` â€” **Core / Full-Console / Rich In-Chat Communications Integration**: after standalone 10l identity/isolation acceptance, consume the accepted Messages service for explicit authorized human direct/group/project messaging while keeping AC1 as the separate agent/work correspondence plane; present the same secure Inbox/Composer in the permanent full standalone Console and optional 11h in-chat MCP App, with assistant-mediated tool or authenticated Console deep-link fallback. Introduce recipient discovery, participant-scoped ACLs, privacy/retention design, idempotent send/receipt semantics, rate limits and opt-in notifications as gated slices. Treat email (consented mailbox adapter) and voice/video (independent conferencing/WebRTC adapter with PWA fallback) as **separate future integrations** after messaging privacy acceptance, not automatic MCP capabilities. Never imply native host chat-history injection, universal in-chat camera/mic support, automatic recipient notifications, or blanket project-memory ingestion. The aside/future-feature parking lot includes calendar meetings, voice notes, consented transcription/translation, richer group collaboration and cross-org federation. Preserve 10i/10j authority and 11g/11h UI separation; full standalone Console remains the independent message/admin hub. Canonical candidate contract: `docs/V7_7_11I_CROSS_HOST_COMMUNICATIONS.md`.

11g is inspired by `vercel-labs/json-render` at immutable upstream commit `3ad381881194e7011ad3ccd6d668033495a06c29`, preserved under CairnStone reference chain `reference:vercel-labs/json-render`. CairnStone adapts the catalog/spec/renderer/validation/action-separation pattern; it does not make json-render or Jev a correctness dependency. The stable V7.7.9 shell and Human Commit / Authorize boundary remain outside adaptive model control.

Canonical detailed plans:

- `docs/V7_7_11_MOBILE_HOME_SURFACE.md`
- `docs/V7_7_11E_GUIDED_MODE_SIMPLE_STONES.md`
- `docs/V7_7_11G_SAFE_ADAPTIVE_UI_SURFACE.md`;
- `docs/V7_7_11H_IN_CHAT_CONSOLE.md`,
- `docs/V7_7_10L_STANDALONE_MESSAGES_MCP.md`,
- `docs/V7_7_11I_CROSS_HOST_COMMUNICATIONS.md`.

---

## V7.8 â€” CairnStone Federation / StoneLink

Status: **PLANNED / AFTER V7.7 ACCEPTANCE.** V7.8 is a federation layer over the V7.7 Scope model, not a replacement for current V7.7 work. The working protocol name is **StoneLink**. Initial federation is discovery-first and read-only-first; public discovery never implies public mutation.

### Goal

Extend CairnStone from one bounded vault/workspace into a federation of independently owned CairnStone nodes that can discover one another by domain, exchange provenance-preserving knowledge, search/query across selected external vaults, and route AC1 correspondence without collapsing their independent authority models.

The core separation is:

> **DNS / `.well-known` provides discovery and node identity hints; MCP/HTTPS carries manifests, Stones, search/Q&A, and correspondence. DNS is not the Stone/message transport and is never accepted-state authority.**

MCP and ordinary HTTP APIs should be supported as complementary interfaces over one capability/authority model rather than competing protocols.

### Federation invariants

- every vault/node keeps its own chain HEADs, path HEADs, signatures, policy, and mutation authority;
- external evidence is never silently promoted into local accepted state;
- public/authless access is read-only unless a later explicit local authorization policy says otherwise;
- V7.3 guarded mutation/authorization boundaries remain authoritative for consequential actions;
- external scope resolution is bounded, provenance-preserving, race-aware, and fail-closed;
- provider/model choice never changes node/Stone/Scope authority identity;
- discovery metadata may be cached, but cache state is never authority;
- cross-vault reasoning must retain issuer/domain/node/chain/stone/path/commit/signature provenance where available.

### V7.8.0 â€” Public node manifest

Define a versioned public node descriptor, working name `cairnstone-node-manifest-v1`, retrievable from a deterministic public endpoint such as `/.well-known/cairnstone`.

The manifest should expose only intentionally public machine metadata, including:

- canonical node/domain identity;
- supported CairnStone federation protocol versions;
- MCP and/or HTTPS API endpoints;
- supported discovery/query/correspondence capabilities;
- public/semi-public/private capability classes without leaking private tool schemas;
- public signing key or stable key fingerprint/rotation metadata;
- explicit size/rate/cache limits;
- optional public authority/head digest summaries suitable for change detection but not as a replacement for signed manifests or local acceptance.

The manifest itself must be canonicalized, content-identifiable, cacheable under bounded TTL, and verifiable against the domain/node identity.

### V7.8.1 â€” DNS + `.well-known` discovery

Use DNS as a lightweight discovery/control plane, not as the data plane. A domain may advertise that it participates in StoneLink and where its canonical node manifest lives. Prefer standards-aligned service discovery where practical (for example HTTPS/SVCB-style service hints) with a bounded TXT fallback if needed.

Discovery must specify:

- deterministic mapping from domain -> node manifest endpoint;
- domain/origin verification and redirect policy;
- TTL/cache semantics and stale-manifest handling;
- downgrade/version negotiation behavior;
- duplicate/conflicting record handling;
- fail-closed behavior for malformed, spoofed, or unverifiable discovery data;
- no requirement to place Stone bodies or AC1 messages in DNS records.

### V7.8.2 â€” External read-only Scope

Extend the V7.7 Scope model to represent explicitly selected external nodes/vaults without merging them into one synthetic authority graph. A caller should be able to select local chains/repos plus one or more external node scopes under explicit bounds.

External scope snapshots must preserve:

- node/domain identity;
- remote scope selectors and exact remote authority snapshot identity;
- local vs external authority classification;
- transport/protocol identity;
- freshness/verification state;
- deterministic per-node and aggregate byte/candidate/time budgets.

The first slice is strictly read-only. Resolving or querying an external Scope must never move local or remote accepted-state pointers.

### V7.8.3 â€” Signed external Stone envelopes

Define a signed transport envelope, working name `cairnstone-external-stone-envelope-v1`, that carries an immutable Stone identity plus the minimum issuer/provenance needed to verify where it came from and what authority claim the sender is making.

The envelope should bind at minimum:

- immutable Stone/content hash;
- issuer node/domain identity;
- source chain/path/commit provenance when available;
- claimed authority class and remote snapshot/head identity;
- signature algorithm/key identity;
- canonical serialization/version;
- issuance/expiry or freshness metadata where applicable;
- replay/idempotency identity.

Verification success means "this node signed this exact envelope"; it does **not** mean the recipient locally accepts the content as canonical truth. Imported, cached, trusted, and locally accepted states must remain distinguishable.

### V7.8.4 â€” Cross-vault grounded search/Q&A

Generalize V7.7 scoped retrieval/Q&A across explicitly selected external nodes. Retrieval remains progressive and bounded: discover -> resolve manifests/scopes -> search compact metadata -> expand only winners -> synthesize -> validate citations -> recheck participating authority snapshots.

Requirements include:

- per-node fairness so one large external vault cannot starve smaller selected nodes;
- explicit coverage diagnostics when bounds prevent exhaustive search;
- citation validation against evidence actually supplied to the model;
- preserved node/domain/chain/stone/path/commit/signature provenance;
- historical/external evidence visibly separated from local accepted authority;
- fail-closed or bounded deterministic restart if participating remote authority changes mid-request;
- no unbounded cross-vault prompt dump.

### V7.8.5 â€” Federated AC1 routing

Extend AC1 so an actor can route immutable correspondence to an actor/mailbox on another CairnStone node after DNS/manifest discovery. DNS discovers the mailbox/node endpoint; the actual AC1 message travels over MCP/HTTPS, not DNS.

Federated AC1 should preserve:

- globally unambiguous sender/recipient node + actor identity;
- immutable message identity and sender signature;
- thread/intent/priority semantics;
- delivery/read/ack receipts without mutating the immutable message body;
- replay/idempotency protection across nodes;
- explicit trust/policy checks before accepting inbound correspondence;
- bounded attachment/Stone references rather than arbitrary unbounded payload transfer;
- no execution authority conveyed merely by receiving a message.

### V7.8.6 â€” Public / semi-public / private capabilities

Define one capability model usable through both MCP and HTTPS APIs:

- **public** â€” intentionally authless, rate-limited, read-only discovery/search/documentation/product-style capabilities;
- **semi-public / capability-scoped** â€” signed capability/token or explicitly shared Scope grants narrowly bounded access;
- **private/authenticated** â€” organization/user-authenticated data and tools;
- **mutation/execution** â€” always subject to the owning node's explicit policy and existing CairnStone authorization boundaries; public discovery or payment must never imply mutation authority.

Capability metadata must be machine-discoverable without exposing credentials or private schemas, and a node must be able to publish a useful authless hook while keeping consequential operations gated.

### V7.8.7 â€” Federation acceptance + security gate

V7.8 is not complete until live acceptance proves federation across at least two independently addressed nodes/domains plus negative/adversarial cases.

Acceptance must cover at minimum:

- correct DNS / `.well-known` discovery and deterministic node identity;
- manifest tamper detection and signing-key verification/rotation behavior;
- forged/spoofed domain or node rejection;
- signed Stone envelope verification, replay handling, and local-vs-external authority separation;
- stale manifest/snapshot handling and mid-request remote authority races;
- bounded cross-vault search/Q&A with valid cross-node citations;
- federated AC1 delivery + replay/idempotency + receipt semantics;
- public/semi-public/private capability enforcement;
- zero unauthorized mutation from discovery, public APIs, external Scope reads, paid access, or inbound correspondence;
- SSRF/redirect abuse, confused-deputy, credential exfiltration, data-poisoning, rate-limit/DoS, oversized payload, and trust-downgrade tests;
- deterministic behavior through both full MCP and portable Tool Vault paths where applicable;
- clear operator-visible trust/provenance state for every external node/evidence item.

Initial implementation order:

```text
V7.8.0 public node manifest
  -> V7.8.1 DNS + .well-known discovery
  -> V7.8.2 external read-only Scope
  -> V7.8.3 signed external Stone envelopes
  -> V7.8.4 cross-vault grounded search/Q&A
  -> V7.8.5 federated AC1 routing
  -> V7.8.6 public/semi-public/private capabilities
  -> V7.8.7 federation acceptance/security
```

---

## V7.9 â€” Skills vNext / Capability Recipes

Status: **PLANNED / ROADMAP-ACCEPTED â€” implementation not started.** V7.9 evolves the existing V6.9/V6.10 accepted-skills system from primarily instruction-oriented progressive loading into a provider-neutral capability-recipe layer that remains portable across ChatGPT, Claude, Grok, Bolt, Cursor, and future MCP hosts.

### Goal

A CairnStone skill should be able to describe not only **how an agent should behave**, but also **which abstract capabilities it needs, how those capabilities may be used, and how success must be verified**. The LLM remains a replaceable reasoning engine; skill identity, provenance, capability requirements, policy, and acceptance remain CairnStone-controlled state.

The intended progression is:

```text
behavioral guidance
  -> operational skill
  -> capability recipe / capability pack
```

Pure behavioral guidance remains valid when useful, but it must not masquerade as executable capability.

### V7.9.0 â€” Skill taxonomy + schema evolution

Introduce explicit skill classes such as:

- **behavioral guardrail** â€” compact cross-model guidance/policy with no implied tool capability;
- **operational skill** â€” a repeatable procedure with capability requirements and success criteria;
- **capability pack** â€” operational skill plus policy/authorization expectations, verification contract, receipts/evidence expectations, and optional host/tool adapters.

Extend manifest/schema metadata while preserving backward compatibility with the current accepted catalog. Candidate fields include `kind`, `requires_capabilities`, `success_criteria`, `verification`, `risk_policy`, and structured `provenance`. Existing `requires_tools` remains a compatibility surface during migration rather than being removed abruptly.

### V7.9.1 â€” Capability contracts instead of hard-coded host tool names

Skills should prefer abstract capability identities such as:

```text
repo.read
repo.diff
repo.patch
sandbox.test
cairnstone.accept
```

CairnStone then resolves those capability requirements against the Tool Vault / broker and the tools actually available in the current host/runtime. The target architecture is:

```text
Skill
  -> capability requirements
  -> CairnStone capability resolver / Tool Vault
  -> host-specific tool contract
  -> existing V7.3 policy + authorization boundary
```

A skill never grants authority merely by requiring a capability. Missing capabilities must fail closed or explicitly degrade to guidance-only behavior when the skill contract permits it. Tool resolution must preserve the existing rule that model intent is not execution authority.

### V7.9.2 â€” Verification-bearing execution recipes

Operational skills should define verifiable execution structure rather than prompt advice alone. A coding recipe may require:

```text
establish immutable/base state
  -> state assumptions / ambiguity
  -> identify smallest change surface
  -> perform bounded mutation under policy
  -> inspect resulting diff
  -> run relevant tests/checks
  -> verify requested outcome
  -> emit evidence / receipts
```

Acceptance should distinguish "the model followed the advice" from "the requested result was actually proven." Existing execution receipts, Code Session checkpoints, Git commit evidence, path/chain HEAD authority, and live verification primitives should be reused rather than duplicated.

### V7.9.3 â€” External-skill adaptation pipeline

External/open-source skills may enter CairnStone first as immutable reference Stones. They do **not** become accepted CairnStone skills automatically.

Promotion path:

```text
external immutable source Stone
  -> provenance + license review
  -> CairnStone-native candidate adaptation
  -> capability/policy mapping
  -> lint + tests + cross-model evaluation
  -> immutable Git source
  -> individual skill path HEAD acceptance
  -> manifest HEAD accepted last
```

Upstream identity and CairnStone-derived identity remain separate. External source updates create freshness/drift evidence, not silent skill updates. Attribution/license obligations travel with derived skills where required.

**First pilot:** adapt the MIT-declared upstream `karpathy-guidelines` skill from `multica-ai/andrej-karpathy-skills` (external reference Stone `b2a95cf4a1ca...`, immutable source commit `64723a49ea6117894304eb491f0d32a60570bf45`) into a CairnStone-native experimental recipe, working name `engineering.surgical-change`. The pilot should transform guidance such as simplicity, surgical edits, explicit assumptions, and goal-driven verification into a capability-aware recipe rather than simply copying the prompt text.

### V7.9.4 â€” Cross-model / cross-host portability

Prove that one accepted capability recipe can be loaded by multiple reasoning hosts while resolving to different concrete tool surfaces. ChatGPT, Claude, and Grok are the minimum first acceptance matrix; Bolt/Cursor or another independent MCP host should be added where practical.

The same accepted skill identity should preserve behavioral contract, required capability semantics, risk/authorization expectations, and verification criteria even when exact connector/tool names differ.

### V7.9 acceptance

V7.9 is complete only when live acceptance proves at minimum:

- existing behavioral skills remain backward compatible and progressively loaded;
- operational skills can declare abstract capabilities without hard-coding one provider/client's tool names;
- capability resolution maps to real Tool Vault/broker contracts and never bypasses V7.3 policy/authorization;
- missing or ambiguous capability mappings fail closed;
- one capability recipe runs across ChatGPT, Claude, and Grok with equivalent semantic behavior despite different native harness/tool surfaces;
- verification criteria produce grounded evidence/receipts rather than self-reported success;
- external-reference skills remain non-authoritative until explicitly adapted, linted, tested, Git-versioned, and accepted through the existing manifest-last process;
- provenance and applicable license/attribution survive adaptation;
- the Karpathy-guidelines pilot demonstrates measurable value beyond what the models' native harnesses already provide;
- skill loading remains bounded/progressive and does not turn the entire capability catalog into startup context.

V7.9 extends the skills/control plane; it does not replace Tool Vault, V7.3 authorization, Persistent Code Mode, model profiles, or provider-native harnesses. Its purpose is to make those layers composable through portable, accepted recipes.

---

## V7.10 â€” Economic Authority + Verifiable Work Receipts

Status: **PLANNED / ARCHITECTURE-ACCEPTED DIRECTION â€” implementation not started.** This milestone generalizes V7.5 paid-agent work over the persistent job/session fabric introduced in V7.7.10. It does **not** create a CairnStone wallet, facilitator, or global marketplace.

### Goal

Make the commercial object a durable, bounded, verifiable job rather than a raw model call or a rail-specific payment event.

The core chain is:

```text
principal / organization
  -> capability / resource grant
  -> persistent job or session
  -> profile + runtime actor
  -> exact Scope / package / accepted authority
  -> economic authority / budget
  -> execution + optional external purchases
  -> verification
  -> Work Receipt
  -> capture / settlement state
```

The model may propose economic actions. CairnStone policy/authority decides whether they are permitted. Economic authority belongs to a durable job/session/capability and is never attached directly to an LLM, provider credential, wallet, or payment rail.

### V7.10.0 â€” Rail-neutral `cairnstone-economic-authority-v1`

Define an explicit economic authority envelope that can bind to `task_run_id`, `conversation_id`, `code_session_id`, a resource/access grant, or another durable capability identity.

The envelope should include at minimum:

- principal / organization identity and grantor;
- bound durable object/job/session identity;
- allowed spend modes and adapter classes;
- total budget, per-purchase ceiling, optional counterparty/category limits, currency/asset constraints, and expiry;
- delegation/sub-purchase depth and whether child jobs may spend from the parent budget;
- human-commit thresholds and explicitly bounded automatic-spend policy;
- replay/idempotency identity and revocation/consumption state;
- policy/version identity and immutable receipt references.

Supported economic modes must remain semantically distinct: `exact`, `upto`, `session`, `allowance`, and `subscription`. Outcome-based pricing may be added only after V7.10.3 defines a sufficiently strong outcome-verification contract.

### V7.10.1 â€” Authorize/reserve -> execute -> verify -> capture/settle lifecycle

For higher-value or long-running work, support a lifecycle where authorization/reservation precedes execution and final capture/settlement can depend on verified delivery:

```text
quote / terms
  -> authorize or reserve bounded funds
  -> execute durable job
  -> verify delivery / result
  -> capture / settle
  -> finalize Work Receipt
```

Low-value exact-pay-before-execute flows remain valid when the selected adapter and policy allow them. The lifecycle is policy-driven, not hard-coded to one rail.

### V7.10.2 â€” Bounded external procurement inside a job

A CairnStone job may purchase external paid resources or specialist sub-services under its economic authority without forcing the principal to manage every microtransaction.

Requirements:

- supplier discovery/selection is bounded and provenance-bearing;
- every external purchase consumes the parent budget under explicit ceilings;
- child payment/service receipts remain linked to the parent job;
- failed or replayed child purchases cannot double-spend the parent authority;
- the final receipt exposes aggregate cost plus inspectable sub-cost/receipt references;
- supplier/payment adapters never gain accepted-state, mutation, or execution authority merely because they were paid.

### V7.10.3 â€” `cairnstone-work-receipt-v1`

Define one receipt that proves what authority was used, what work happened, what was purchased, what result was produced, and what was actually settled.

Bind at minimum:

- principal / organization and economic actor chain;
- `task_run_id` / conversation / code-session identity;
- profile + version and runtime actor;
- Scope, `package_id`, accepted-authority digest, and relevant content identities;
- access/capability/resource grants plus mutation/execution policy;
- economic authority / budget envelope, payment adapter/rail, quote/authorization/reservation identity;
- supplier discovery/selection evidence where external resources were used;
- provider/model attempts and governed tool/execution receipts;
- external purchase receipts and sub-costs;
- result digest, citations/evidence coverage, and acceptance state;
- context-race, replay/idempotency, verification, and handoff/actor-chain state;
- capture/settlement/refund/dispute state as applicable.

Receipts should expose three separate verification domains rather than collapsing them into one score:

1. **supplier verification** â€” endpoint/payment/delivery/reputation evidence for an external supplier;
2. **execution verification** â€” exact profile/context/capabilities/mutations/tool calls/handoffs used by CairnStone;
3. **outcome verification** â€” whether the requested result/deliverable satisfied the defined evidence/acceptance contract.

### V7.10.4 â€” First-class resource/context authority

Extend the existing Give Access / Access Grant model so resource authority is explicit and composable with economic authority.

A resource/context grant may represent free sharing, organization-internal access, metered access, or paid access to authoritative Stones, Scopes, knowledge packs, artifacts, or other bounded resources. Economic authorization may gate access, but payment never promotes the resource into accepted state and never implies execute/mutate permission.

Keep these authority dimensions distinct:

```text
resource authority != execution authority != mutation authority != economic authority
```

### V7.10.5 â€” One canonical service descriptor, many publication adapters

Define one canonical CairnStone service descriptor as the source for generated external publication surfaces rather than manually maintaining separate listings.

Adapters may publish/derive:

- x402 Bazaar / facilitator discovery metadata;
- Circle or other x402 discovery surfaces;
- MPP-compatible service/payment metadata;
- ERC-8004 registration / reputation / validation pointers;
- A2A AgentCard and MCP/OpenAPI capability descriptions;
- `llms.txt` / documentation discovery surfaces;
- StoneLink public node/service metadata where appropriate.

These surfaces are discovery/transport projections, never a second accepted-state authority. CairnStone should **publish into** external markets/indexes rather than trying to own a global marketplace.

### V7.10.6 â€” Acceptance metrics + market-quality gate

Do not use raw payment/transaction count as the primary success metric. High machine-payment counts can include scripts, farming, retries, self-payments, or other activity that does not prove durable agent commerce.

Track at minimum:

- distinct paying principals / organizations;
- completed **and verified** jobs;
- repeat buyers / repeat principals;
- revenue and cost per verified job;
- autonomous external sub-purchases per job and their success rate;
- receipt verification/coverage quality;
- replay/double-charge prevention;
- refund/dispute/failure rate where applicable.

V7.10 acceptance should prove at least two payment adapters or payment modes against the same durable job/economic-authority identity, one bounded external sub-purchase, one paid resource/context grant, one verification-gated capture flow, and one complete Work Receipt whose identity/provenance survives a provider/model swap.

---

## Phase ordering

```text
V6.10 FROZEN CONTROL PLANE
        â†“
V7.0 Context Compiler Contract
        â†“
V7.0 implementation + live acceptance
        â†“
V7.1 Provider-Neutral Router (COMPLETE -- V7.1.0 through V7.1.5, R1-R12 closed)
        â†“
V7.2 Console + Inbox Dispatch + read-only server-side delegation (COMPLETE â€” runtime 0.5.8, native AC1 handoff, GitHub mirror, and final Console Operator UX live-accepted)
        â†“
V7.3 Permissioned Agent Loop + MCP Tool Broker (COMPLETE â€” V7.3.0 through V7.3.3 live-accepted)
        â†“
V7.4 Cross-project agent profiles (COMPLETE â€” V7.4.0 + generalized profile system + V7.4.1 true cross-project acceptance)
        â†“
V7.5 paid sub-agent runtime (IN PROGRESS â€” x402 is the first payment adapter; durable service/job identity is rail-neutral; settlement gated)
        â†“
V7.6 Context Efficiency & MCP Surface Optimization (COMPLETE + LIVE-ACCEPTED â€” profiler + Tool Vault + sparse authority + compact reads + canonical instruction runtime brief + optimized_sparse default flip closed; legacy_full rollback proven)
        â†“
V7.7 Vault / Workspace Navigation + Multi-Chain Intelligence (ACTIVE EVOLUTION â€” V7.7.7f complete/live; V7.7.8 Progressive Grounded Chat LOD next; V7.7.9 Console UX Architecture after)
        â†“
V7.7.10g/10h Context Retention + Semantic Capability Gateway (IN PROGRESS â€” deterministic decision contract -> first-party Workers AI scorer -> optional Jev/BYOK adapters -> Persistent Code Mode / Tool Vault integration)
        â†“
V7.7.10i CairnStone Account Identity + Connector-Bound Authorization (P0 / REVIEW-CORRECTED â€” Console/account root -> wallet-backed first authenticator -> OAuth `/mcp/core-auth` connection -> immutable per-connection principal -> authenticated storage realm -> second-Perplexity isolation proof -> AC1/workspace/PCM bootstrap; gate before new Console expansion)
        â†“
V7.7.10j Role-Scoped Tool Belts (PLANNED â€” accepted, versioned capability projections; cannot widen broker/account/object authority)
        â†“
V7.7.10k Portable Response Profiles (PLANNED â€” team/project/user presentation policy, profile resolver, host-native renderer/fallback)
        â†“
V7.7.10l Standalone CairnStone Messages Mini MCP (PLANNED â€” independent human-messaging resource server + tiny connector + Messages PWA; Core becomes a client after standalone acceptance)
        â†“
V7.7.11 Mobile Home / Guided Mode / Safe Adaptive UI + In-Chat Console + Cross-Host Communications (PLANNED â€” iPhone PWA, bounded surface composer, host-supported MCP Apps, AC1-backed private human messaging; optional email/video gated separately; same backend/authority)
        â†“
V7.8 CairnStone Federation / StoneLink (PLANNED / AFTER V7.7 ACCEPTANCE â€” public node manifest â†’ DNS/.well-known discovery â†’ external read-only Scope â†’ signed external Stone envelopes â†’ cross-vault grounded search/Q&A â†’ federated AC1 â†’ capability tiers â†’ federation security gate)
        â†“
V7.9 Skills vNext / Capability Recipes (PLANNED â€” behavioral guardrails â†’ operational skills â†’ abstract capability contracts â†’ verification-bearing recipes â†’ external-skill adaptation â†’ cross-model/host acceptance)
        â†“
V7.10 Economic Authority + Verifiable Work Receipts (PLANNED â€” rail-neutral economic authority â†’ durable budget/job binding â†’ bounded external procurement â†’ Work Receipt â†’ paid resource/context authority â†’ publication adapters â†’ commercial acceptance metrics)
```

Do not skip V7.0.

Without a stable context contract, each provider adapter and UI would independently reconstruct "the agent," recreating the fragmentation V6 was built to eliminate.
