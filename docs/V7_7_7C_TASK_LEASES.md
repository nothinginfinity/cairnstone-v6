# V7.7.7c — Multi-agent awareness + task/path leases

**Status:** in-repo implementation slice. Operational / coordination plane only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. `accepted_state_authority: false` on every lease response. Leases are **coordination hints**, not locks and not accepted-state authority.

**Plan stone:** `297ffc7a5894f89464f413812646763ed670c53ef6093a39e3f06355d9d1136e`  
(`project-memory/v777-persistent-code-mode-durable-multi-agent-code-sessions-plan.md` § V7.7.7c)

**Builds on:** [V7.7.7a Durable Code Session](./V7_7_7A_DURABLE_CODE_SESSION.md) + [V7.7.7b Code Checkpoints](./V7_7_7B_CODE_CHECKPOINT.md) (`active_task_leases` / `known_concurrent_actors` stubs now hydrate from live rows).

**Reuses:** Shared Agent Workspace (V7.7.5), mailbox/invite + `workspace_capability` (V7.7.6). No second ticket format.

## What this plane is

Short, renewable **task/path leases** so actors can see who is actively editing before collisions.

| Field | Role |
|-------|------|
| `lease_id` (`lease:…`) | Explicit identity for renew/release / currentness |
| `actor_id` | Who holds the lease |
| `task_id` | Optional but preferred task claim |
| `path_prefixes` | Optional path / path-prefix set |
| `acquired_at` / `renewed_at` / `expires_at` | Informational acquire/renew; **liveness** uses `expires_at` vs server now |
| `checkpoint_id` / `session_revision` | Optional refs (informational; lease ops do not bump session revision) |
| `status` | `active \| released \| expired` |

## Authority invariants

1. Operational only — `accepted_state_authority: false` always; `coordination_hint_only: true`.
2. Lease ops **never** mutate `chain_heads` or `path_heads`.
3. Auth = existing `workspace_capability` + live `workspace_members` (mutations need `write_draft`; list needs `ls`).
4. Never persist raw capability bearers / secrets.
5. Timestamps are informational; lease liveness is `status=active` AND `expires_at > now` (+ explicit `lease_id`).
6. Fail closed on expired/revoked capability, wrong actor, missing membership, or optional stale `base_revision` CAS.
7. Stale/expired leases **never** block indefinitely (lazy expire sweep on acquire/list/renew/release).

## Normal behavior

1. **Avoid duplicate work** when another actor has a **live** overlapping lease → `code_session_lease_conflict` with `overlapping_leases` + `known_concurrent_actors` (do not silently proceed as sole owner).
2. **Allow intentional overlap** when `allow_overlap=true` (alias `force=true`) — lease is still recorded; response surfaces `overlap_allowed` + foreign overlaps.
3. **Hard correctness** remains **workspace CAS** if two actors still touch the same path.
4. Expired leases do not block new acquires.
5. Conflict / rebase should produce a new checkpoint/receipt (`boundary: conflict_rebase`) rather than silent last-write-wins — create-checkpoint auto-hydrates live leases into payload stubs when empty.

### Overlap rules

Scopes overlap when any of:

- either side is unconstrained (no `task_id` and empty `path_prefixes`) — session-wide awareness
- both have the same non-null `task_id`
- any path-prefix pair is equal or one is a prefix of the other

Same-actor re-acquire of an overlapping live lease **renews in place** (`action: renewed_existing`).

## TTL policy

| Knob | Value |
|------|-------|
| Default TTL | 600s (10 minutes) |
| Min TTL | 30s |
| Max TTL | 3600s (1 hour) |
| Renew | Extends `expires_at` from **server now** + TTL |

## Schema

### `code_session_leases` (`migrations/0017_v777c_code_session_leases.sql`)

Explicit lease rows with indexes on `(code_session_id, expires_at)` and live `(code_session_id, status, expires_at)`.

Lease mutations update status / expiry on the same row (not session tip CAS). Optional `base_revision` on acquire/renew fail-closes with `code_session_conflict` when provided and stale — without bumping `session_revision`.

## APIs

### MCP

| Tool | Auth | Notes |
|------|------|--------|
| `cairnstone_code_session_lease_acquire` | membership + `write_draft` | Create/renew short TTL lease; deny foreign overlap unless `allow_overlap` |
| `cairnstone_code_session_lease_renew` | membership + `write_draft` | Extend expiry for **own** live lease only |
| `cairnstone_code_session_lease_release` | membership + `write_draft` | Release **own** lease only |
| `cairnstone_code_session_lease_list` | membership + `ls` | Live leases; optional `include_expired` |

Broker: mutations = `risk_class:mutation` + `scoped_grant`; list = `scoped_grant` read. None are automatic-read for `cairnstone_delegate`.

### REST

- `POST /v1/code-sessions/leases/acquire`
- `POST /v1/code-sessions/leases/renew`
- `POST /v1/code-sessions/leases/release`
- `POST /v1/code-sessions/leases/list`

### Awareness surfaces

- `cairnstone_code_session_get` includes `active_task_leases` + `known_concurrent_actors`
- `cairnstone_code_session_compile_context` includes the same plus `multi_agent_awareness` (`hard_correctness: workspace_cas`)
- Checkpoint create hydrates 7.7.7b stubs from live leases when empty (especially `conflict_rebase`)

## Relationship to CAS + 7.7.7b

- Leases = social / coordination layer before collision.
- Workspace tip CAS = hard write correctness if collision still occurs.
- Checkpoints remain the durable resume/receipt boundary; conflict resolution should create a `conflict_rebase` checkpoint rather than last-write-wins.

## Module map

- `migrations/0017_v777c_code_session_leases.sql`
- `src/code-session.js` (lease acquire/renew/release/list + awareness)
- `src/index.js` (MCP + REST wiring; worker `0.5.33`)
- `src/model-router.js` (broker registry)
- `test/code-session.test.js`
- `docs/V7_7_7C_TASK_LEASES.md` (this file)
- `docs/V7_7_7B_CODE_CHECKPOINT.md` (cross-link)

## Out of scope (later slices)

- **7.7.7d** repo-scale tree + GitZip backing — **shipped** in [V7_7_7D_REPO_SCALE_WORKING_TREE.md](./V7_7_7D_REPO_SCALE_WORKING_TREE.md)
- **7.7.7e** environment reconstruct / sandbox adapter — **shipped** in [V7_7_7E_ENVIRONMENT_SANDBOX.md](./V7_7_7E_ENVIRONMENT_SANDBOX.md)
- **7.7.7f** Console Persistent Code Mode UX
- Treating leases as exclusive locks or accepted-state authority
- Auto-promoting checkpoints / leases into project-memory accepted HEAD
