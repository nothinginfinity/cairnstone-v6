# V7.7.10n.0 — CairnStone Computer contract

Status: DRAFT / contract-only. Not merged. Not deployed. Class H is not implemented.
Date: 2026-10-04
Author: grok:cairnstone-v6
Base: `main` `55142f79d69e900479e24102c23a87f301c70272`
Canonical lock stone: `e37be2c29ca0cb4b6e0660d635f7625be42bf34d6163bbc104d40a016b4c99b7`
Chain HEAD intentionally unchanged: `4e1776c97eb5adf180a3d0f26f577b50889f6d922aa560ab7faccc5e2e8c15ec`

> The computer belongs to the user. The phone is the console. The AI is an interchangeable operator.

10n.0 defines and tests the computer constitution only. It does not provision or operate a live computer.

## Schema envelope (`cairnstone-computer-v1`)

Provider-neutral logical computer. A Cloudflare container, sandbox, or VM identifier is an adapter handle only and must never be `computer_id`.

Required fields:

- `schema`: `cairnstone-computer-v1`
- `computer_id`: `pc:<owner_account_id>:<opaque>`; no provider-runtime words
- `owner_account_id`: user/tenant root; not an AI actor id; must equal the owner segment encoded in `computer_id`
- `backend_class`: `S | H | V | C` (default target `H`)
- `lifecycle`: see lifecycle state machine
- `accepted_state_authority`: must be `false`

Optional:

- `provider_runtime_id`: adapter handle; never equal to `computer_id`
- `home`: Class-H home fixture (`status`, `generation`, `last_successful_generation`)

JSON Schema uses `additionalProperties: false`. The pure JS helper `assertContractEnvelope` enforces semantic rules (owner match, provider neutrality, authority exclusions, home consistency). Forbidden authority keys (`deploy_authority`, `credential_vault_read`, `browser_profile_read`, `unrestricted_network`, `spend_authority`) must not appear on computer/runtime/session objects; `accepted_state_authority` may appear only as `false`.

## Backend classes (adapter contracts)

| Class | Role in 10n.0 | Semantics |
|---|---|---|
| `S` | Ephemeral/session compute adapter contract | Disposable runtime; no durable home promise |
| `H` | Default personal-computer target | Durable generation-controlled home + replaceable runtime |
| `V` | Interface definition only | Full desktop/stream surface deferred (10n.8 / later) |
| `C` | Interface definition only | Multi-computer / team class deferred (10n.8 / later) |

Classes `V` and `C` are accepted as enum values for contract typing only. This slice does not authorize implementing them.

## Provider-adapter interface (definition only)

A provider adapter binds a logical computer to a replaceable runtime handle.

Required conceptual surface:

- `computer_id` (logical, provider-neutral)
- `provider` (e.g. `cloudflare`)
- `provider_runtime_id` (opaque handle; never aliases `computer_id`)
- `backend_class`
- `accepted_state_authority: false`

The first planned runtime adapter is Cloudflare Sandbox/Containers for Class `S` and the replaceable runtime under Class `H`. Identity remains provider-neutral. No provisioning in 10n.0.

## Storage / home adapter contract (definition only)

Class-H durable home is backed by a protected object/durable store (R2 or equivalent). 10n.0 defines the contract; 10n.3 must prove the implementation. No R2 mount or production storage mutation in this slice.

Required conceptual surface:

- `computer_id`
- `home_profile_ref`
- `generation` / `last_successful_generation`
- `status`: `clean | dirty | checkpointing | checkpoint_failed`
- operations: `checkpoint`, `restore`, `rejectEmptyHome`
- `runtime_root_promotable: false`

## Lifecycle state machine

Allowed states: `registered`, `stopped`, `starting`, `running`, `checkpointing`, `sleeping`, `destroy_pending`, `runtime_destroyed`, `restore_failed`.

Primary path:

`registered -> stopped -> starting -> running`

From `running`:

- enter `checkpointing` for explicit checkpoint, controlled sleep, or controlled destroy
- success returns to `running`, or advances to `sleeping` / `runtime_destroyed` (via `destroy_pending` when destroy is staged)
- failure stays incomplete and must not report sleep/destroy success

`runtime_destroyed` destroys the active runtime only. The logical computer remains.

`restore_failed` leaves the computer stopped against the last known-good generation. An empty home must never be mounted as success.

## Class-H home generation / checkpoint / restore

Durability model:

```text
computer_id
  -> home_profile_ref
  -> home_generation
  -> last_successful_generation
```

Rules:

1. Runtime/root filesystem is disposable implementation state and is never silently promoted into durable personal state.
2. Protected home/profile is generation-controlled with explicit `clean | dirty | checkpointing | checkpoint_failed`.
3. Controlled sleep/destroy cannot complete unless `status=clean` and `generation == last_successful_generation`.
4. Invalid combinations fail closed (unknown status; non-integer / `<1` generations; `generation < last_successful_generation`; `clean` with generation ahead of last successful).
5. Committed Git reconstructs from remote plus immutable commit evidence.
6. Uncommitted work is not assumed recoverable from Git; durability requires an explicit Workspace/home generation/snapshot policy.
7. Unexpected runtime loss restores the last successful home generation, reconstructs committed Git where applicable, surfaces the uncommitted-work loss boundary, and never mounts an empty home.

