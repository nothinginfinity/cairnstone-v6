# S1-3 — isolated private-realm staging (SOURCE-ONLY BUILD)

## Authority and scope
Owner authorized staging build and isolated staging deployment with synthetic accounts only (2026-10-11). This commit implements **Stage A only**. It does NOT provision resources, deploy, enable production routes, change OAuth enforcement, or promote any CairnStone accepted HEAD. Base: main 076d5920b184f92e2c6cdd68a9eb3e8e23179745 (PR #80).

## Isolation invariants
- New Worker `cairnstone-private-staging` only; dedicated new `cairnstone-private-staging` D1 and R2 resources (never bind production CAIRNSTONE_DB, CAIRNSTONE_AUTH_DB, CAIRNSTONE_RAW).
- Internal `WorkerEntrypoint.call` for private RPC; HTTP `fetch()` unconditionally returns an empty **404** (Cloudflare requires a registered handler, error 10068). `workers_dev=false`, `preview_urls=false`, no routes or domain.
- A *dedicated cross-Worker service binding* constrains RPC reachability. Cloudflare cross-Worker RPC does NOT provide `ctx.props` (available for same-Worker `ctx.exports` loopback only). Exact `PRIVATE_STAGE_CALLER` is bound cryptographically in the HMAC envelope and rechecked after verification. Never trust a caller-supplied HomeScope without gateway-verified authContext.
- `priv_service_nonces` unique D1 key commits before any store method. Per-isolate in-memory nonce cache alone is insufficient. Duplicate or uncertain write denies. Staging auth caller and key never copied from production.
- The private D1 migration is a copy of `docs/private-realm/schema.sql.draft` plus replay registry, not part of production migrations. If schema diverges from D1 store implementation, staging acceptance must fail rather than silently adapt.
- Only synthetic fixtures; no actual users, historical mail, production OAuth clients or message bodies.
- F1 recovery-admin self-grant remains DENIED. F4 private-home OAuth scope and F5 derivation-key registry remain unresolved.
- Existing `src/index.js`, `src/worker.js`, `src/core-auth.js`, `wrangler.toml` are unchanged; legacy /mcp and /mcp/core keep their existing behavior.

## Stage B — separately record/verify provisioning and staging deployment
1. Create new staging D1 named `cairnstone-private-staging`, new staging R2 bucket named `cairnstone-private-staging`. Verify new resource UUIDs are NOT production UUIDs; retain Cloudflare create receipts.
2. Copy `wrangler.private-staging.toml.example` to `wrangler.private-staging.toml`, replace the placeholder with the newly created staging D1 UUID. Do NOT add production bindings.
3. Apply `migrations/private-staging/0001_private_realm.sql` against the new staging D1 ONLY; verify tables `priv_homes`, `priv_inboxes`, `priv_service_nonces` and constraints on Cloudflare D1. Stop on any mismatch.
4. Inject two new, random >=32-character HMAC secrets into the isolated staging gateway and staging private Worker via Cloudflare secret bindings. NEVER commit secret values; do not repurpose production secrets.
5. Implement and independently review an isolated staging gateway that validates staging-only OAuth audience/token and creates HMAC envelopes from verified authContext. The gateway alone holds the service binding and shared HMAC secret; do not rely on unavailable cross-Worker `ctx.props`.
6. Deploy only `cairnstone-private-staging` at reviewed immutable commit. Verify no public routes/worker subdomain and verify binding names and IDs via live readback. This repo contains no auto-deploy workflow.
7. Log deployment ID, isolated D1/R2 IDs (not secrets), exact commit SHA, observed Worker version, and rollback command. Do not mark live accepted without Stage C.

## Stage C — live acceptance gates (blocked until full staging gateway)
Two synthetic accounts, two provider connections each; token audience / refresh / revoke / explicit first-connect admission; Home vs connection-private inboxes; send/list/read/ack; idempotency; deny cross-tenant, sibling-private and legacy profile; mutation + audit atomicity; durable nonce across independent isolates; negative R2 write and recovery; admin self-grant denial; CORS and OAuth discovery isolation. Fail closed on any missing case.

## Rollback / stop conditions
Disable staging gateway service binding and staged routes first. Disable `PRIVATE_STAGE_ENABLED`, revoke all staging token credentials and HMAC secrets, then undeploy *only* the named isolated staging Worker after receipt. Keep staging D1/R2 for forensic inspection until owner separately authorizes deletion. Never touch production resources or accepted path/chain heads.

Stage D production activation, migration, grant-recovery policy, key rotations and accepted-state promotion require NEW owner authorization.

## Stage B live infrastructure receipts (2026-10-11)
- New Cloudflare D1 `cairnstone-private-staging` UUID `26d4e786-2da7-47a4-a159-1ba206712b13`, independently verified, no shared or auth D1 binding.
- New Cloudflare R2 bucket `cairnstone-private-staging`, independently verified, no production bucket access.
- Staging migration applied to only the new D1. Live sqlite_master verified priv_homes, priv_inboxes, priv_audit, priv_service_nonces and immutable message/delivery triggers.
- Live D1 nonce insertion test: first insert changes=1; replay changes=0.
- Attempt 1 deploy GitHub Actions run 38175523785: tests 1085/1085 and dry-run succeeded; Cloudflare upload rejected 10068 (no registered event handlers). The safe 404 handler is the corrective change. This is NOT a successful deployment receipt.
- Stage HMAC Worker secret, staged gateway binding and real 2-account end-to-end tests are still separate Stage C gates.
