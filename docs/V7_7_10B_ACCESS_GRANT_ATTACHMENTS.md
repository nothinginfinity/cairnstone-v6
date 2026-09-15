# V7.7.10b — Typed attachments + Give Access / Assign (worker)

**Status:** in-repo implementation slice (worker half). Operational state only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. `accepted_state_authority: false` on every response.

**START HERE stone:** `2cc7e85db99423804e23418dae4402df232e34fc537ba335a2d7b742cd713c50`  
(V7.7.10a COMPLETE / LIVE-VERIFIED)

**Amendment:** `eab0bdb8304f0d5439b659bdbedf2715fe4894a1d9958814f4db13a8de89b22f`  
(`project-memory/v7710-give-access-assign-amendment.md`)

**Runtime:** worker **0.5.40** (baseline tip before this slice: `f19635be534dc129a983301f921e7585315a3b41` / **0.5.39**)

## What this plane is

Worker half of three distinct operations over **canonical object identity**:

| Operation | Creates | Does **not** |
|-----------|---------|--------------|
| **Give Access** | `cairnstone-access-grant-v1` row | Copy message/Stone/repo bytes; imply execute/mutate |
| **Assign / Ask to work** | `cairnstone-task-run-v1` **proposal** with same `attachment_refs[]` | Grant access; auto-dispatch executors |
| **Forward with note** | New AC1 correspondence **referencing** original | Default share path (Give Access is default) |

Plus typed attachment ref resolvers that fill 10a Conversation Session `attachment_set` placeholders.

## Typed attachments

Supported refs (normalize + bounded orientation):

- `stone:<64hex>` (also bare 64-hex)
- `ac1:<64hex>`
- `msg:…`
- `repo:owner/repo@40hex` — **immutable SHA only** (branch rejected)
- `session:cs:…` / `cs:…`
- `conversation:cvs:…` / `cvs:…`
- `turn:…`, `cmsg:…`
- `response:…` / `grounded-response:…` / `gr:…`
- opaque hooks: `grant:…`, `tr:…`

Resolvers return orientation only. They **never** grant capability or accepted-state authority.

Optional: resolve a Conversation Session `attachment_set` and CAS-apply (`apply=true` + `base_revision`).

## Access grants (`cairnstone-access-grant-v1`)

D1 operational record fields:

`grant_id`, `schema`, `object_ref`, `principal_actor_id`, `permission` (`read`|`discuss`|`execute-against`), `grantor_actor_id`, `created_at`, `expires_at?`, `revoked_at?`, `status` (`granted`|`first_read`|`revoked`), `first_read_at?`, `notify?`, `accepted_state_authority=false`

Rules:

- `read` / `discuss` never imply execute or mutate
- `execute-against` is **recorded only**; grant alone does not execute
- revoke = **future access only** (no erasure of already-read data)
- never move chain_heads/path_heads; never mint capabilities; never silently widen Scope/workspace/Code Session capability
- optional `notify=true` sends AC1 informational notice (not Scope widen)

## Assign / Ask to work

Creates `cairnstone-task-run-v1` with:

- `status=proposed`
- `dispatch_state=not_dispatched`
- `intent_mode=propose-action`
- `attachment_refs[]` / `object_refs[]` = same canonical identities

Does **not** call executor registry, `cairnstone_run_task_request`, or coding-agent dispatch. Human Dispatch/Approve remains 10d/10e.

## Forward with note

`cairnstone_forward_with_note` creates a new AC1 message whose content is `cairnstone-forward-note-v1` JSON referencing `object_ref` + operator note. Distinct from Give Access; `is_default_share_path=false`.

## Authority invariants

1. Grants / proposals / forward / resolvers are **not** Stones, HEADs, Scope authority, or execution authorization.
2. Create / get / list / revoke / mark_first_read / propose / resolve **never** mutate `chain_heads` or `path_heads`.
3. `accepted_state_authority` is always `false`; responses also set `grants_no_capability: true`.
4. Assign does not grant access; Give Access does not dispatch work.

## APIs

### MCP

