# S1-3 staging gateway Worker — source-only candidate (updated)

Separate `cairnstone-stage-gateway` Worker. Service binding to `cairnstone-private-staging` with `props = { caller = "cairnstone-stage-gateway" }`.

## Route contract
POST `/v1/private-inbox/{get,list,read,send,ack}` maps internally to `private_inbox_*` tools. All other paths return 404. No onboard or inspect exposed.

## Fail-closed defaults
- `PRIVATE_STAGE_GATEWAY_ENABLED` must be explicitly `"true"` after owner review.
- Staging OAuth verifier requires `STAGING_OAUTH_SIGNING_KEY` (secret), exact issuer/resource match, expiry, active statuses, explicit `mcp:core` scope (no fallback), and durable revocation/connection store checks.
- Owner admission and admin recovery remain default deny.
- Remote errors normalized to stable codes only.

## Durable staging authority
Revocation and connection status are checked via an injected store interface (`isRevoked`, `connectionActive`). Live deployment must bind a staging-only D1 or equivalent trusted authority. Production OAuth is never reused.

## Proposed staging-only access (owner-gated, not activated)
- Hostname: `stage-gateway.cairnstone.example` (or equivalent protected custom domain).
- Route: only the `/v1/private-inbox/*` paths above, behind GitHub environment protection and staging-scoped token.
- `workers_dev = false`, `preview_urls = false` remain enforced.
- Activation requires separate review under issue #90.

## Deployment dependencies (not performed here)
- Protected `s1-3-staging` GitHub environment.
- HMAC key on both gateway and private staging Worker.
- Staging D1 bound and schema verified.
- Explicit owner approval for any wrangler deploy or route attachment.

Dry-run: `npx wrangler deploy --dry-run --config wrangler.staging-gateway.toml`

Coordinate interface with issue #89. No secrets in Git. No accepted-state promotion.