Restore targets `last_successful_generation` by default. An explicitly selected generation must be a known positive generation and must not be later than `last_successful_generation`. Selecting a prior generation is allowed only when that generation is known and strictly earlier. Future or invalid generations fail closed as `restore_failed`.

In this 10n.0 pure fixture, "known generation" means an integer in the inclusive range `1 .. last_successful_generation`. There is no persisted-generation catalog yet; existence/catalog enforcement belongs to the later registry/home adapter.

## Human Computer Session contract

Human Computer Session v1 (phone-reachable):

```text
CairnStone Computer
  -> brokered browser
  -> file pane
  -> terminal pane
```

Shape:

- `session_plane: "human"`
- `computer_id` (same logical computer for all panes)
- `owner_account_id` (owner-only by default)
- `panes`: subset of `browser | file | terminal`
- `accepted_state_authority: false`
- human-approval boundary methods: `passkey | oauth | device_code` (contract only; no live auth in 10n.0)

Phone is the preferred authenticator for passkey/WebAuthn, OAuth approval, and device-code approval. Full noVNC/desktop streaming is deferred.

## Agent Computer Session / grant contract

`agent_session` is always a narrower explicit grant. Sharing `computer_id` does not share privileges.

Shape:

- `session_plane: "agent"`
- `computer_id`
- `actor_id`
- `boundaries`: explicit allowlist (e.g. `workspace_read`, `terminal`)
- `revoked: boolean`
- optional ceilings: `parent_task_run_id`, `parent_boundaries`, `budget_ceiling`, `budget_used`
- `accepted_state_authority: false`

Default denials (must not be grantable as inherited privileges): credential vault, human browser cookie/profile store, deploy, accepted-state, spend, unrestricted network.

Rules:

- crossing a protected boundary requires that boundary to appear in `boundaries`
- revocation sets `revoked=true`, terminates that actor's processes/sessions, and does **not** delete the logical computer
- terminal pane/access does not grant deploy, accepted-state, credential, spend, or unrestricted network authority
- child agents must stay inside parent task-run, grant (`boundaries ⊆ parent_boundaries`), and budget ceilings

## Network policy + expiring preview capability

Network policy shape:

- `default_inbound_public: false`
- `egress_allowlist: string[]`
- optional `policy_id`, `updated_by`, `updated_at` for attribution

Preview capability shape:

- `capability_id`
- `expires_at` (parseable finite timestamp)
- evaluation `now` must also be parseable when supplied

Rules:

- no public inbound by default
- egress only to allowlisted hosts
- preview requires capability id + unexpired finite timestamps
- malformed/missing policy or request objects fail closed
- network allow never grants `deploy` or `accepted_state` authority
- policy expansion must be attributable/auditable

## Semantic audit event requirements

Required attributable event kinds (definition only; live journal writing is deferred to the audit plane / later slices):

- `lifecycle.transition`
- `home.checkpoint_failed`
- `home.restore_failed`
- `grant.issued`
- `grant.revoked`
- `network.policy_expanded`
- `runtime.unexpected_loss`

Each event must carry: `event_kind`, `computer_id`, `actor_id`, `at` (timestamp), and `attribution` (who/what caused it). This slice specifies the requirement and validates event shape fixtures; it does not write the live journal.

## Product boundary

CairnStone Computer is a sibling of Core, Messages, Console, and Harnesses. Messages is not the computer transport. Console remains deep admin. No production MCP computer tools, executor registration, D1 schema, R2 mount, or Cloudflare provisioning in this slice.

## RESUME #2 isolation

Re-checked 2026-10-04 against `main` `55142f79`:

| Branch | Tip | Ahead | Behind | Recommendation |
|---|---|---|---|---|
| `v7710f1-semantic-audit-journal` | `2c22d169` | 1 | 22 | rebase onto current main later; do not mix into 10n.0 |
| `v7711i-stone-inspector` | `18dd9500` | 36 | 22 | keep isolated; review before any rebase |
| `grok/v7710h5-jev-workers-ai-binding` (PR #56 draft) | `1fb47e91` | 6 | 26 | remain draft; do not merge |

10n.0 adds only contract docs, a pure validator, and node tests. It does not edit runtime modules owned by those branches and does not execute the integration. Integration execution remains unauthorized.

## Deferred to later slices

- 10n.1 registry + live lifecycle persistence
- 10n.2 live Class-S/runtime adapter
- 10n.3 prove Class-H durable home + destroy/restore
- 10n.4 human browser/file/terminal surface + credential bindings
- 10n.5 bounded agent computer session runtime
- 10n.6 Task Run / `exec:cairnstone-computer`
- 10n.8 V/C adapters and multi-computer
- live semantic audit journal writes
- persisted generation catalog / R2 provisioning

## Not authorized

Provisioning, live instances, purchased compute, Class H implementation claims, storage mutations, production D1, live browser infrastructure, secrets, login automation, unrestricted shell/network, production MCP tools, merge, deploy, beta/GA, commercial launch.
