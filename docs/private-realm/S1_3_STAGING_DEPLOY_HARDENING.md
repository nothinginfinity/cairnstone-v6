# S1-3 staging deploy hardening (issue #87)

Status: **source-only, NOT DEPLOYED, NOT ACCEPTED.** Stacked on PR #85. Staging only; no production resource is referenced.
Nothing in this change dispatches a workflow, touches Cloudflare, or moves an accepted CairnStone HEAD.

## What the workflow now guarantees

| Control | Mechanism | Where it is tested |
|---|---|---|
| Only the reviewed source deploys | `ALLOWED_SOURCE_SHA` (PR #82 head `bec2e2e8f0287ac1ff84280344166f1f1d9b9fb0`) is compared before any checkout | `s1-3-staging-workflow-invariants.test.js` |
| Deterministic dependencies | Committed `deploy/s1-3-staging/package-lock.json` (sha256 pinned in the workflow as `LOCKFILE_SHA256`) installed with `npm ci --ignore-scripts`; `package.json` of the source is pinned by `PACKAGE_JSON_SHA256`; wrangler runs via `npx --no-install` | invariants test (hash must equal the committed file) |
| Tooling is not taken from the code being deployed | Two checkouts: `trusted/` = this workflow's commit (main), `source/` = the pinned SHA | invariants test |
| Exact config identity | `verify-config` requires `wrangler.private-staging.toml` to equal the reviewed non-comment lines exactly. `[build]`, `[[services]]`, KV/DO bindings, routes, triggers, extra vars, any other D1/R2 ID, trailing-comment smuggling all fail | `s1-3-staging-preflight.test.js` (16 mutation cases) |
| Real D1 schema, not a count | Read-only queries verify the `role` column (TEXT NOT NULL DEFAULT 'member' + CHECK), composite `PRIMARY KEY (caller, nonce)` on `priv_service_nonces` in that order, and both authorization triggers by name, event, abort message and guard clauses | preflight test runs the verifier against a real SQLite engine, plus the real migrations when present |
| HMAC key present before deploy | Preflight fails if `PRIVATE_GATEWAY_HMAC_KEY` is not a secret on the staging Worker; the value is never read | preflight test |
| Bindings are exactly the reviewed set | 1 D1 (`9420f645…`), 1 R2 (`cairnstone-private-staging`), the 3 reviewed vars, and only the HMAC secret(s). Any service/KV/DO/other binding fails | preflight test |
| No public surface, verified not assumed | workers.dev, previews, **custom domains** and **zone routes** (all zones enumerated) must show no exposure. **If the API cannot answer (e.g. token scope), the run fails closed.** | preflight test (403 on routes/zones/domains/secrets each throw) |
| Token only where needed | `CLOUDFLARE_API_TOKEN/ACCOUNT_ID` appear only on the preflight, deploy and readback steps, never on checkout, install, config verification, tests or the dry-run, and never at job level | invariants test |
| No floating deploy | `--keep-vars` is forbidden so dashboard-set vars are removed on deploy; deploy is tagged `s1-3-<sha12>` with run id in the message | invariants test |
| Receipts | `preflight` and `readback` JSON receipts (source SHA, lockfile hash, run id, per-check results; no secrets) are uploaded as an artifact | preflight test (CLI writes failing receipts too) |

Every verifier fails closed: unreadable, missing or unexpected data is a failure, never a pass.

## Prerequisites the owner must satisfy (not done by this workflow)

1. **Provision the HMAC key first.** The workflow never sets secrets. `PRIVATE_GATEWAY_HMAC_KEY` must already exist on the `cairnstone-private-staging` Worker (set with `wrangler secret put` as a separate owner-run, recorded step). On a never-deployed Worker, the preflight will fail closed at `hmac_key_presence`. That is intentional.
2. **Environment `s1-3-staging`**: required human reviewers; deployment branches restricted to `main`. These are GitHub settings and are *not* enforced by YAML. Verify them in GitHub.
3. **Staging-scoped Cloudflare token.** The preflight needs read access to Worker settings/secrets/subdomain and domains for the staging Worker, D1 query access to the staging database, and Zone Read + Workers Routes Read to enumerate routes. Deploy needs Workers Scripts Edit. Confirm the exact bounds in Cloudflare; the code only ever issues `SELECT`/`PRAGMA` statements (enforced in `createCloudflareClient().d1`). Whether the D1 query endpoint accepts a narrower read-only scope than the one you grant is unverified here.

## Changing a pin (separately reviewed PR only)

- New source: update `ALLOWED_SOURCE_SHA` after the revised immutable source has passed CI.
- Lockfile: regenerate from that source's `package.json` only:
  `git show <sha>:package.json > package.json && npm install --package-lock-only --ignore-scripts`, commit the result as `deploy/s1-3-staging/package-lock.json`, then update `LOCKFILE_SHA256` and `PACKAGE_JSON_SHA256`. The invariants test fails if the hash and the file disagree.
- Provenance of the current lockfile: generated from `package.json` at `bec2e2e` (sha256 `29c0ce5c…`), 96 packages, all `resolved`+`integrity`, npm 10.9.4, lockfileVersion 3; regenerating twice produced identical bytes; `npm ci --ignore-scripts` plus the staging gates passed against the pinned source.

## Rollback and stop plan (owner-run; the workflow never rolls back automatically)

- **Preflight or config failure:** nothing was deployed; nothing to roll back. Fix the cause and re-dispatch.
- **Deploy succeeded but readback failed:** treat staging as untrusted. Roll the staging Worker back to its previous version with `wrangler rollback --name cairnstone-private-staging` (needs a prior version), or, for a first deploy, delete the staging Worker (`wrangler delete --name cairnstone-private-staging`). Neither action touches D1 or R2.
- **Data:** the staging D1 holds synthetic data only. The old staging D1 (`26d4e786-…`) is retained until Stage C passes and the owner approves deletion. Production is never referenced by this workflow.
- **Secret exposure suspected:** rotate `PRIVATE_GATEWAY_HMAC_KEY` under a recorded owner gate (the previous-key slot allows a rolling rotation).