| Tool | Auth | Notes |
|------|------|--------|
| `cairnstone_attachment_ref_resolve` | scoped_grant read | Resolve/normalize refs; optional session apply |
| `cairnstone_access_grant_create` | scoped_grant mutation | Give Access |
| `cairnstone_access_grant_get` | scoped_grant read | Grantor or principal |
| `cairnstone_access_grant_list` | scoped_grant read | Filter by principal / object_ref / status |
| `cairnstone_access_grant_revoke` | scoped_grant mutation | Grantor only; future access only |
| `cairnstone_access_grant_mark_first_read` | scoped_grant mutation | Principal audit receipt |
| `cairnstone_task_run_propose` | scoped_grant mutation | Assign proposal (not dispatched) |
| `cairnstone_task_run_get` | scoped_grant read | Requester or assignee |
| `cairnstone_task_run_list` | scoped_grant read | Bounded newest-first |
| `cairnstone_forward_with_note` | scoped_grant mutation | New AC1 referencing original |

Broker: mutations = `risk_class:mutation` + `scoped_grant`; reads = `scoped_grant`. **None** are automatic-read for `cairnstone_delegate`.

### REST (same FromBody handlers)

- `POST /v1/attachment-refs/resolve`
- `POST /v1/access-grants`
- `POST /v1/access-grants/get|list|revoke|mark-first-read`
- `POST /v1/task-runs/propose|get|list`
- `POST /v1/correspondence/forward-with-note`

## Module map

- `migrations/0022_v7710b_access_grants_task_runs.sql`
- `src/attachment-refs.js`
- `src/access-grant.js`
- `src/task-run.js`
- `src/forward-note.js`
- `src/index.js` (MCP + REST; VERSION `0.5.40`)
- `src/model-router.js` (broker registry; 76 → 86 tools)
- `src/conversation-session.js` (preserve resolved attachment metadata)
- `test/v7710b-access-grant-attachments.test.js`
- `docs/V7_7_10B_ACCESS_GRANT_ATTACHMENTS.md` (this file)
- `project-memory/v7710b-access-grant-attachments-implementation-note.md`

## Out of scope (later slices)

- **10c** Deterministic Intent Router (`give-access` / `revoke-access` / `assign` / `forward-with-note`)
- **10d** Task Run execution / executor routing / dispatch
- **10e** Proposal-card UX polish (Console)
- **10f** Durable Objects / WebSockets
- Console UI (separate repo)

## Smoke after deploy

```bash
# after wrangler deploy + remote D1 migration apply (0022)
curl -sS "$WORKER/health" | jq '.version'   # expect 0.5.40

# 1) Resolve attachment
curl -sS -X POST "$WORKER/v1/attachment-refs/resolve" -H 'content-type: application/json' -d '{
  "object_refs": ["stone:'"$STONE_HASH"'", "repo:nothinginfinity/cairnstone-v6@'"$COMMIT_SHA"'", "msg:smoke-original"]
}'

# 2) Create grant → first_read → revoke
curl -sS -X POST "$WORKER/v1/access-grants" -H 'content-type: application/json' -d '{
  "grant_id": "grant:smoke-10b",
  "object_ref": "msg:smoke-original",
  "principal_actor_id": "claude:cairnstone-v6",
  "permission": "read",
  "grantor_actor_id": "chatgpt:cairnstone-v6",
  "notify": false
}'

curl -sS -X POST "$WORKER/v1/access-grants/mark-first-read" -H 'content-type: application/json' -d '{
  "grant_id": "grant:smoke-10b",
  "actor_id": "claude:cairnstone-v6"
}'

curl -sS -X POST "$WORKER/v1/access-grants/revoke" -H 'content-type: application/json' -d '{
  "grant_id": "grant:smoke-10b",
  "actor_id": "chatgpt:cairnstone-v6"
}'

# 3) Assign proposal (no dispatch)
curl -sS -X POST "$WORKER/v1/task-runs/propose" -H 'content-type: application/json' -d '{
  "task_run_id": "tr:smoke-10b",
  "actor_id": "chatgpt:cairnstone-v6",
  "assignee_actor_id": "grok:cairnstone-v6",
  "attachment_refs": ["msg:smoke-original"],
  "note": "smoke ask-to-work"
}'
# expect status=proposed, dispatch_state=not_dispatched, dispatched=false
```
