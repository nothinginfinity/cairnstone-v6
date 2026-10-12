# S1-3 Stage C live E2E workflow (issue #89)

Status: **source-only. NOT RUN, NOT ACCEPTED.** Nothing here deploys, merges, promotes an accepted HEAD, or touches production.
Stacked on #87 (PR #92) -> PR #85. Companion to `S1_3_STAGE_C_GATE.md` (the matrix) and `S1_3_STAGING_DEPLOY_HARDENING.md` (the deploy).

**Green CI on this PR is not live acceptance.** CI proves the driver, the evidence handling and the real staging schema/triggers on SQLite.
Acceptance is the evidence of a manually dispatched `s1-3-stagec-e2e` run against the deployed staging Worker and gateway harness, reviewed by the owner.

## What runs, and in what order

`s1-3-stagec-e2e.yml` (dispatch only, `main` only, environment `s1-3-staging`, serialized):

1. Validate inputs: confirmation phrase, 40-hex `source_sha` equal to the pinned reviewed SHA.
2. Check out trusted tooling (this commit) and the pinned source separately; verify HEAD.
3. **Credential-less gate**: the full driver suite against the pinned source (real `handleStagingPrivateCall`, real staging migrations, real SQLite triggers).
4. **One live step holds the secrets** (`s1-3-stagec.mjs run`):
   a. Live D1 schema verification (#87 verifier). **If it fails, no harness call is made.** The revoked-grant case sends two `INSERT`s that the triggers must reject, so it must never run on an unprotected database.
   b. The case matrix through the harness, with D1 count snapshots before/after each case.
   c. Live Cloudflare readback (C09).
5. Summary and a redacted evidence artifact (always uploaded).

## Cases (issue #89 requirement -> case)

| Case | Covers | Fails if |
|---|---|---|
| C00 | 2 synthetic accounts x 2 providers (chatgpt admin, grok member), main+aux inboxes | roles/fixtures not as expected |
| C01 | get/list/send/read/ack per provider; grok denied on aux; cross-home read/list/ack/send denied; no cross-account delivery in D1; denied calls write nothing | any positive denied, any negative allowed or a typed-code mismatch, any D1 write from a denial |
| C02 | Revoke grok's grant, then: store denies; **direct `INSERT` into `priv_messages` aborts with `sender_not_authorized`; direct `INSERT` into `priv_deliveries` aborts with `delivery_not_authorized`**; no message/delivery created; other account unaffected | a trigger does not abort (the row it committed is named in the evidence as `stray`) |
| C03 | Same signed envelope through two distinct isolates: exactly one accepted, second `caller_not_authorized`, exactly one `priv_service_nonces` row | isolates not distinct, second accepted, row count != 1 |
| C04 | Missing / wrong `ctx.props.caller` through real service bindings: `caller_not_authorized`, no write, **no nonce consumed** | any other outcome |
| C05 | bad signature, stale and future `iat`, mutated method, mutated args, wrong caller name: identical `caller_not_authorized`, nothing written | any other outcome, any leak of extra fields |
| C06 | wrong audience, revoked OAuth, caller-selector/`home_id`/role injection, recovery-admin self-escalation: all fail closed, role stays `member` | any success, any role change, any write |
| C07 | **Typed denials survive the RPC boundary** (review item 2: `instanceof PrivateRealmError` across a real binding) | any denial arrives as `private_store_error` |
| C08 | Legacy MCP/Core OAuth healthy, no private tool names visible | unhealthy or private tools visible |
| C09 | Live Cloudflare readback: exact D1/R2/bindings/secrets-present, deployment tagged `s1-3-<sha12>`, no workers.dev/preview/routes/domains, workers.dev URL does not answer, gateway has exactly one binding to the private Worker | any drift or any exposure; **if the API cannot answer, fail** |

Every denial must be exactly `{ok:false, code}` (no extra fields) and, where the contract says so, exactly `caller_not_authorized`.

## Harness contract (gateway interface for Grok / PR #86)

The driver holds no HMAC key and no user token. A staging-only harness (gateway Worker) does, and exposes two HTTPS endpoints behind a bearer secret:

```
POST {STAGE_C_HARNESS_URL}/stagec/v1/call   {identity:{account,provider}, method, args:[...args AFTER the HomeScope]}
POST {STAGE_C_HARNESS_URL}/stagec/v1/probe  {name, params}
-> {ok:true, result} | {ok:false, code}            (+ isolate id on call/probe; probes below add fields)
```

- `identity` is `{account: "alpha"|"bravo", provider: "chatgpt"|"grok"}`. The harness builds the HomeScope server-side; synthetic ids: `acct_stagec_<account>`, `ten_stagec_<account>`, `prin_stagec_<account>_<provider>`, `conn_stagec_<account>_<provider>`. The caller never supplies a scope, home, role or key.
- Probes (`ALL_PROBES` in `s1-3-stagec-lib.mjs`): `bad_sig, stale_iat, future_iat, mutated_method, mutated_args, wrong_caller_name` (envelope tampering, **must reach the real private Worker**), `missing_platform_caller, wrong_platform_caller` (a second service binding with no/other `props.caller`), `wrong_audience_token, revoked_oauth, caller_selector_injection` (gateway verifier), `replay_same_nonce` (returns `{first, second, isolates:[a,b], nonce}`; the harness must make the two calls land on distinct isolates), `legacy_regression` (returns `{ok, health, private_tools_visible}`).
- **A result with `stub:true` fails a live run.** Only the CI in-process stand-in sets it.
- The harness endpoint must not be the private Worker and must not be reachable without the bearer secret. The private Worker keeps zero public surface; the harness is the only entry.

### Finding to resolve with the gateway owner (affects C01/C07)

`createStagingPrivateStoreClient` in PR #86 maps every private-Worker error outside `{caller_not_authorized, scope_not_authorized, invalid_arguments, private_store_error, private_worker_unconfigured}` to `private_store_error`. `capability_denied` is not in that set, so a capability denial reaching the gateway through that client is indistinguishable from an outage. This is a defensible product choice (the store notes say the gateway should collapse to one 403), but then the harness must observe the **private Worker's** code (call the service binding directly) or the gateway must add `capability_denied`. C07 deliberately fails on `private_store_error`, and a mutation test (`collapseCodes`) proves it does.

## What CI proves vs. what only a live run proves

| Property | CI (in-process, real core + schema on SQLite) | Live run |
|---|---|---|
| Both D1 triggers abort direct inserts; denials write nothing | yes (mutation tests drop each trigger and the driver fails) | yes, against `cairnstone-private-staging-2` |
| Durable nonce barrier stops replay after the per-isolate cache is cleared | yes (mutation: barrier removed -> C03 fails) | yes, across real isolates |
| `ctx.props.caller` attestation | logic only (stub) | yes, real service bindings |
| Typed errors across RPC | collapse mutation fails C07 | yes, real boundary |
| OAuth audience/revocation | stub | yes, real verifier |
| Cloudflare IDs, tags, exposure | fake API | yes |

## Evidence

`s1-3-stagec-evidence.json` (schema `cairnstone-s1-3-stagec-evidence-v1`): mode (`live` or `simulated`), source SHA, run id, per-case expected/observed, D1 count snapshots, redacted request log (identity, method, ok, code; no signatures, nonces, tokens, keys or bodies), `evidence_sha256`, warnings, cleanup record. Workflow run id and artifact come from GitHub.
**Recording**: an operator creates a CairnStone *evidence* Stone from the artifact (run id, source SHA, `evidence_sha256`, case results). Do not set or move an accepted HEAD; that is a separate owner gate.

## Owner prerequisites (not done by this change)

1. #87 deployment has been run and passed (Worker deployed from the pinned SHA, HMAC key provisioned, readback green).
2. Staging gateway harness deployed with the contract above, with its service bindings (valid, none, wrong `props.caller`) and a staging OAuth verifier.
3. Environment `s1-3-staging` secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STAGE_C_HARNESS_URL`, `STAGE_C_HARNESS_TOKEN`; variable `STAGE_C_GATEWAY_WORKER`. Reviewers and branch restriction are GitHub settings, not enforced by YAML.
4. The D1 REST token must allow `SELECT`/`PRAGMA` and the two trigger-probe `INSERT`s on the staging database. The driver's SQL guards allow nothing else.

## Fixtures and cleanup

All data is synthetic and keyed by run id. Messages and deliveries are immutable by trigger, so they are never deleted. Cleanup is off by default and runs only when the dispatcher supplies the exact phrase `OWNER_APPROVED_STAGEC_FIXTURE_CLEANUP` **and** an approval id; it then revokes the two synthetic `grok` connections through the store (nothing else). Deleting the old staging D1 (`26d4e786-...`) remains a separate owner-approved operation.

## Rollback / stop plan

- The workflow changes no Cloudflare resource, so there is nothing to roll back in Cloudflare. A failed run leaves synthetic rows only.
- C02 fails with `stray` set => a trigger did not abort and a synthetic row was committed. **Stop**: treat staging as unprotected, do not proceed to any acceptance, and fix the schema (re-apply `0002`) under an owner gate before re-running.
- Any C03/C04/C05 failure => stop the gateway enablement; the private tools stay dormant. Rotate the HMAC key (previous-key slot) if signature handling is suspect.
- No accepted-HEAD promotion or production activation without an owner gate.

## Unverified here (flagged)

- Cloudflare response shapes for `/deployments`, service-binding `props` in worker settings, and D1 REST error text for trigger aborts are mocked. If settings do not return `props`, the run prints a loud warning and attestation rests on C04 alone.
- The harness does not exist yet; the contract above is what the live run requires.
