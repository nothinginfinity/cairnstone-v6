# V7.7.10b — Access grants + typed attachments (implementation note)

status: implemented_in_repo_not_live_verified
slice: V7.7.10b
accepted_state_authority: false
start_here_stone: 2cc7e85db99423804e23418dae4402df232e34fc537ba335a2d7b742cd713c50
amendment_stone: eab0bdb8304f0d5439b659bdbedf2715fe4894a1d9958814f4db13a8de89b22f
runtime_baseline_before: 0.5.39
runtime_version: 0.5.40
baseline_tip: f19635be534dc129a983301f921e7585315a3b41

## What landed

- Typed attachment ref resolvers (`stone:`, `ac1:`, `msg:`, `repo:owner/repo@40hex`, `session:cs:…`, conversation/turn/response).
- Full operational `cairnstone-access-grant-v1` CRUD + lifecycle (`granted` → `first_read` → `revoked`).
- Assign / Ask-to-work as non-dispatching `cairnstone-task-run-v1` proposal (`status=proposed`, `dispatch_state=not_dispatched`).
- Forward-with-note helper creating AC1 that references original object_ref (not default share).
- Migration `0022_v7710b_access_grants_task_runs.sql`.
- MCP + REST wiring; broker registry 76 → 86; worker VERSION `0.5.40`.
- Contract doc: `docs/V7_7_10B_ACCESS_GRANT_ATTACHMENTS.md`.

## Explicit non-claims

- This note must **not** move `cairnstone-v6-project-memory` chain/path HEADs.
- Grants never mint capabilities, never widen Scope/workspace/Code Session capability.
- Assign proposals do not dispatch executors (10d/10e).
- Console UI / intent router / Durable Objects remain later slices.
- Do not invent roadmap versions beyond V7.7.10a–f family.

## Secrets

No live bearers, operator tokens, or workspace capabilities are stored in grant/task-run rows. Notify-on-grant uses AC1 transport only.
