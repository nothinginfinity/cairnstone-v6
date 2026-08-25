# CairnStone V7 Roadmap

Status: **V7.1 complete; V7.2 NEARLY COMPLETE — runtime 0.5.8 delegation, native AC1 dispatch, its optional GitHub Inbox mirror, and the Console client are all live-accepted; only final V7.2 closure bookkeeping remains**
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

**V7.2 nearly complete:** V7.1 is complete and V7.2 engineering is nearly done. Runtime `0.5.8` has three live-accepted primitives: bounded read-only `cairnstone_delegate`, structured immutable AC1 `cairnstone_dispatch_handoff`, and its optional GitHub Inbox mirror transport. The Console client is live-accepted end-to-end, including the mirror UI. Only final V7.2 closure bookkeeping remains before V7.3.

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

Status: **NEARLY COMPLETE.** Runtime `0.5.8` exposes three live-accepted V7.2 primitives: `cairnstone_delegate`, `cairnstone_dispatch_handoff`, and its optional GitHub Inbox mirror transport (deterministic per-recipient/message artifacts, isolated failure handling, idempotent replay). Live acceptance run `32870621139` at commit `a567a553a66fee61ad85f20f2e7c7b2970c0aed9` additionally proved real Workers AI -> DeepSeek provider switching under the same V7.0 package/request identities, intentional provider-credential failure isolation, successful mirroring, mirror replay, and deliberate mirror-target failure isolation, all with canonical chain/path-head state unchanged. The `nothinginfinity/cairnstone-v6-console` client is live-accepted at immutable commit `0a1f1d958c175caa1f770dfb8b12ea3e84c1eb53` and published at `https://nothinginfinity.github.io/cairnstone-v6-console/`, with delegated chat/model selection, evidence inspection, native AC1 inbox/read, structured handoff composition, and the GitHub Inbox mirror fields wired into handoff compose. Mobile acceptance `vb_9651fdd7` returned HTTP 200 at 393×852 with no horizontal overflow and zero console/page/network failures. Only the final V7.2 closure matrix (this document, project-memory START HERE, and a closing AC1 handoff) remains before V7.3.

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

Expose selected V7.4 profiles as bounded, metered agent services callable by other agents or applications.

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
V7.2 Console + Inbox Dispatch + read-only server-side delegation (NEARLY COMPLETE — delegation, native AC1 handoff, GitHub mirror, and Console all live; final closure bookkeeping only)
        ↓
V7.3 Permissioned Agent Loop + MCP Tool Broker
        ↓
V7.4 Cross-project agent profiles
        ↓
V7.5 x402 paid sub-agent runtime
```

Do not skip V7.0.

Without a stable context contract, each provider adapter and UI would independently reconstruct "the agent," recreating the fragmentation V6 was built to eliminate.
