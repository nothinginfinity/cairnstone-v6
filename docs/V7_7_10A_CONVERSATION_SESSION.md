# V7.7.10a — Conversation Session contract + persistence

**Status:** in-repo implementation slice. Operational state only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. `accepted_state_authority: false` on every conversation-session response.

**START HERE stone:** `eab0bdb8304f0d5439b659bdbedf2715fe4894a1d9958814f4db13a8de89b22f`  
(`project-memory/v7710-give-access-assign-amendment.md`)

**Plan stones:**
- Fabric (amended): `4ccf169f4fd6e94109c1ac66e3492069beade5206c73f2ce1b3ad6d061eabfaf`
- Foundation: `7615d226c12a0f95e09e162c297eb34df7e697adee459c939c1938e2983b5948`

**Runtime:** worker **0.5.39** (baseline tip before this slice: `ee17043e10def994991a9a00f27ff465c04b292c` / **0.5.38**)

## What this plane is

A provider-neutral **operational** Conversation Session (`cairnstone-conversation-session-v1`) that binds:

- immutable `conversation_id` (`cvs:…`)
- durable message/turn identity (`turn:…`, `cmsg:…`) with timestamps, role/type, and links to response/context/tool receipts
- `attachment_set` as opaque typed `object_ref` / `attachment_ref` placeholders (resolvers = 10b)
- `active_scope`, `selected_actors`, `selected_repo`, `selected_chain`, optional `code_session_id`
- `last_response_ids`, `routing_envelope`, `tool_receipts`, `intent_mode` (`read` | `compare` | `propose-action`)
- lean hooks: opaque `access_grant_ids[]`, `task_run_ids[]` (identity only; no grant CRUD / no executor routing)
- CAS `session_revision` for update / append-turn
- explicit non-authority envelope on every response

Conversation Session is **not** Code Session. Do not overload Code Session for chat continuity.

## Authority invariants

1. Conversation Session is **not** a Stone, chain HEAD, path HEAD, Scope authority, capability grant, or execution authorization.
2. Create / get / list / update / append-turn **never** mutate `chain_heads` or `path_heads`.
3. `accepted_state_authority` is always `false`; responses also set `grants_no_capability: true` and `project_memory_promoted: false`.
4. Conversation history is **never** bulk-promoted into project memory.
5. Actor access is membership in the session (`created_by` or `selected_actors`). No second ticket format; optional `workspace_id` is a binding hint only.
6. Lean `access_grant_ids` / typed object refs / `task_run_ids` are opaque identity hooks for later slices — they grant no capabilities and dispatch no work.
7. Currentness uses `session_revision` + turn/message identity. Timestamps are informational.

## APIs

### MCP

| Tool | Auth | Notes |
|------|------|--------|
| `cairnstone_conversation_session_create` | actor `created_by` | Creates `cairnstone-conversation-session-v1` |
| `cairnstone_conversation_session_get` | actor membership | Resume read + durable turns |
| `cairnstone_conversation_session_list` | actor_id | Bounded newest-first list for visible sessions |
| `cairnstone_conversation_session_update` | membership + `base_revision` CAS | Bindings / status / lean hooks |
| `cairnstone_conversation_session_append_turn` | membership + `base_revision` CAS | Append-only turn + message_log CAS |

Broker: mutations = `risk_class:mutation` + `scoped_grant`; reads = `scoped_grant`. **None** are automatic-read for `cairnstone_delegate`.

### REST (same FromBody handlers)

- `POST /v1/conversation-sessions`
- `POST /v1/conversation-sessions/get`
- `POST /v1/conversation-sessions/list`
- `POST /v1/conversation-sessions/update`
- `POST /v1/conversation-sessions/append-turn`

## Resume semantics

1. Create session → `session_revision = 1`, empty `message_log`.
2. Append turns with stable `turn_id` / `message_id` under CAS.
3. `get` returns the full operational record + ordered turns and a `resume` stub (`session_revision`, message_count, intent_mode).
4. Appending to a `paused` session reactivates it to `active`. `closed` / `superseded` reject append.

## Module map

- `migrations/0021_v7710a_conversation_sessions.sql`
- `src/conversation-session.js`
- `src/index.js` (MCP + REST wiring; VERSION `0.5.39`)
- `src/model-router.js` (broker registry)
- `test/conversation-session.test.js`
- `docs/V7_7_10A_CONVERSATION_SESSION.md` (this file)
- `project-memory/v7710a-conversation-session-implementation-note.md`

## Out of scope (later slices)

- **10b** typed attachment resolvers + Give Access / Assign / Forward-with-note UI + `cairnstone-access-grant-v1` CRUD
- **10c** Deterministic Intent Router
- **10d** Context packs / model+executor routing / Task Run dispatch
- **10e** Proposal cards
- **10f** Durable Objects / WebSockets

## Smoke after deploy

```bash
# after wrangler deploy + remote D1 migration apply
curl -sS "$WORKER/health" | jq '.version'   # expect 0.5.39

# MCP tools/list should include the five cairnstone_conversation_session_* tools

curl -sS -X POST "$WORKER/v1/conversation-sessions" -H 'content-type: application/json' -d '{
  "conversation_id": "cvs:smoke-10a",
  "created_by": "chatgpt:cairnstone-v6",
  "intent_mode": "read",
  "selected_actors": ["claude:cairnstone-v6"]
}'

curl -sS -X POST "$WORKER/v1/conversation-sessions/append-turn" -H 'content-type: application/json' -d '{
  "conversation_id": "cvs:smoke-10a",
  "actor_id": "chatgpt:cairnstone-v6",
  "base_revision": 1,
  "turn_id": "turn:smoke-1",
  "message_id": "cmsg:smoke-1",
  "role": "user",
  "content_preview": "smoke"
}'

curl -sS -X POST "$WORKER/v1/conversation-sessions/get" -H 'content-type: application/json' -d '{
  "conversation_id": "cvs:smoke-10a",
  "actor_id": "chatgpt:cairnstone-v6"
}'
# expect resume.message_count=1, accepted_state_authority=false, session_revision=2
```
