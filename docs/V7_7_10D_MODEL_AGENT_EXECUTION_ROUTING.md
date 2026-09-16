# V7.7.10d — Model + Agent Execution Routing

**Status:** in-repo implementation slice (worker). Operational orchestration only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. `accepted_state_authority: false` on every response.

**START HERE gate (10c COMPLETE):** `b60b14a06a737719a4147cd8cb913c304772b1b5bc217b549f6fefbe506cb65b`  
**Amendment (Give Access):** `eab0bdb8304f0d5439b659bdbedf2715fe4894a1d9958814f4db13a8de89b22f`  
**Fabric plan (10d authority):** `4ccf169f4fd6e94109c1ac66e3492069beade5206c73f2ce1b3ad6d061eabfaf`  
**START HERE gate (10d COMPLETE):** `7a9fb4b06a4ba9879e3f431cc906a2994f65028a6cac7b278072c103bd5c4d4d`  
**10d.1 trigger AC1:** `msg:v7710d-native-executor-context-followup-20260915-chatgpt` · stone `811dd6519ae7e24dab49a332def0e055dce34408c8cedbbba7d84b2f59f6ed17`  
**Runtime:** worker **0.5.43** live; **10d.2** host-satisfied `stone.read` for compiled_context (amendment on tip `9270d703a52206698a8674ce8962077ec0f555e1`; version bump on deploy)

## What this plane is

Makes Assign/Ask-to-work Task Run **proposals from 10b dispatchable** under an **executor registry + capability-aware router**, distinct from the conversational **model router** (`cairnstone_model_route`).

Dispatch requires an **explicit human commit**. Matching intent, proposing a Task Run, or selecting a chat model **never** launches work.

### V7.7.10d.1 — Native vs compiled context

**Never duplicate/compile large context into an executor prompt when that executor is CairnStone-aware and can resolve the canonical refs itself.**

| Mode | When | Dispatch payload |
|------|------|------------------|
| `cairnstone_native` | Executor has authorized CairnStone connection | **Minimum task envelope** + typed refs / Scope / Task Run id / immutable repo SHA / bounded access grants. **No large compiled prompt dump.** Route records `context_resolution=reference_only_native`. |
| `compiled_context` | Executor cannot access CairnStone | **Bounded provenance-preserving compiled pack** (budgets, omissions, receipt digest). Route records `context_resolution=compiled_transmitted`. |

Profile fields (`cairnstone-executor-profile-v1`): `context_mode`, `requires_compiled_context`, `supported_ref_types[]`, optional `context_resolution_endpoint`.

Seed defaults: `exec:deterministic-mcp`, `exec:cairnstone-delegate`, `exec:cursor-cloud` → **native**; `exec:github-copilot`, `exec:afo-specialist` → **compiled**.

Route preference: all else equal, prefer CairnStone-native. Does **not** override capability fit, risk class, budget, or human `preferred_executor`.

## Hard invariants

1. `accepted_state_authority: false` always on Task Runs, executor profiles, routes, receipts.
2. Never move `chain_heads` / `path_heads`.
3. `grants_no_capability: true` — routing/dispatch does not mint Scope/workspace/Code Session capability.
4. Assign still does **not** grant access; Give Access does **not** dispatch work.
5. Model router remains **distinct** from executor router.
6. **No auto-dispatch** from intent router, model output, or `task_run_propose`. Dispatch requires `human_commit: true` + `committed_by`.
7. Child Task Runs cannot widen parent capability/attachment/scope ceilings.
8. Task Run completion ≠ accepted state.
9. No raw API keys in Task Runs, Stones, AC1, or conversation text.
10. No Console proposal cards (10e) or DO/WS event plane (10f) in this slice.
11. Native access still bounded by Give Access / grants — not blanket vault. Refs/Scope do not grant execution/mutation authority.
12. Native dispatch **rejects** compiled body dumps; compiled packs **fail closed** past budget.

## Schemas

| Schema | Role |
|--------|------|
| `cairnstone-executor-profile-v1` | Seed executor registry profiles (+ context_mode fields) |
| `cairnstone-executor-route-receipt-v1` | Capability-aware route receipt (proposal evidence + context_resolution) |
| `cairnstone-task-run-v1` | Durable Task Run (propose → dispatch → async status) |
| `cairnstone-executor-adapter-job-v1` / `…-receipt-v1` | Adapter job/receipt stubs |
| `cairnstone-executor-dispatch-envelope-v1` | Min task envelope (native) or compiled envelope wrapper |
| `cairnstone-executor-compiled-context-pack-v1` | Bounded compiled pack + omissions + receipt digest |

