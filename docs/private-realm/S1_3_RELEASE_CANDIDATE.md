# S1-3 source release candidate — NOT DEPLOYED

This branch consolidates the current staging source stack for a single owner-facing review against `main`. It is based on `1fa2b59ef2fd6d25e21ae1f62641635f0582d210` (PR #95), with generated local Wrangler cache/SQLite state files removed. Do not promote this branch as accepted CairnStone state.

## Included source work

- Private staging Worker and durable replay, caller attestation, schema parity (PRs #81–82)
- Signed gateway and authenticated private inbox (PRs #86, #91)
- Deterministic manual staging deploy and source-only safeguards (PRs #84–85, #92)
- Stage C acceptance runner and separate signed harness with staging-only durable auth store (PRs #93, #95)

## Verifiable current state

- Upstream exact source SHA `1fa2b59ef2fd6d25e21ae1f62641635f0582d210`: six hosted source CI workflows succeeded; Stage C integration test reports 141 tests.
- The local harness tests use injected bindings/SQLite and label their evidence simulated; **live acceptance is not complete**.
- Auth D1 binding still has a placeholder and needs staged provisioning. Do not deploy an all-zero database ID.
- Live private staging Worker was last seen bound to the old staging D1. Verify again before any deployment.
- Staging gateway/harness have no approved public route by design.

## Release conditions — GitHub issue #90

1. Independent final check of THIS consolidated source SHA and workflow-dispatch safeguards. Source-only merge is allowed only after operator authorizes it and it has a full CI green result. Do not merge an insecure intermediate PR #84 alone.
2. Protect the `s1-3-staging` GitHub environment with human reviewers and restrict deployment branches to `main`. Use scoped staging-only Cloudflare credentials; never reuse production secrets.
3. Provision `cairnstone-staging-auth` D1 separately, apply migration `migrations/staging-auth/0001_staging_auth.sql`, replace placeholder DB IDs and verify live schema; stage-only secrets configured through secrets, not Git.
4. Deploy private staging Worker from the reviewed SHA against replacement private D1 `9420f645-4bdf-430f-a790-feb34d01f077`. Verify no public route, workers.dev or preview URL. Deploy restricted Stage C harness only after secrets and service-binding props are verified.
5. Dispatch manually the Stage C live test with two synthetic accounts across two provider identities. Record exact run, source SHA, redacted D1/Cloudflare evidence, cases C00–C09 and failures in a CairnStone evidence Stone.
6. Stop/rollback on auth, nonces, binding, route, RPC, or D1 mismatch. Never delete the old D1 or enable production/private tools without a separately authorized owner gate.

This candidate is a review/merge surface and does not grant deploy authorization.