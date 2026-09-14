# V7.7.8a/b — Grounded Response Contract + Lazy LOD Expansion

**Status:** in-repo implementation slice (V7.7.8a + coherent V7.7.8b).  
**Does not** implement Console Answer Depth UX (V7.7.8c; shipped separately) or claim V7.7.8d — see `docs/V7_7_8D_CROSS_PROVIDER_STALE_ACCEPTANCE.md` for cross-provider stale acceptance.  
**Never** moves `chain_heads` / `path_heads`. Every response API returns `accepted_state_authority: false`.

Canonical product contract: `docs/V7_7_8_PROGRESSIVE_GROUNDED_CHAT_LOD.md`  
Planning stone: `a32642717189ba783e8ebc34163ff7ec45e91b55518f753d63b7dbd20db69cbe`  
Activation gate stone: `8b1e10ea69792aa9b3767fdfaf9e1b35beaa4744f0a0dce6b923e8ad64f7e718` (V7.7.7f COMPLETE / LIVE-VERIFIED)

## Naming separation (non-negotiable)

| Concept | Direction | Meaning |
|---|---|---|
| `stone_lod` | lod5 → lod1 | Storage retrieval: cheap summary → deep/raw. **Unchanged.** |
| `response_lod` | 1 → 5 | Human answer depth: concise → deep. **New typed concept.** |

Do not overload Stone LOD fields with chat Answer Depth.

## Schema: `cairnstone-grounded-response-v1`

One grounded answer object bound to:

- `response_id` — deterministic from question + `scope_id` + `authority_digest` + evidence-set digest + claim-skeleton digest (refresh adds an explicit nonce → new id)
- exact Scope selectors / `scope_id`
- exact accepted `authority_digest` + participating chain HEAD snapshot
- evidence-set identity
- answer-skeleton identity (conclusion / claims / uncertainty / next_action / caveats)
- highest materialized `response_lod`
- provider/model envelope
- explicit zero accepted-state mutation authority

## Surfaces

REST:

- `POST /v1/grounded-response` — create (default `response_lod: 1`)
- `POST /v1/grounded-response/get` — load + authority freshness
- `POST /v1/grounded-response/expand` — lazy deeper `response_lod`

MCP / broker (read + automatic):

- `cairnstone_grounded_response`
- `cairnstone_grounded_response_get`
- `cairnstone_grounded_response_expand`

D1: `migrations/0020_v778a_grounded_responses.sql` (operational identity/cache only; not accepted project truth).

## Composition

Creates evidence via existing `resolve_scope` + `find_scope` + chain-HEAD orientation (same family as `cairnstone_ask_scope`). Citations are validated with the ask citation helpers. No second continuity/trust model.

## Lazy LOD (7.8b)

1. Resolve authority + evidence once.
2. Compile one answer skeleton (single bounded model call).
3. Materialize `response_lod` 1 by default.
4. Expand 2–5 by **pure renderers** over the same skeleton/evidence — no unconstrained “answer again, but longer.”
5. Cache materialized levels on the same `response_id`.

LOD meanings:

1. Answer (1–3 short sentences + next action)
2. Context
3. Evidence (+ citations)
4. Analysis
5. Deep trace (bounded; not a vault dump)

## Stale / refresh semantics

Expansion is snapshot-bound.

If accepted authority changes after create:

- default expand → `stale_response` / `authority_changed`
- `view_original: true` → expand the stored snapshot
- refresh → `cairnstone_grounded_response` with `refresh_of=<old response_id>` → **new** `response_id`

No auto-refresh that silently discards the snapshot the user was reading.

## Deferred / follow-on

- **V7.7.8c** — Console Answer Depth UX / natural-language “LOD 3 that” (live-verified in console repo; not this worker slice)
- **V7.7.8d** — cross-provider envelope swap + richer stale/view_original/refresh acceptance → `docs/V7_7_8D_CROSS_PROVIDER_STALE_ACCEPTANCE.md`
