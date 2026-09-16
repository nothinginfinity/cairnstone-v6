# V7.7.10d — Model + Agent Execution Routing (implementation note)

status: implemented_in_repo_not_live_verified
slice: V7.7.10d
accepted_state_authority: false
start_here_gate_10c: b60b14a06a737719a4147cd8cb913c304772b1b5bc217b549f6fefbe506cb65b
amendment_stone: eab0bdb8304f0d5439b659bdbedf2715fe4894a1d9958814f4db13a8de89b22f
fabric_plan_stone: 4ccf169f4fd6e94109c1ac66e3492069beade5206c73f2ce1b3ad6d061eabfaf
runtime_baseline_before: 0.5.41
runtime_version: 0.5.42
baseline_tip: 35dac65f336a8f3afd8b62bf5d225c53f01b4e41
migration: 0023_v7710d_task_run_dispatch.sql
broker_tool_count: 87 → 94 (+7)

## What landed

- Executor profile seed registry (`cairnstone-executor-profile-v1`) with five profiles: deterministic-mcp, cairnstone-delegate, afo-specialist, github-copilot, cursor-cloud.
- Capability-aware `cairnstone_executor_route` (pure / read) emitting `cairnstone-executor-route-receipt-v1` with `authorization_state=requires_human_commit`; never dispatches.
- Expanded Task Run: statuses `proposed|queued|running|completed|failed|cancelled`, dispatch_state widened, parent/child, budgets, receipts, human_commit fields.
- `cairnstone_task_run_dispatch` requires `human_commit:true` + `committed_by`; invokes deterministic allowlisted read or dry-run coding/AFO stubs.
- Bounded subdelegation: depth≤2, fan-out≤3; child ceilings fail closed.
- Adapter contracts for Copilot/Cursor/AFO (+ dry-run stubs).
- MCP + REST mirrors; broker risk classes correct.
- Docs: `docs/V7_7_10D_MODEL_AGENT_EXECUTION_ROUTING.md`.
- Tests: `test/v7710d-executor-routing.test.js`.
- Worker VERSION `0.5.42`.

## Explicit non-claims

- No Console proposal cards (10e), no DO/WS live tree (10f).
- No live Copilot/Cursor/AFO launch or invented API keys.
- Model router (`cairnstone_model_route`) unchanged and distinct.
- Propose / intent route still never auto-dispatch.
- Task Run completion is not accepted state; HEADs never moved.

## Residual risks

- Seed registry is in-code; D1-backed discovery/health telemetry deferred.
- Coding/AFO adapters are dry-run only until safe live hooks exist.
- Deterministic adapter allowlist is intentionally narrow (proves path, not full tool surface).
- Subdelegation fan-out/depth defaults may need operator policy knobs later (10e UX).
