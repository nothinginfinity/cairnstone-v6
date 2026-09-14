# V7.7.8d implementation note — Cross-provider + stale-state acceptance

Extends `cairnstone-grounded-response-v1` with a visible, non-identity-affecting
provider/model envelope catalog, explicit expand-time envelope reattribution,
and richer stale/view_original/refresh lineage surfaces. Expansion still uses
pure LOD renderers over one skeleton. Never moves chain/path HEADs.
`accepted_state_authority` always false.

Surfaces unchanged: `POST /v1/grounded-response{,/get,/expand}` and MCP
`cairnstone_grounded_response{,_get,_expand}` (enriched fields only).

Docs: `docs/V7_7_8D_CROSS_PROVIDER_STALE_ACCEPTANCE.md`
Worker version tip for this slice: `0.5.38`
