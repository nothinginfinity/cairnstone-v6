# CairnStone V6

CairnStone is a persistent, provider-neutral control plane for AI agents: accepted project memory, immutable source provenance, progressive context loading, cross-agent correspondence, grounded retrieval, version-controlled skills, and deterministic handoff state on Cloudflare Workers.

**V6.10 is the frozen V6 control-plane baseline.** This repository now also carries the accepted V7 architecture and is the implementation home for the next phase: a provider-neutral agent runtime built on top of the V6 control plane.

## Current state

As of the V6.10 freeze / V7 kickoff:

- Live Worker: `cairnstone-v6.jaredtechfit.workers.dev`
- MCP endpoint: `https://cairnstone-v6.jaredtechfit.workers.dev/mcp`
- Runtime: `0.4.8`
- Canonical project-memory chain: `cairnstone-v6-project-memory`
- Canonical skills chain: `cairnstone-v6-skills`
- Accepted skills catalog: 15 QA-gated skills
- V6.10 Skills Sub-Agent: implemented and live accepted
- V7.0 Context Compiler contract: drafted and accepted
- Next engineering slice: implement and live-accept `cairnstone_agent_bootstrap`

V5 is frozen legacy reference. New project-memory work belongs in V6.

## What CairnStone does

```text
Git / notes / tool output / agent messages
                  │
                  ▼
             CairnStone V6
                  │
      ┌───────────┼───────────┐
      ▼           ▼           ▼
   D1 graph    R2 raw data   Git provenance
      │           │           │
      └───────────┼───────────┘
                  ▼
      accepted chain + path state
                  │
       ┌──────────┼───────────┐
       ▼          ▼           ▼
    memory    skills       correspondence
       │          │           │
       └──────────┼───────────┘
                  ▼
        provider-neutral agents
```

The core design rule is that **accepted CairnStone state is authority**. Mutable Git branches, model output, caches, and timestamps do not silently become canonical state.

## Major capabilities

### Persistent stones + progressive expansion

- Deterministic compressed Stones with LOD1–LOD5 layers.
- Raw originals in R2; searchable/indexed metadata and graph state in D1.
- Search-before-expand so clients load only the context they need.
- Server-side GitHub fetches avoid pasting large files through the client.

### Canonical graph state

- One semantic **chain HEAD** per chain.
- Independent **path HEADs** per `(chain, path)`.
- Typed edges: `supersedes`, `patches`, `documents`, `reviews`, `references`.
- `cairnstone_resume_chain` deterministically returns current HEAD, path HEADs, provenance, and graph relations without inferring state from timestamps.

### Immutable Git provenance + freshness

- Git-backed acceptance fails closed unless source resolves to an immutable 40-hex commit SHA.
- Accepted state and observed source freshness are separate concepts.
- Per-path freshness checks compare content identity, so unrelated commits do not create false drift.
- Repository reconciliation is read-only and never auto-advances canonical HEADs.

### AI correspondence (AC1)

- Immutable message Stones with mutable per-recipient delivery state.
- Inbox/read flows for cross-session and cross-model coordination.
- Idempotent message IDs.
- Correspondence transports intent; it does not grant execution authority.

### Grounded Q&A (ASK1)

- Retrieval-grounded answers over one CairnStone chain.
- Evidence classified as `CHAIN_HEAD`, `PATH_HEAD`, or `HISTORICAL`.
- Graph relations and citation validation are returned with the answer.
- Optional freshness verification and derived-answer persistence.

### Version-controlled skills (V6.9–V6.10)

- Skills live in Git under `skills/`.
- CairnStone path HEADs select accepted skill versions.
- `cairnstone_resolve_skills` provides deterministic progressive routing.
- `cairnstone_get_skill_bundle` distributes provenance-bearing accepted skill bundles to downstream MCPs.
- `cairnstone_lint_skills` QA-gates the catalog.
- `cairnstone_skill_agent` uses Workers AI only as an advisory ambiguity layer above deterministic accepted candidates.
- The model cannot invent accepted skills, choose skill versions, execute tools, or grant mutation authority.

## V7 direction

V6 established the control plane. V7 makes the reasoning engine replaceable.

