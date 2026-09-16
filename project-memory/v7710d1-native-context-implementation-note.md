# V7.7.10d.1 — CairnStone-native vs compiled executor context

status: implemented_in_repo_not_live_verified
slice: V7.7.10d.1
accepted_state_authority: false
start_here_gate_10d: 7a9fb4b06a4ba9879e3f431cc906a2994f65028a6cac7b278072c103bd5c4d4d
trigger_ac1: msg:v7710d-native-executor-context-followup-20260915-chatgpt
trigger_stone: 811dd6519ae7e24dab49a332def0e055dce34408c8cedbbba7d84b2f59f6ed17
runtime_baseline_before: 0.5.42
runtime_version: 0.5.43
baseline_tip: 939e9d8cc6fdface58331a6c06bac73d6e73ea7b
migration: none (JSON fields on existing route_receipt / adapter receipts)
broker_tool_count: unchanged (94)

## Principle

Never duplicate/compile large context into an executor prompt when that executor is CairnStone-aware and can resolve canonical refs itself.

## Encoding

- Profile `context_mode`: `cairnstone_native` | `compiled_context`
- Profile `requires_compiled_context`: boolean
- Profile `supported_ref_types[]`, optional `context_resolution_endpoint`
- Route receipt `context_resolution`: `reference_only_native` | `compiled_transmitted`
- Also on receipt: `context_resolution_reason`, `compiled_pack_required`

## Seed defaults

| executor_id | context_mode |
|-------------|--------------|
| exec:deterministic-mcp | cairnstone_native |
| exec:cairnstone-delegate | cairnstone_native |
| exec:cursor-cloud | cairnstone_native |
| exec:github-copilot | compiled_context |
| exec:afo-specialist | compiled_context |

## Route preference

Prefer CairnStone-native when capability/cost/rank already equal. Does **not** override capability fit, risk/budget gates, or human `preferred_executor`.

## Dispatch

- Native → min task envelope (task_run_id, intent/note, refs, scope hints, access_grant ids, immutable base SHA, selected_executor_id). No compiled body.
- Compiled → bounded pack with budgets, omissions, provenance refs, receipt digest. Fail closed past budget.

## Explicit non-claims

- Hold 10e (Console) / 10f (DO/WS).
- No live Copilot/Cursor launch.
- Give Access / intent router unchanged.
- No new MCP tools; no D1 migration.

## Residual risks

- Native preference is a soft tiebreaker; operators must still use allow/deny lists when a compiled external executor is intentionally required over Cursor.
- Compiled stub pack is deterministic/receipted but not a full stone-body compiler — live compile quality is deferred.
- Cursor marked native while adapter remains dry-run; live MCP connectivity is assumed at product layer, not proven here.
