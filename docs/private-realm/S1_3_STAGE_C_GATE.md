# S1-3 Stage C — staging gateway and live E2E acceptance gate

Status: draft planning and workflow hardening; **NOT DEPLOYED, NOT ACCEPTED**. Scope is the isolated staging realm only.

## Source and resource pins

- Staging Worker source: reviewed S1-3 PR #82 `bec2e2e8f0287ac1ff84280344166f1f1d9b9fb0` (immutable), stacked on draft PR #81. **Superseded pin:** deploy workflows now pin merged main `ce565ef97eb7b5a6847679604e1abb42daaef700` after PR #98 (previous main pin `d2c12cbc`; bec2e2e is not an ancestor of main). See S1_3_STAGING_ACTIVATION.md.
- Private staging D1: `cairnstone-private-staging-2`, ID `9420f645-4bdf-430f-a790-feb34d01f077` (synthetic data only).
- Private staging R2: `cairnstone-private-staging` only. Preserve old staging D1 `26d4e786-2da7-47a4-a159-1ba206712b13` until E2E and owner deletion approval.
- Staging Worker: `cairnstone-private-staging`; zero production routes, custom domains, workers.dev or preview URLs.
- Deployment: separate owner-reviewed and explicitly dispatched workflow; the source SHA must match its fixed `ALLOWED_SOURCE_SHA`.

## Before any staging deployment

1. Independently review PR #82 and this hardened workflow; never treat a draft PR or green CI as permission to deploy.
2. Configure the `s1-3-staging` GitHub environment with required human reviewers, restricted deployment branches (`main` only), and a dedicated **staging-scoped** Cloudflare token. Confirm limits in Cloudflare, not solely in YAML.
3. Audit the exact selected commit for unexpected changes to Worker entrypoints, package scripts, dependencies, and wrangler config. The workflow pins a single reviewed SHA, not any user-supplied 40-hex commit.
4. Verify recreated D1 schema (role column, `priv_messages_sender_authorized`, `priv_deliveries_target_authorized`, `priv_service_nonces` with unique key). Check real live SQL and not only table count or CI SQLite parity.
5. Do not deploy or wire a gateway until its authentication verifier, service binding, HMAC key distribution, and owner-admission policy receive separate security review.

## Gateway architecture contract (source-only until approved)

- Build a **separate staging-only gateway Worker** as sole holder of `PRIVATE_GATEWAY_HMAC_KEY` and `CAIRNSTONE_PRIVATE_STAGE` service binding. No private binding in production/Core worker.
- `[[services]]` binding must set `props = { caller = "cairnstone-stage-gateway" }` (Cloudflare-supported service binding property). Private Worker must enforce exact `ctx.props.caller` **in addition** to HMAC-signed envelope caller.
- Verify token audience, issuer, expiry, tenant/account and connection identity through a separately reviewed **staging OAuth** path. Never trust a client-supplied `authContext`, `home_id`, `role`, or connection ID. No production OAuth token/client is a staging fixture.
- Derive `HomeScope` server-side from the verified stage identity and audited owner/admission policy. Default deny recovered-admin self-grants and any attempt to escalate to `admin`.
- HMAC-sign exactly `{v,caller,method,args,iat,nonce}`; use a cryptographically random nonce and never accept replay on a different isolate. Never log secrets, tokens, full messages or private identities.
- Gate activation behind explicit approval; private tool registration stays dormant until gateway E2E acceptance. No historical mailbox migration in this stage.

## Stage C live test matrix (two synthetic accounts × two providers)

| Gate | Action | Required result |
|---|---|---|
| Caller attestation | Missing, empty or wrong `ctx.props.caller` | `caller_not_authorized`; no store write |
| Signed envelope | Bad HMAC, mutated method/args/role/caller, wrong audience or expired timestamp | Denied with no sensitive error detail |
| Durable replay | Send same signed nonce through separate isolates and restart | Exactly one accepted attempt; second denied by D1 unique nonce receipt |
| D1 revocation | Revoke synthetic sender inbox grant, then attempt send | Database trigger rejects write even under race; no delivery |
| Recipient policy | Unauthorized target inbox / revoked recipient / cross-home routing | Denied; no cross-home leakage |
| Owner recovery | Attempt recovered-admin attach or privilege escalation | Denied by gateway admission policy |
| Isolation | Two synthetic accounts across two provider identities | Each can access only the explicitly granted Home/Inbox; no cross-account reads |
| Network exposure | Test routes, workers.dev, previews, cross-origin headers | No public private Worker surface; HTTP handler remains inert 404 |
| Secrets/permissions | Inspect bindings, token scope, CI environment, logs | Staging-only resources; secrets not surfaced to install/tests/logs |
| Legacy regression | Exercise legacy MCP and Core OAuth entrypoints | No new private names or access enabled; existing behavior unchanged |

Record the exact immutable source SHA, workflow run IDs, verified Cloudflare Worker binding IDs, D1 query receipts, sampled negative tests and expected/observed results as an **evidence** Stone without promoting accepted HEADs.

## Explicit stop conditions

- **DO NOT MERGE/DEPLOY** on unknown or mutable source, mismatched D1, unavailable/overbroad staging token, missing environment protection, public route exposure, missing gateway verifier, wrong caller props, absent HMAC key, failed replay/revocation test, or unexpected production binding.
- PR #84 is not suitable for dispatch until the security hardening here is reviewed and the owner explicitly approves its merge and manual run. A successful staging deploy alone is not Stage C acceptance.
- Old staging D1 cleanup, production enablement, accepted-state promotion, and real-user onboarding require separate owner approvals.
