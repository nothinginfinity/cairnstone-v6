# CairnStone V7 Roadmap

Status: **architecture roadmap draft**
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

V7.1 cannot begin implementation until the V7.0 contract and live acceptance tests are accepted.

---

## V7.1 — Provider-Neutral Model Router

### Goal

Make the model interchangeable without changing agent state.

### Architecture

```text
V7.0 immutable context package
          ↓
provider-neutral request IR
          ↓
AI Gateway
   ┌──────┼─────────┐
   ↓      ↓         ↓
Workers  BYOK      future
AI       APIs       providers
```

### Initial provider classes

1. **Workers AI hosted models**
   - model IDs must be resolved against the live Cloudflare catalog at implementation time;
   - user-targeted families include high-capability DeepSeek/Kimi-class models where available.

2. **BYOK through AI Gateway**
   - Anthropic
   - OpenAI
   - xAI
   - Gemini
   - additional adapters may be added without altering V7.0.

### Router responsibilities

- provider/model selection;
- model capability registry;
- provider-specific message/tool schema translation;
- AI Gateway routing/observability;
- BYOK secret isolation;
- rate/cost/error normalization;
- model output normalization;
- optional advisory Skills Sub-Agent call only after deterministic bootstrap flags ambiguity.

### Router non-responsibilities

The router cannot:

- choose canonical instructions;
- choose accepted memory/path HEADs;
- select unaccepted skills;
- change `package_id`;
- grant execution/mutation authority merely because a model supports tools.

### BYOK invariant

Provider keys are secrets owned by the provider/runtime layer. They never enter:

- CairnStone stones;
- the V7.0 immutable context package;
- AC1 correspondence;
- user-visible evidence payloads.

### Acceptance

- identical V7.0 package can be sent to at least two provider classes;
- provider switch leaves `package_id` unchanged;
- normalized model result identifies provider/model separately;
- tool-capability differences are explicit;
- one provider outage can fail over only under explicit policy, not silently alter authority;
- AI Gateway telemetry proves which provider/model was actually used.

---

## V7.2 — CairnStone Console + Inbox Dispatch

### Goal

Create a human/agent operating surface over the same V7 runtime contracts.

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

### V7.3 — Permissioned Agent Loop

Turn normalized model tool intents into a governed execution loop.

Key rule:

> model intent is not execution authority.

Potential policy tiers:

- read-only automatic;
- low-risk mutation with scoped capability;
- explicit human confirmation;
- prohibited/high-risk.

Execution receipts should link back to the V7.0 package ID and model/provider envelope.

### V7.4 — Cross-project agent profiles

Reusable provider-neutral agent profiles:

- default chain(s);
- skill preferences;
- tool allowlists;
- context budgets;
- correspondence identities;
- execution policy.

Profiles are configuration, not accepted project-memory authority.

### V7.5 — x402 / paid sub-agent runtime

Expose narrow CairnStone-defined agents as metered services where appropriate.

The paid unit should be a bounded capability backed by:

- immutable context identity;
- accepted skills;
- explicit tool policy;
- execution receipts;
- x402 settlement.

---

## Phase ordering

```text
V6.10 FROZEN CONTROL PLANE
        ↓
V7.0 Context Compiler Contract
        ↓
V7.0 implementation + live acceptance
        ↓
V7.1 Provider-Neutral Router
        ↓
V7.2 Console + Inbox Dispatch
        ↓
V7.3 Permissioned Agent Loop
        ↓
V7.4 profiles / V7.5 x402 agents
```

Do not skip V7.0.

Without a stable context contract, each provider adapter and UI would independently reconstruct "the agent," recreating the fragmentation V6 was built to eliminate.
