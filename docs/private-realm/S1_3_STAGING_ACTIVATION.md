# S1-3 staging activation runbook (issue #97)

STAGING ONLY. Every step below is a manually dispatched workflow in protected environment `s1-3-staging`
(required reviewer `nothinginfinity`, deployment branch `main` only). Nothing auto-deploys; no workflow touches
production, routes, workers.dev, the old staging D1 or secret values. The preparation PR #98 was merged source-only; this SHA-repin PR changes none of it.

## New workflows (all: workflow_dispatch only, main only, `source_sha == github.sha`, step-scoped Cloudflare credentials, serialized group `s1-3-staging-activation`)
| Workflow | Confirm phrase | Effect |
|---|---|---|
| `s1-3-staging-activation-plan` | `RUN_S1_3_STAGING_ACTIVATION_PLAN_READ_ONLY` | Read-only go/no-go board from live state (secret NAMES only). |
| `s1-3-staging-auth-d1` | `CREATE_ISOLATED_S1_3_STAGING_AUTH_D1` | Creates ONLY `cairnstone-staging-auth` (refuses if it exists), applies ONLY reviewed migration `0001` (sha256 pinned), verifies schema/empty. |
| `s1-3-staging-harness-deploy` | `DEPLOY_ISOLATED_S1_3_STAGE_HARNESS` | Deploys ONLY `cairnstone-stage-harness`. `phase=dormant` (default, 404 everywhere) or `phase=enable` (needs `ENABLE_S1_3_STAGEC_HARNESS_FOR_OWNER_RUN`). |

Existing `s1-3-staging-deploy-v2` and `s1-3-stagec-e2e` keep fixed source-SHA pins; this reviewed repin selects PR #98's merged `main` commit `ce565ef97eb7b5a6847679604e1abb42daaef700` (same Git tree as the independently reviewed PR head `c85f6532d0dfb49dd75b622c96bc328c21da9599`). The workflow's `github.sha` is the trusted workflow revision and intentionally differs from the deployable source SHA.

## Ordered launch checklist (operator approvals)
1. PR #98 is merged; independently review and merge the separate, source-only SHA repin PR. Verify the exact pinned source tree and green source checks before any workflow dispatch. If `main` moves after review, recheck source equivalence and repin through another reviewed PR rather than improvising a SHA.
2. Dispatch `activation-plan`; approve the environment gate; read the board.
3. Dispatch `s1-3-staging-deploy-v2` to rebind `cairnstone-private-staging` to the replacement D1 (approval).
4. Dispatch `s1-3-staging-auth-d1` (approval). Note the created D1 id from the verified summary.
5. Reviewed PR: set `ACTIVATION.auth.dbId` in the activation lib and the same id in `wrangler.stagec-harness.toml`; set a real issuer host (and `STAGING_OAUTH_RESOURCE = <issuer>/mcp/core-auth`). The all-zero placeholder is rejected everywhere.
6. Dispatch `harness-deploy phase=dormant` (approval).
7. Owner provisions (outside CI, values never printed): secrets `STAGE_C_HARNESS_TOKEN` (>=32 chars), `PRIVATE_GATEWAY_HMAC_KEY`, `STAGING_OAUTH_SIGNING_KEY` on `cairnstone-stage-harness`; Access-protected custom hostname equal to the issuer host, whose policy is Service Auth for ONE specific service token pinned in `ACTIVATION.access.serviceTokenId` (issue #101).
8. Dispatch `harness-deploy phase=enable` with the owner phrase (approval).
9. Set Stage C environment secrets `STAGE_C_HARNESS_URL`, `STAGE_C_HARNESS_TOKEN`, `STAGE_C_ACCESS_CLIENT_ID`, `STAGE_C_ACCESS_CLIENT_SECRET`; dispatch `s1-3-stagec-e2e` (approval).
10. Record an evidence stone. Disable with `phase=dormant`, then detach the custom domain, then `phase=dormant` again (see the owner runbook step 10; `harness-rollback-plan` is the read-only checker).

## Rollback
Redeploy `harness-deploy phase=dormant` (harness returns 404 everywhere, even while the Access-protected domain is still attached); detach the domain afterwards. The file never enables the harness; enable is a deploy-time `--var` only.

## Stop gates (need distinct human authorization under #90)
Merging, promoting CairnStone HEAD, deleting the old staging D1, production changes, route/domain changes.

## Known caveats
- Access-app API response shape is unverified live; the enable-phase check is fail-closed.
- The staging gateway Worker is intentionally not automated (config still placeholder); readback treats it as optional.
- C08 legacy MCP URLs (`LEGACY_MCP_HEALTH_URL`/`LEGACY_MCP_TOOLS_URL`) cannot be set via the exact-line config: owner decision.
