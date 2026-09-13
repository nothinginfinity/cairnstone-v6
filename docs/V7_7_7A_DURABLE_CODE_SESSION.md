# V7.7.7a — Durable Code Session + deterministic resume/context contract

**Status:** in-repo implementation slice. Operational state only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. `accepted_state_authority: false` on every code-session response.

**Plan stone:** `297ffc7a5894f89464f413812646763ed670c53ef6093a39e3f06355d9d1136e`  
(`project-memory/v777-persistent-code-mode-durable-multi-agent-code-sessions-plan.md`)

**Reuses:** Shared Agent Workspace (V7.7.5), mailbox/invite + `workspace_capability` (V7.7.6). No second ticket format, actor registry, or model-self-service authority path.

## What this plane is

A provider-neutral **operational** Code Session that binds:

- immutable `code_session_id` (`cs:…`)
- project chain / Scope identity
- bound `workspace_id` (draft CAS tree)
- source repo(s) + immutable base commit(s)
- optional working branch/PR **transport** refs (never accepted-state authority)
- durable tip-vector / snapshot identity
- task ledger + unresolved issues
- actors with roles + last checkpoint / session-revision refs
- environment manifest id, execution receipt refs, latest checkpoint id
- capability/policy profile identity
- lifecycle: `active | paused | blocked | proposed | closed | superseded`

The sandbox, chat, and model are replaceable. The Code Session is the durable continuity record.

## Authority invariants

1. Code Session is **not** a synthetic global HEAD.
2. Create / get / pause / resume / compile-context **never** mutate `chain_heads` or `path_heads`.
3. Authorization is existing `workspace_capability` + live `workspace_members` on the bound workspace.
4. Working branch/PR refs are transport-only; immutable base commits remain source identity.
5. Currentness uses explicit pointers (`session_revision`, `tip_vector_digest`, checkpoint id/digest). Timestamps are informational only.
6. Tip refresh / context compile re-reads tips and fail-closes on race (`code_session_tip_race` / `code_session_context_race` / `code_session_conflict`).
7. Never persist raw capability bearers, operator tokens, or secrets in session rows, context, docs, or tests (use redacted placeholders).

## APIs

### MCP

| Tool | Auth | Notes |
|------|------|--------|
| `cairnstone_code_session_create` | membership + `write_draft` | Creates `cairnstone-code-session-v1` |
| `cairnstone_code_session_get` | membership + `ls` | Reads operational record |
| `cairnstone_code_session_pause` | membership + `write_draft` | CAS on `base_revision` → `paused` |
| `cairnstone_code_session_resume` | membership + `write_draft` | CAS → `active` from `paused`/`blocked` |
| `cairnstone_code_session_compile_context` | membership + `read` | Bounded `cairnstone-code-session-context-v1` |

Broker: mutations = `risk_class:mutation` + `scoped_grant`; reads = `scoped_grant`. None are automatic-read for `cairnstone_delegate`.

### REST (same FromBody handlers)

- `POST /v1/code-sessions`
- `POST /v1/code-sessions/get`
- `POST /v1/code-sessions/pause`
- `POST /v1/code-sessions/resume`
- `POST /v1/code-sessions/context`

## Context compile answers

A fresh authorized model session receives enough bounded state to answer:

- project/repo + Scope/chain
- immutable base commit(s)
- current shared working-tree tip vector + digest
- changes since last checkpoint pointer (digest-based, not timestamps)
- task ledger / unresolved issues
- other actors + roles
- latest test/build/execution receipt refs
- permissions (scopes/role; never raw bearer)
- next safe continuation action

`content_identity.context_digest` identifies the compiled package.

## Module map

- `migrations/0015_v777a_code_sessions.sql`
- `src/code-session.js`
- `src/index.js` (MCP + REST wiring)
- `src/model-router.js` (broker registry)
- `test/code-session.test.js`
- `docs/V7_7_7A_DURABLE_CODE_SESSION.md` (this file)

## Out of scope (later slices)

- **7.7.7b** immutable Code Checkpoint protocol + richer task ledger transitions
- **7.7.7c** task/path leases
- **7.7.7d** repo-scale tree + GitZip backing
- **7.7.7e** environment reconstruct / sandbox adapter
- **7.7.7f** Console Persistent Code Mode UX
