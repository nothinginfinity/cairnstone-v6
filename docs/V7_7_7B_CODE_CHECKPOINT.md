# V7.7.7b — Durable Code Checkpoints + task ledger

**Status:** in-repo implementation slice. Operational / derived plane only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. `accepted_state_authority: false` on every checkpoint / task-ledger response.

**Plan stone:** `297ffc7a5894f89464f413812646763ed670c53ef6093a39e3f06355d9d1136e`  
(`project-memory/v777-persistent-code-mode-durable-multi-agent-code-sessions-plan.md`)

**Builds on:** [V7.7.7a Durable Code Session](./V7_7_7A_DURABLE_CODE_SESSION.md) (`code_sessions`, `session_revision`, tip-vector CAS, `workspace_capability` + membership).

**Reuses:** Shared Agent Workspace (V7.7.5), mailbox/invite + `workspace_capability` (V7.7.6). No second ticket format.

## What this plane is

Immutable **Code Checkpoints** (`cairnstone-code-checkpoint-v1`) plus a durable **task ledger** with explicit state-machine transitions.

Checkpoints are **not** every keystroke. Create them at meaningful boundaries:

| Boundary | Typical use |
|----------|-------------|
| `handoff` | Actor handoff / continuity transfer |
| `pause` | Session pause boundary |
| `task_completion` | Task moved to `done` / material completion |
| `conflict_rebase` | Tip CAS conflict / rebase resolution |
| `test_gate` | Tests / build gate receipt |
| `proposal` | Proposal packet freeze |
| `user_requested` | Explicit save / resume snapshot |

A fresh model must be able to resume from the latest checkpoint **without** the predecessor chat transcript.

## Authority invariants

1. Operational state only — never accepted-state authority; never a synthetic global HEAD.
2. Create / get / list checkpoint + task transitions **never** mutate `chain_heads` or `path_heads`.
3. Authorization is existing `workspace_capability` + live `workspace_members` on the bound workspace.
4. Never persist raw capability bearers, operator tokens, or secrets (rows, context, docs, tests use redacted placeholders). Capability/policy identity is stored as `capability_policy_profile_id` only.
5. Currentness uses explicit pointers (`checkpoint_id` / `payload_digest`, `session_revision`, `tip_vector_digest`). Timestamps are informational only.
6. Fail closed on tip/session races (`code_session_tip_race` / `code_session_conflict`).
7. Checkpoints live on the operational D1 plane; they are **not** auto-promoted into canonical project-memory HEAD.

## Schema

### `code_checkpoints` (append-only)

- `checkpoint_id` — content-addressable `cp:<sha256(payload_body)>` (unique)
- `code_session_id`, `workspace_id`, `actor_id`, `boundary`
- `session_revision` — session revision observed at create time (pre-CAS bump)
- `tip_vector_json` / `tip_vector_digest` / optional `workspace_snapshot_id`
- `payload_json` / `payload_digest` — scrubbed immutable body (no UPDATE of payload)

### Minimum checkpoint payload

- session / actor / `checkpoint_id`
- repo + immutable base / observed commits
- workspace tip vector (+ digest) or snapshot id
- changed paths + revision/content identities
- current task + completed work + next action + blockers
- test/build/execution receipts + artifact/log refs
- `active_task_leases` / `known_concurrent_actors` (hydrated from live **7.7.7c** leases when empty; stubs still accepted)
- `safe_to_continue` + `known_caveats`
- `capability_policy_profile_id` (**never** raw bearer)

### Task ledger

States: `queued | claimed | active | blocked | review | done | abandoned`.

- Session tip holds the current ledger snapshot (`task_ledger_json`).
- Every transition appends `code_session_task_ledger_events` with `actor_id` + `author_id` attribution.
- Legal edges are fail-closed (`code_session_task_transition_illegal`).

## APIs

### MCP

| Tool | Auth | Notes |
|------|------|--------|
| `cairnstone_code_checkpoint_create` | membership + `write_draft` | CAS on `base_revision` (+ optional `expected_tip_vector_digest`); updates session `latest_checkpoint_id` / digest |
| `cairnstone_code_checkpoint_get` | membership + `ls` | Read immutable record |
| `cairnstone_code_checkpoint_list` | membership + `ls` | Bounded, newest-first for a session |
| `cairnstone_code_session_task_transition` | membership + `write_draft` | One task transition + append-only event + CAS snapshot |

Broker: mutations = `risk_class:mutation` + `scoped_grant`; reads = `scoped_grant`. None are automatic-read for `cairnstone_delegate`.

### REST (same FromBody handlers)

- `POST /v1/code-checkpoints`
- `POST /v1/code-checkpoints/get`
- `POST /v1/code-checkpoints/list`
- `POST /v1/code-sessions/task-transition`

### Compile-context (7.7.7a extended)

`cairnstone_code_session_compile_context` now includes:

- `latest_checkpoint` resume summary (next action, blockers, receipts, caveats, leases stubs)
- `changes_since_last_checkpoint` tip-vector diff against stored checkpoint tips
- `task_ledger_summary` (active vs completed/abandoned)

## Module map

- `migrations/0016_v777b_code_checkpoints.sql`
- `src/code-session.js` (checkpoint + task ledger + compile-context)
- `src/index.js` (MCP + REST wiring)
- `src/model-router.js` (broker registry)
- `test/code-session.test.js`
- `docs/V7_7_7B_CODE_CHECKPOINT.md` (this file)
- `docs/V7_7_7A_DURABLE_CODE_SESSION.md` (cross-link)

## Out of scope (later slices)

- **7.7.7c** task/path leases — **shipped** in [V7_7_7C_TASK_LEASES.md](./V7_7_7C_TASK_LEASES.md) (this doc previously held stubs only)
- **7.7.7d** repo-scale tree + GitZip backing
- **7.7.7e** environment reconstruct / sandbox adapter
- **7.7.7f** Console Persistent Code Mode UX
- Auto-promoting checkpoints into project-memory accepted HEAD
