# V7.7.8d — Cross-provider + stale-state acceptance

**Status:** in-repo implementation slice (worker).  
**Builds on:** V7.7.8a/b (`docs/V7_7_8A_GROUNDED_RESPONSE_CONTRACT.md`).  
**Console Answer Depth UX:** already live-verified separately as V7.7.8c — this slice only ensures envelope / freshness fields are visible enough for that UI.  
**Never** moves `chain_heads` / `path_heads`. Every response API returns `accepted_state_authority: false`.

Canonical product contract: `docs/V7_7_8_PROGRESSIVE_GROUNDED_CHAT_LOD.md`  
Worker tip for this slice: `0.5.38`

## What 8d owns

1. **Provider/model envelope swap** while preserving `response_id`, authority snapshot, evidence-set identity, and claim/conclusion skeleton — change is visible only in the outer provider/model envelope.
2. **Accepted-state change between LOD expansions** — richer live acceptance of `stale_response` / `authority_changed` vs `view_original` vs `refresh_of` (new `response_id`).
3. **Original-snapshot vs refresh behavior** hardened and covered by acceptance tests.
4. **Multi-repo / roadmap / Code Session examples** — fixtures + smoke recipes proving single-chain, multi-chain Scope, roadmap-shaped Q&A, and optional Persistent Code Mode binding without inventing a second trust model.

## Envelope contract

Schema: `cairnstone-grounded-response-envelope-v1`

| Field | Meaning |
|---|---|
| `provider` / `model` / `transport` | Outer generation or reattribution identity |
| `role` | e.g. `skeleton_generation` |
| `identity_affecting` | Always `false` — envelope is never part of `response_id` |
| `visible` | Always `true` — Console/MCP callers can display the envelope |
| `history` / `last_swap` | Explicit reattribution trail when expand swaps provider/model |

Catalog (`GROUNDED_RESPONSE_ENVELOPE_CATALOG`):

- **Generation-capable** (create / skeleton compile): `workers_ai` + `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- **Reattribution-capable** (expand only): openai / anthropic / deepseek catalog entries

Create rejects non-generation envelope models with `model_not_generation_capable`. Expand may reattribute to any catalog entry without calling a model — LOD renderers remain pure over the stored skeleton.

Invariant:

> Provider/model may change between expansions **only if** response identity, authority snapshot, evidence identity, and claim contract remain preserved and the change is visible in the outer envelope.

## Freshness / lineage surfaces

`get` and successful `expand` include:

```json
{
  "authority_freshness": {
    "status": "current|authority_changed|error",
    "stale": false,
    "reason": null,
    "stale_reason_code": null,
    "snapshot_view": "current|stale|original|error",
    "viewed_original_snapshot": false,
    "actions": ["expand"],
    "action_hints": {}
  },
  "refresh_lineage": {
    "is_refresh": false,
    "refresh_of": null,
    "parent_response_id": null
  },
  "provider_envelope": { "schema": "cairnstone-grounded-response-envelope-v1", "visible": true, "identity_affecting": false }
}
```

When accepted heads move after create:

| Caller action | Result |
|---|---|
| `expand` (default) | `ok:false`, `error:stale_response`, `reason`/`stale_reason_code:authority_changed`, `snapshot_view:stale`, structured `actions.view_original` + `actions.refresh` |
| `expand` + `view_original:true` | Same `response_id` / digests; `snapshot_view:original` |
| create with `refresh_of=<old id>` | **New** `response_id`; `refresh_lineage.is_refresh=true`; original remains inspectable via `view_original` |

No silent auto-refresh that discards the snapshot the user was reading.

## Composition (no second trust model)

Still composes:

- `resolve_scope` / `find_scope` for Scope + evidence
- ask citation validation for claim citations
- optional `code_session_id` binding (presentation / continuity metadata only)

Ordinary Q&A does **not** require Persistent Code Mode.

## Acceptance tests

`test/grounded-response.test.js` covers:

- identity stable across expand
- envelope swap preserves digests and does not re-run the model
- stale after HEAD move → reason codes + actions
- `view_original` keeps original snapshot
- refresh mints new id + lineage fields; original remains inspectable
- single-chain + multi-chain Scope examples
- optional `code_session_id` without requiring Code Session for ordinary create
- envelope visibility on create/get/expand
- create rejects non-generation provider/model

## Smoke recipes (live-shaped)

### 1) Single-chain roadmap question

```json
POST /v1/grounded-response
{
  "question": "What is the next roadmap slice?",
  "scope": { "mode": "single_chain", "chains": ["<chain>"] }
}
```

Expect `response_lod:1`, visible `provider_envelope`, `accepted_state_authority:false`.

### 2) Multi-chain / multi-repo Scope

```json
{
  "question": "What shared behavior is current across these repos?",
  "scope": { "mode": "multi", "chains": ["<chain-a>", "<chain-b>"] }
}
```

Then expand to `response_lod:3` (evidence) without a second model call.

### 3) Envelope reattribution (cross-provider visibility)

```json
POST /v1/grounded-response/expand
{
  "response_id": "gr:…",
  "response_lod": 3,
  "provider": "openai",
  "model": "gpt-4o-mini"
}
```

Expect same `response_id` / digests, `envelope_swapped:true`, history entry from prior provider.

### 4) Stale → view_original → refresh

1. Create LOD 1.
2. Move an accepted chain HEAD.
3. Expand → `stale_response` / `authority_changed`.
4. Expand with `view_original:true` → original snapshot.
5. Create with `refresh_of` → new `response_id`; original still get/expand-able with `view_original`.

### 5) Optional Code Session binding

Pass `code_session_id` on create for Persistent Code Mode questions. Omit it for ordinary chat. Same trust model either way.

## Non-goals

- No V7.7.9 whole-Console redesign
- No replacement of Stone LOD semantics
- No requirement that ordinary chat use Persistent Code Mode
- No silent five independent model answers per question
- No second continuity/authority model beyond Scope + chain/path HEADs
