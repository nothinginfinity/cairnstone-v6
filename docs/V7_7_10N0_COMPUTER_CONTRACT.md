# V7.7.10n.0 — CairnStone Computer contract

Status: DRAFT / contract-only. Not merged. Not deployed. Class H is not implemented.
Date: 2026-10-04
Author: grok:cairnstone-v6
Base: `main` `55142f79d69e900479e24102c23a87f301c70272`
Roadmap path HEAD: `e37be2c29ca0cb4b6e0660d635f7625be42bf34d6163bbc104d40a016b4c99b7`
Chain HEAD intentionally unchanged: `4e1776c97eb5adf180a3d0f26f577b50889f6d922aa560ab7faccc5e2e8c15ec`

> The computer belongs to the user. The phone is the console. The AI is an interchangeable operator.

## Schema

`cairnstone-computer-v1` is the provider-neutral logical computer. A Cloudflare container, sandbox, or VM identifier is an adapter handle only. It must never be `computer_id`.

Required envelope:

- `schema`: `cairnstone-computer-v1`
- `computer_id`: `pc:<owner_account_id>:<opaque>` and must not contain provider runtime words
- `owner_account_id`: user/tenant root; not an AI actor id
- `backend_class`: `S | H | V | C` (default target `H`)
- `lifecycle`: see state machine
- `accepted_state_authority`: must be `false`
- `provider_runtime_id`: optional adapter handle, never equal to `computer_id`

Classes `V` and `C` are interface definitions only in this slice.

## Lifecycle

`registered -> stopped -> starting -> running`

From `running`:

- `checkpointing` on explicit checkpoint, controlled sleep, or controlled destroy
- success returns to `running`, or advances to `sleeping` / `runtime_destroyed`
- failure stays incomplete and must not report sleep/destroy success

`runtime_destroyed` destroys the active runtime only. The logical computer remains and restores from `last_successful_generation`.

An explicitly selected home generation must be a known positive generation and must not be later than `last_successful_generation`. Selecting a prior generation is allowed only when that generation is known and strictly earlier. Future or invalid generations fail closed as `restore_failed`.

`restore_failed` leaves the computer stopped against the last known-good generation. An empty home must never be mounted as success.

## Class H durability

Runtime/root filesystem is disposable implementation state. It is never silently promoted into personal state.

Protected home/profile:

- generation-controlled
- explicit `clean | dirty | checkpointing | checkpoint_failed`
- controlled sleep/destroy cannot complete unless `status=clean` and `generation == last_successful_generation`

Committed Git reconstructs from remote plus immutable commit evidence. Uncommitted work is not recoverable from Git unless an explicit home-generation policy covers it. Unexpected runtime loss restores the last successful home generation and must surface the uncommitted-work loss boundary.

## Sessions

`human_session` is owner-only by default. `agent_session` is a narrower explicit grant. Sharing `computer_id` does not share privileges.

Default denials for agents: credential vault, human browser cookie/profile store, deploy, accepted-state, spend, unrestricted network. Revocation ends that actor's processes/sessions and does not delete the logical computer. Terminal access is not deploy authority. Child agents stay inside parent task-run, grant, and budget ceilings.

Phone is the preferred human authenticator for passkey/WebAuthn, OAuth approval, and device-code approval. This slice defines the boundary only. It does not provision credentials or automate login.

## Network

Default policy: egress allowlist, no public inbound, preview URLs require an expiring capability, and network expansion never grants accepted-state or deploy authority. Policy changes must be attributable.

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

## Not authorized

Provisioning, live instances, purchased compute, Class H implementation claims, storage mutations, production D1, live browser infrastructure, secrets, login automation, unrestricted shell/network, production MCP tools, merge, deploy, beta/GA, commercial launch.
