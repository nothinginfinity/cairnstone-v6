# S1-3 Stage C owner runbook (one page, STAGING ONLY)

Source-only document. Executes nothing. Every dispatch is manual, from `main`, in protected environment `s1-3-staging` (reviewer approves each run).
Never printed or committed: tokens, secret values, real hostnames beyond the owner's own issuer host.

**SHAs.** `deploy-v2` and `stagec-e2e` take `source_sha = ce565ef97eb7b5a6847679604e1abb42daaef700` (fixed reviewed pin; do not repin).
`activation-plan`, `auth-d1` and `harness-deploy` take `source_sha = current main HEAD` (they run from it). Before the first dispatch and after every merge, run
`git diff --stat ce565ef <main> -- src wrangler.private-staging.toml migrations scripts/staging deploy package.json`: only the owner pin PR's `scripts/staging/s1-3-activation-lib.mjs` and `wrangler.stagec-harness.toml` may differ. Anything else: STOP, re-review.

| # | Action | Confirm phrase / input | Expected receipt (artifact) | Stop if |
|---|---|---|---|---|
| 0 | Review and merge the test-resilience PR so the pin PR can pass CI | human merge | `npm run check` green (1286 pass, 0 fail) | red CI |
| 1 | `s1-3-staging-activation-plan` | `RUN_S1_3_STAGING_ACTIVATION_PLAN_READ_ONLY` | `s1-3-activation-plan.json`; private Worker still on OLD D1 = OWNER ACTION; auth D1 = OWNER ACTION (absent) | any NO-GO row |
| 2 | `s1-3-staging-deploy-v2` (rebind private Worker to replacement D1) | `DEPLOY_ISOLATED_S1_3_STAGE_V2` | preflight + readback receipts `ok:true` | preflight fails; bound D1 not `9420f645…` replacement |
| 3 | `activation-plan` again | as step 1 | `private_worker_bound_d1` = GO | any NO-GO |
| 4 | `s1-3-staging-auth-d1` (leave `existing_db_id` empty) | `CREATE_ISOLATED_S1_3_STAGING_AUTH_D1` | summary prints `database_id`; `s1-3-auth-d1-receipt.json` `ok:true`, empty tables; migration sha256 `775d2ae2…fb51` | name already exists (resume with `existing_db_id`); any verify fail |
| 5 | Owner decisions, then ONE reviewed pin PR: choose the issuer host and the Access method for the runner (see D1); set `ACTIVATION.auth.dbId` and `database_id` in `wrangler.stagec-harness.toml` to the id from step 4; set `STAGING_OAUTH_ISSUER` (bare https origin) and `STAGING_OAUTH_RESOURCE` (= issuer + `/mcp/core-auth`) | human review + merge | CI green; `node scripts/staging/s1-3-activation.mjs verify-harness-config wrangler.stagec-harness.toml --mode enable` prints PASS | all-zero id, example host, id differs from live |
| 6 | `s1-3-staging-harness-deploy` `phase=dormant` | `DEPLOY_ISOLATED_S1_3_STAGE_HARNESS` | preflight + readback `ok:true`; harness returns 404 | any failed check |
| 7 | Owner, outside CI, values never shown: (a) create the Access app for the issuer host FIRST, then attach it as the harness custom domain (no routes, no workers.dev); (b) `wrangler secret put` on `cairnstone-stage-harness`: `STAGE_C_HARNESS_TOKEN` (>=32 chars), `PRIVATE_GATEWAY_HMAC_KEY`, `STAGING_OAUTH_SIGNING_KEY`; (c) environment secrets `STAGE_C_HARNESS_URL` (`https://<issuer host>`) and `STAGE_C_HARNESS_TOKEN` (same value) | none | `activation-plan` shows secrets GO and `harness_restricted_hostname` GO | an extra route/domain/secret name appears |
| 8 | `harness-deploy` `phase=enable` | `DEPLOY_ISOLATED_S1_3_STAGE_HARNESS` + `enable_confirm=ENABLE_S1_3_STAGEC_HARNESS_FOR_OWNER_RUN` | preflight (all 3 secrets, exactly one domain == issuer host, Access verified) and readback `ok:true` | any failed preflight (nothing is deployed) |
| 9 | `s1-3-stagec-e2e` (leave cleanup inputs empty; optional var `STAGE_C_GATEWAY_WORKER`) | `RUN_S1_3_STAGEC_E2E_STAGING_ONLY` | `s1-3-stagec-evidence.json`: `ok:true`, C00-C09 PASS, `evidence_sha256`, `mode` live | any case FAIL or `aborted` |
| 10 | Record an evidence Stone (owner review; CI is not acceptance). Then roll back: detach the harness custom domain, then `harness-deploy` `phase=dormant` | as step 6 | readback `ok:true`, 404 everywhere | readback fails |

## Known issues the owner must decide (found by source-only review; nothing live was touched)
- **D1: runner cannot pass Access.** `s1-3-stagec-lib.mjs` `createHttpHarness` sends only the bearer token with `redirect: "error"`, and `verifyAccessApp` rejects any policy with decision `non_identity` (how Cloudflare Access expresses Service Auth, per its API as understood here; unverified live). As written, a GitHub-hosted runner cannot reach an Access-protected harness, so step 9 will fail at C00. Options: (a) add optional `CF-Access-Client-Id/Secret` headers to the driver and allow `non_identity` only when every include is one specific `service_token` (never `any_valid_service_token`, never bypass); or (b) another owner-approved reachability design. Not changed here because it alters a security verifier.
- **D2: dormant rollback is blocked while the hostname is attached.** `harness_no_public_exposure` runs in dormant preflight, before any deploy, and fails if a custom domain exists. Detach the domain first (step 10), or the rollback run stops at preflight and the harness stays enabled.
- **D3: issuer host is needed before step 5.** Pin it in the same PR as the D1 id, or dormant deploys with the example host and a second PR pins it before step 8.

## Rollback and stop gates
Fastest disable: delete or detach the harness custom domain, or delete the Worker; then redeploy `phase=dormant`. Distinct human authorization is still required (issue #90) for merging, promoting CairnStone accepted HEAD, deleting the old staging D1, production changes, and route/domain changes outside this runbook.
