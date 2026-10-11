# S1-3 staging gateway Worker — source-only candidate

Separate `cairnstone-stage-gateway` Worker. Service binding to `cairnstone-private-staging` with `props = { caller = "cairnstone-stage-gateway" }`.

## Fail-closed defaults
- `PRIVATE_STAGE_GATEWAY_ENABLED` must be explicitly `"true"` after owner review.
- Staging OAuth verifier requires `STAGING_OAUTH_SIGNING_KEY` (secret), exact issuer/resource match, expiry, active statuses, and optional revocation list.
- Owner admission and admin recovery remain default deny (inherited from bridge).
- HTTP surface limited to `/v1/private-inbox/{private_inbox_get|list|read|send|ack}`. No onboard, inspect, or private Worker routes.
- Remote errors normalized to stable codes only.

## Deployment dependencies (not performed here)
- Protected `s1-3-staging` GitHub environment with staging-scoped token.
- HMAC key present on both gateway and private staging Worker.
- New staging D1 bound (currently unbound per live check).
- Explicit owner approval for any wrangler deploy.

Dry-run: `npx wrangler deploy --dry-run --config wrangler.staging-gateway.toml`

Coordinate with issue #89 for interface consumption. No prod OAuth reuse.
