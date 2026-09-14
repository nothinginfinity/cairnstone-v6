# V7.7.7e — Reconstructable execution environment + disposable sandbox

**Status:** in-repo implementation slice. Operational / reconstructability plane only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. Sandbox-local execution is **not** production, deploy, merge, or accepted-state authority. `accepted_state_authority: false` on every environment / sandbox / receipt response. Never stores raw provider credentials / API keys / bearers / secrets (`secrets_absent: true` always).

**Plan stone:** `297ffc7a5894f89464f413812646763ed670c53ef6093a39e3f06355d9d1136e`  
(`project-memory/v777-persistent-code-mode-durable-multi-agent-code-sessions-plan.md` § V7.7.7e)

**Builds on:** [V7.7.7a Durable Code Session](./V7_7_7A_DURABLE_CODE_SESSION.md) + [V7.7.7b Code Checkpoints](./V7_7_7B_CODE_CHECKPOINT.md) + [V7.7.7c Task Leases](./V7_7_7C_TASK_LEASES.md) + [V7.7.7d Repo-scale Working Tree](./V7_7_7D_REPO_SCALE_WORKING_TREE.md)

**Reuses:** Shared Agent Workspace (V7.7.5), mailbox/invite + `workspace_capability` (V7.7.6). No second ticket format.

## What this plane is

Provider-neutral **environment manifests**, disposable **sandbox attachment** records, and immutable **sandbox-local execution receipts**. Reconstructability evidence only — recording a receipt never means deploy/merge/accepted-state.

| Capability | Role |
|------------|------|
| `environment_manifest_create` / `get` | Append-only reconstructable env recipe (`cairnstone-environment-manifest-v1`) |
| `code_session_attach_environment` | CAS-attach `environment_manifest_id` onto a Code Session |
| `sandbox_attach` / `get` / `detach` | Disposable compute attachment (`latest_sandbox_attachment_id`); own-actor detach |
| `execution_receipt_create` / `get` / `list` | Immutable sandbox-local run evidence; updates `latest_execution_receipt_refs` |

## Authority invariants

1. Sandbox ≠ deploy / merge / accepted state — `accepted_state_authority: false` always; `production_mutation_authority: false`; `sandbox_local_execution_only: true`.
2. Environment / sandbox / receipt ops **never** mutate `chain_heads` or `path_heads`.
3. No secrets — env bindings are **names only**; secret-looking names/keys rejected; `secrets_absent` column CHECK = 1.
4. Auth = existing `workspace_capability` + live `workspace_members` (mutations need `write_draft`; reads need `ls`). No second ticket.
5. `sandbox_execution_class` gates `command_class` (`install` only when `local_install_build_test`).
6. Attach environment uses **CAS** on `base_revision` (`code_session_conflict` on stale).
7. Detach is own-actor only; destroying a sandbox does **not** destroy the durable Code Session.
8. Fail closed on expired/revoked capability, wrong actor, missing membership, or secret-bearing payloads.

## Schema

### `migrations/0019_v777e_environment_sandbox.sql`

Additive pointer on `code_sessions`:

- `latest_sandbox_attachment_id`

New tables:

- `environment_manifests` — payload + digest; `sandbox_execution_class`; `secrets_absent = 1`; `accepted_state_authority = 0`
- `code_session_sandbox_attachments` — disposable attach/detach statuses; same authority CHECKs
- `code_session_execution_receipts` — immutable receipts; `production_mutation = 0`; `accepted_state_authority = 0`

## APIs

### MCP

| Tool | Auth | Notes |
|------|------|--------|
| `cairnstone_environment_manifest_create` | membership + `write_draft` | secrets_absent; never HEADs |
| `cairnstone_environment_manifest_get` | membership + `ls` | read-only |
| `cairnstone_code_session_attach_environment` | membership + `write_draft` | CAS `base_revision` |
| `cairnstone_code_session_sandbox_attach` | membership + `write_draft` | sets `latest_sandbox_attachment_id` |
| `cairnstone_code_session_sandbox_detach` | membership + `write_draft` | own actor; session remains durable |
| `cairnstone_code_session_sandbox_get` | membership + `ls` | by `attachment_id` or latest for session |
| `cairnstone_execution_receipt_create` | membership + `write_draft` | command class gated; evidence only |
| `cairnstone_execution_receipt_get` | membership + `ls` | immutable receipt |
| `cairnstone_execution_receipt_list` | membership + `ls` | newest-first, bounded |

Broker: mutations = `risk_class:mutation` + `scoped_grant`; reads = `scoped_grant`. None are automatic-read for `cairnstone_delegate`. Total broker tools = **67**.

### REST

- `POST /v1/environment-manifests`
- `POST /v1/environment-manifests/get`
- `POST /v1/code-sessions/attach-environment`
- `POST /v1/code-sessions/sandbox/attach`
- `POST /v1/code-sessions/sandbox/detach`
- `POST /v1/code-sessions/sandbox/get`
- `POST /v1/execution-receipts`
- `POST /v1/execution-receipts/get`
- `POST /v1/execution-receipts/list`

## Code session / compile-context integration

- Session may hold `environment_manifest_id` and `latest_sandbox_attachment_id`.
- Receipt create updates `latest_execution_receipt_refs` (optional CAS when `base_revision` provided).
- `cairnstone_code_session_compile_context` includes `environment_sandbox` with:
  - `environment_manifest` / `sandbox_attachment` summaries
  - `latest_execution_receipt_refs`
  - `secrets_absent: true`
  - `sandbox_local_execution_only: true`
  - `accepted_state_authority: false`
  - `production_mutation_authority: false`
  - reconstructability note (`survives_sandbox_destruction`)

## Module map

- `migrations/0019_v777e_environment_sandbox.sql`
- `src/environment-sandbox.js` (manifests + sandbox + receipts + MCP FromBody + tool defs)
- `src/code-session.js` (compile-context `environment_sandbox`; `latest_sandbox_attachment_id`)
- `src/index.js` (MCP + REST wiring; worker `0.5.35`)
- `src/model-router.js` (broker registry; 67 tools)
- `test/environment-sandbox.test.js`
- `test/model-router.test.js` / `test/code-session.test.js` (broker + compile regressions)
- `docs/V7_7_7E_ENVIRONMENT_SANDBOX.md` (this file)

## Smoke steps

1. Apply migration `0019_v777e_environment_sandbox.sql`.
2. `node --check src/environment-sandbox.js src/code-session.js src/index.js src/model-router.js`
3. `node --test test/environment-sandbox.test.js test/model-router.test.js test/code-session.test.js`
4. Confirm broker total = 67; environment/sandbox tools absent from automatic-read list.
5. Optional: full `npm test`.

## Out of scope (later slices)

- **7.7.7f** Console Persistent Code Mode UX
- Promoting sandbox receipts into project-memory accepted HEAD
- Treating sandbox attach/success as deploy or production mutation authority
- Storing raw provider credentials / secret env values in manifests or receipts
