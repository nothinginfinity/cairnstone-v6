# S1-3 gateway transport adapter — source-only

This candidate is deliberately dormant. It adds an internal `createStagingPrivateStoreClient` that signs every allowed S0b store call and uses only the isolated staging service binding. It also composes the already reviewed Identity-to-Home bridge and private inbox tools through `createStagingGatewayCore`.

**Not a deployed gateway.** A distinct staging Worker entrypoint, verified staging OAuth/token validation, owner-admission policy, binding props and HMAC secret provisioning, environment restrictions, owner approval, and live E2E acceptance are still required. This PR does not enable private tools or touch production OAuth, D1, R2 or runtime imports.

## Required runtime-only staging bindings

- `CAIRNSTONE_PRIVATE_STAGE`: Cloudflare Worker service binding to `cairnstone-private-staging` with `props = { caller = "cairnstone-stage-gateway" }`.
- `PRIVATE_GATEWAY_HMAC_KEY`: staging-only secret stored on the gateway **and** private staging worker, never checked into Git or sent in RPC arguments.
- `PRIVATE_STAGE_GATEWAY_ENABLED`: defaults off, explicitly `"true"` in isolated staging after review.
- `STAGING_OAUTH_RESOURCE`: isolated staging OAuth resource, must exactly match the verifier's resource.

The token verifier is a **trusted injected dependency**, not a caller-supplied callback. It must validate issuer, audience/resource, token revocation, account/tenant/connection status, and expiry independently. `createIdentityHomeBridge` still rejects client-supplied identity selectors and defaults onboarding/recovery to denial.

Before activation, execute the full Stage C test matrix in `S1_3_STAGE_C_GATE.md`. Until then, treat all source and CI as **candidate-only**.