```text
V6.10 frozen control plane
        │
        ▼
V7.0 deterministic Context Compiler
        │
        ▼
immutable agent context package
        │
        ▼
V7.1 provider-neutral model router
        │
        ├── Workers AI
        ├── OpenAI / BYOK
        ├── Anthropic / BYOK
        ├── xAI / BYOK
        ├── Gemini / BYOK
        └── additional providers
        │
        ▼
V7.2 CairnStone Console + Inbox Dispatch
```

The V7 goal is simple:

> CairnStone defines durable agent state, skills, authority, coordination, and evidence; the LLM becomes a replaceable reasoning engine.

See [`docs/ROADMAP_V7.md`](docs/ROADMAP_V7.md) and [`docs/V7_0_CONTEXT_COMPILER_CONTRACT.md`](docs/V7_0_CONTEXT_COMPILER_CONTRACT.md).

## Start here for AI agents

Before repo work, debugging, or CairnStone calls, read the canonical operating guide in full:

[`docs/AI_OPERATING_GUIDE.md`](docs/AI_OPERATING_GUIDE.md)

Then orient deterministically:

```text
1. cairnstone_health()
2. cairnstone_resume_chain(chain="cairnstone-v6-project-memory")
3. cairnstone_get_inbox(recipient_id=<your actor id>)
4. resolve/load only the accepted skills needed for the task
```

Do not infer current state from `created_at`. Use chain HEAD and path HEADs.

## Authority model

```text
Git editable source
        │
        ▼
CairnStone accepted path HEAD
        │
        ▼
immutable Git commit
        │
        ▼
accepted memory / skill / document
        │
        ▼
clients, models, MCP consumers, caches
```

Downstream caches may improve availability and performance, but they are never authority.

## Cloudflare runtime

The Worker uses:

- `CAIRNSTONE_DB` — D1 graph/catalog/state database.
- `CAIRNSTONE_RAW` — R2 raw-content bucket.
- `AI` — Workers AI binding for ASK1 and the V6.10 advisory Skills Sub-Agent.

Observability is enabled in `wrangler.toml`.

## Local development

Requires Node.js 22+ for parity with CI.

```bash
npm install
npm run check
npm run dev
```

Useful scripts:

```bash
npm test
npm run lint:skills
npm run db:migrate:local
npm run db:migrate:remote
```

## Production deployment

Production deployment is defined in:

[`.github/workflows/deploy-cloudflare.yml`](.github/workflows/deploy-cloudflare.yml)

The workflow is manually dispatched and runs `npm run check` before deploying. It can optionally apply migrations and run bounded live acceptance gates, including the V6.10 Skills Sub-Agent acceptance.

Direct Wrangler deployment is also available through:

```bash
npm run deploy
```

Use the workflow for canonical production acceptance so the deploy and acceptance evidence stay together.

## Key documentation

- [`docs/AI_OPERATING_GUIDE.md`](docs/AI_OPERATING_GUIDE.md) — canonical operating rules for AI sessions.
- [`docs/ROADMAP_V6.md`](docs/ROADMAP_V6.md) — V6 milestones through the frozen V6.10 control plane.
- [`docs/V6_9_VERSIONED_SKILLS.md`](docs/V6_9_VERSIONED_SKILLS.md) — version-controlled skill architecture.
- [`docs/V6_10_SKILLS_SUB_AGENT.md`](docs/V6_10_SKILLS_SUB_AGENT.md) — advisory Skills Sub-Agent architecture and acceptance.
- [`docs/ROADMAP_V7.md`](docs/ROADMAP_V7.md) — provider-neutral agent-runtime roadmap.
- [`docs/V7_0_CONTEXT_COMPILER_CONTRACT.md`](docs/V7_0_CONTEXT_COMPILER_CONTRACT.md) — deterministic V7.0 bootstrap/context-package contract.

## Status

CairnStone is no longer a scaffold. V6.10 is a production-live-accepted control plane with deterministic state, graph memory, provenance/freshness, correspondence, grounded Q&A, accepted skills, downstream skill distribution, catalog QA, and bounded advisory skill routing.

The current continuation point is **V7.0 implementation + live acceptance**. V7 should add runtime capabilities without weakening the accepted-state authority established in V6.
