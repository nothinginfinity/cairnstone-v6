# V7.7.10d — Model + Agent Execution Routing

**Status:** in-repo implementation slice (worker). Operational orchestration only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. `accepted_state_authority: false` on every response.

**START HERE gate (10c COMPLETE):** `b60b14a06a737719a4147cd8cb913c304772b1b5bc217b549f6fefbe506cb65b`  
**Amendment (Give Access):** `eab0bdb8304f0d5439b659bdbedf2715fe4894a1d9958814f4db13a8de89b22f`  
**Fabric plan (10d authority):** `4ccf169f4fd6e94109c1ac66e3492069beade5206c73f2ce1b3ad6d061eabfaf`  
**Runtime:** worker **0.5.42** (baseline tip: `35dac65f336a8f3afd8b62bf5d225c53f01b4e41` / **0.5.41**)

## What this plane is

Makes Assign/Ask-to-work Task Run **proposals from 10b dispatchable** under an **executor registry + capability-aware router**, distinct from the conversational **model router** (`cairnstone_model_route`).

Dispatch requires an **explicit human commit**. Matching intent, proposing a Task Run, or selecting a chat model **never** launches work.

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

## Schemas

| Schema | Role |
|--------|------|
| `cairnstone-executor-profile-v1` | Seed executor registry profiles |
| `cairnstone-executor-route-receipt-v1` | Capability-aware route receipt (proposal evidence) |
| `cairnstone-task-run-v1` | Durable Task Run (propose → dispatch → async status) |
| `cairnstone-executor-adapter-job-v1` / `…-receipt-v1` | Adapter job/receipt stubs |

## Executor registry (seed)

| executor_id | class | notes |
|-------------|-------|-------|
| `exec:deterministic-mcp` | deterministic MCP/tool | bounded allowlisted read on dispatch |
| `exec:cairnstone-delegate` | delegated model/profile | points at existing delegate; does not auto-run |
| `exec:afo-specialist` | AFO specialist | adapter contract + stub |
| `exec:github-copilot` | coding agent | contract + dry-run stub |
| `exec:cursor-cloud` | coding agent | contract + dry-run stub |

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

Policy presets: `economy | balanced | best | manual`.

### Task Run statuses

`proposed | queued | running | completed | failed | cancelled`  
`dispatch_state`: `not_dispatched | dispatched | running | completed | failed | cancelled`

### Bounded subdelegation

Defaults: **depth ≤ 2**, **fan-out ≤ 3**.  
Child `attachment_refs` / `object_refs` / `required_capabilities` must be ⊆ parent. Fail closed on ceiling violations. Parent must already be dispatched/running.

### Adapters

- **deterministic-mcp:** may execute one allowlisted read (`cairnstone_executor_list|get|health`, `cairnstone_health`) and attach receipt.
- **coding / AFO / cursor / copilot / delegate:** record async stub job with `adapter_live=false` / `dry_run=true`.

## Migration

`0023_v7710d_task_run_dispatch.sql` — rebuilds `task_runs` for expanded enums + dispatch columns; adds `executor_route_receipts`.

## Broker

Registry **87 → 94** (+7). Route/list/get/health/status = **read**; propose/cancel = **mutation** scoped_grant; dispatch = **mutation** / **human_confirmation**.

## Out of scope

- Console Dispatch/Approve cards (10e)
- Live Durable Objects / WebSocket agent tree (10f)
- Real wallet/x402 settlement
- Live Copilot/Cursor launch requiring secrets
- Intent-router auto-dispatch

## Files

- `src/executor-profile.js`, `src/executor-adapters.js`, `src/task-run.js`
- `src/index.js` (VERSION `0.5.42`), `src/model-router.js`
- `migrations/0023_v7710d_task_run_dispatch.sql`
- `test/v7710d-executor-routing.test.js`
- `project-memory/v7710d-execution-routing-implementation-note.md`
