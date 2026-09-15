# V7.7.10c — Deterministic Intent Router

**Status:** in-repo implementation slice (worker). Operational classification only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. `accepted_state_authority: false` on every response.

**START HERE gate (10b COMPLETE):** `10d5352767645ccba760ee65579d85dbc8469bbcf4bf8e6e9bd46ee16df5ab17`  
**Amendment:** `eab0bdb8304f0d5439b659bdbedf2715fe4894a1d9958814f4db13a8de89b22f`  
**Runtime:** worker **0.5.41** (baseline tip: `1ac0f58c21b065aaf2a02a77aed495467baa030f` / **0.5.40**)

## What this plane is

A **no-LLM** deterministic router that classifies operator/chat text (plus optional structured context) into one of:

| Intent | Maps to 10b proposal tool |
|--------|---------------------------|
| `give-access` | `cairnstone_access_grant_create` |
| `revoke-access` | `cairnstone_access_grant_revoke` (+ optional `access_grant_list` read) |
| `assign` (incl. ask-to-work) | `cairnstone_task_run_propose` |
| `forward-with-note` | `cairnstone_forward_with_note` |
| `none` | no proposal |

The router returns a **proposal / read plan only**. Matching text **never** creates grants, revokes, proposes task runs, or forwards.

## Hard invariants

1. Zero LLM / provider / model calls (`llm_called: false`, `provider_called: false`).
2. Zero `chain_heads` / `path_heads` mutation.
3. `accepted_state_authority: false` always; `grants_no_capability: true`.
4. `auto_mutated: false` always; mutation intents set `requires_human_commit: true`.
5. Ambiguous / unmatched / conflicting cues → `intent: none` with diagnostics (never guess a mutation).
6. Proposal `args` match live 10b MCP schemas (`additionalProperties: false`).

## Schema

`cairnstone-intent-route-v1`

Minimum result fields:

- `intent`, `confidence` (`exact`|`high`|`low`|`none`), `matched_patterns[]`
- `requires_human_commit`, `auto_mutated`
- `proposal` `{ tool_id, args, missing_fields[] }` or `null`
- `reads[]` optional read-only tool plans
- `object_refs[]`, `principal_actor_id?`, `permission?`, `note?`
- authority closed fields as above

## Surfaces

| Surface | Auth | Behavior |
|---------|------|----------|
| MCP `cairnstone_intent_route` | scoped_grant **read** | Pure function; no D1 writes |
| `POST /v1/intent/route` | same | Same FromBody handler |

Broker risk class is **read** (non-mutating). The tool is **not** automatic-read for delegate loops.

### Input

```json
{
  "text": "Give claude:cairnstone-v6 read access to msg:v7710-smoke",
  "actor_id": "console:jared",
  "object_refs": ["msg:v7710-smoke"],
  "context": {
    "focused_object_ref": "msg:v7710-smoke",
    "conversation_id": "cvs:…",
    "known_actors": ["chatgpt:cairnstone-v6", "claude:cairnstone-v6", "grok-bot:cairnstone-v6"]
  }
}
```

`text` or structured `intent` override is required. Prefer `focused_object_ref` / `object_refs` when text omits an explicit ref.

## Deterministic matching

Ordered regex rule table (`INTENT_RULES` in `src/intent-router.js`). Rule ids are emitted in `matched_patterns[]` for audit.

| Intent | Example cues (rule families) |
|--------|------------------------------|
| give-access | `give … access`, `grant … read/discuss`, `share with`, `let X see` |
| revoke-access | `revoke access`, `remove access`, `ungrant`, `stop sharing` |
| assign | `assign to`, `ask … to work`, `have X work on`, `task … to` |
| forward-with-note | `forward with note`, `forward to … saying`, `send a note about` |

Extraction:

- **Actors:** full `name:mailbox` ids; aliases from `context.known_actors` / common display names only when unambiguous
- **Object refs:** reuse 10b `parseObjectRef` / attachment-ref normalizer
- **Permission:** default `read` for give-access unless discuss / execute-against clearly stated
- **Revoke:** prefer `grant:…` when present; else propose list read + revoke with `missing_fields: ["grant_id"]`

**Conflict:** if two mutation intents match at equal confidence → `intent: none` + `diagnostics.conflict`.

## Out of scope

- Console UX / proposal cards (10e)
- Task Run dispatch / executor selection (10d)
- Durable Objects / WebSockets (10f)
- Unrelated 10b Console hotfixes

## Module map

- `src/intent-router.js` — core `routeIntent` / `routeIntentFromBody`
- `src/index.js` — MCP + REST; VERSION `0.5.41`
- `src/model-router.js` — broker registry entry (86 → 87)
- `test/v7710c-intent-router.test.js`
- `project-memory/v7710c-intent-router-implementation-note.md`

## Smoke

```bash
curl -sS "$WORKER/health" | jq '.version'   # expect 0.5.41
curl -sS -X POST "$WORKER/v1/intent/route" \
  -H 'content-type: application/json' \
  -d '{"text":"Give claude:cairnstone-v6 read access to msg:demo","actor_id":"console:jared"}' \
  | jq '{intent, auto_mutated, proposal}'
```
