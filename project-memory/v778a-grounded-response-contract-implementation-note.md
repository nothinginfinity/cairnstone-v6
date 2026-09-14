# V7.7.8a/b implementation note — Progressive Grounded Chat LOD

Adds `cairnstone-grounded-response-v1` with deterministic `response_id`,
Scope/authority/evidence/skeleton binding, stale-authority detection, and
lazy `response_lod` 1→5 expansion. `response_lod` is distinct from `stone_lod`.
Composes existing Scope/find/ask citation primitives. Never moves chain/path
HEADs. `accepted_state_authority` always false.

Surfaces: `POST /v1/grounded-response{,/get,/expand}` and MCP
`cairnstone_grounded_response{,_get,_expand}`.

D1: `migrations/0020_v778a_grounded_responses.sql`
Docs: `docs/V7_7_8A_GROUNDED_RESPONSE_CONTRACT.md`
Worker version tip for this slice: `0.5.37`

Deferred: V7.7.8c Console Answer Depth UX; V7.7.8d cross-provider acceptance.