## Executor registry (seed)

| executor_id | class | context_mode | notes |
|-------------|-------|--------------|-------|
| `exec:deterministic-mcp` | deterministic MCP/tool | `cairnstone_native` | bounded allowlisted read on dispatch |
| `exec:cairnstone-delegate` | delegated model/profile | `cairnstone_native` | points at existing delegate; does not auto-run |
| `exec:afo-specialist` | AFO specialist | `compiled_context` | adapter contract + stub |
| `exec:github-copilot` | coding agent | `compiled_context` | contract + dry-run stub |
| `exec:cursor-cloud` | coding agent | `cairnstone_native` | contract + dry-run stub; MCP-capable |

## Surfaces

| Surface | Auth | Behavior |
|---------|------|----------|
| MCP `cairnstone_executor_list` / `_get` / `_health` | scoped_grant **read** | Registry discovery |
| MCP `cairnstone_executor_route` | scoped_grant **read** | Pure route; **never** dispatches |
| MCP `cairnstone_task_run_propose` | scoped_grant mutation | Proposal only (`not_dispatched`) |
| MCP `cairnstone_task_run_dispatch` | **human_confirmation** mutation | Requires `human_commit:true` + `committed_by` |
| MCP `cairnstone_task_run_cancel` | scoped_grant mutation | Cancel non-terminal |
| MCP `cairnstone_task_run_status` | scoped_grant **read** | Async progress snapshot |
| REST `/v1/executors/*`, `/v1/task-runs/dispatch\|cancel\|status` | same | Mirrors |

### Preferred selection order (fabric plan)

1. deterministic when fully deterministic  
2. narrow specialist  
3. inexpensive model-backed specialist  
4. coding agent when repo/PR work required  
5. premium general model only when needed  
6. paid/external only when policy+budget allow  

Within equal capability/cost/rank: prefer `cairnstone_native` over `compiled_context`.

Policy presets: `economy | balanced | best | manual`.

### Task Run statuses

`proposed | queued | running | completed | failed | cancelled`  
`dispatch_state`: `not_dispatched | dispatched | running | completed | failed | cancelled`

### Bounded subdelegation

Defaults: **depth ≤ 2**, **fan-out ≤ 3**.  
Child `attachment_refs` / `object_refs` / `required_capabilities` must be ⊆ parent. Fail closed on ceiling violations. Parent must already be dispatched/running.

### Adapters

- **deterministic-mcp:** may execute one allowlisted read (`cairnstone_executor_list|get|health`, `cairnstone_health`) and attach receipt; **reference_only_native** envelope.
- **coding / AFO / cursor / copilot / delegate:** record async stub job with `adapter_live=false` / `dry_run=true`; native executors omit compiled pack; compiled executors attach bounded pack receipt.

## Migration

`0023_v7710d_task_run_dispatch.sql` — rebuilds `task_runs` for expanded enums + dispatch columns; adds `executor_route_receipts`.

**10d.1:** no new migration — `context_mode` / `context_resolution` live on existing JSON route_receipt / adapter receipt fields.

**10d.2:** no new migration — host-satisfied compiled capabilities are in-process cover-check only.

## Broker

Registry **87 → 94** (+7 in 10d). **10d.1/10d.2 add no new MCP tools** (extends existing route/dispatch).

## Out of scope

- Console Dispatch/Approve cards (10e) — **held**
- Live Durable Objects / WebSocket agent tree (10f)
- Real wallet/x402 settlement
- Live Copilot/Cursor launch requiring secrets
- Intent-router auto-dispatch

## Files

- `src/executor-profile.js`, `src/executor-adapters.js`, `src/task-run.js`
- `src/index.js` (VERSION `0.5.43`), `src/model-router.js`
- `migrations/0023_v7710d_task_run_dispatch.sql`
- `test/v7710d-executor-routing.test.js`
- `project-memory/v7710d-execution-routing-implementation-note.md`
- `project-memory/v7710d1-native-context-implementation-note.md`

## V7.7.10d.2 — compiled host-satisfied `stone.read`

Preferred `github-copilot` must remain `compiled_context` and must **not** advertise `stone.read` (that would imply CairnStone-native MCP access). Attachment/`msg`/`stone` refs still infer `stone.read`; for compiled profiles the host satisfies that capability by materializing a bounded receipted pack. Fail closed on other missing executor-held capabilities. No live Copilot adapter invented.
