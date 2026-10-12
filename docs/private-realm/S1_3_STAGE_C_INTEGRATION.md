# Stage C integration (issue #94)

Replaces the stubbed `/stagec/v1/call` and `/probe` with a real path:

    PR #93 driver -> harness Worker (cairnstone-stage-harness) -> signed envelope {v,caller,method,args,iat,nonce}
      -> service binding (props.caller) -> private staging Worker -> staging private D1

Files: `src/staging-gateway/stagec-harness-worker.js` (HTTP surface), `stagec-harness-core.js` (scope derivation, signing,
probes), `staging-token.js`, `private-error-code.js`, `wrangler.stagec-harness.toml`. The public gateway Worker no longer serves `/stagec/*`.

## Surface
Disabled (404 everywhere) unless `STAGE_C_HARNESS_ENABLED="true"`. POST only, two paths, bearer `STAGE_C_HARNESS_TOKEN`
(>=32 chars, constant-time compare), body <=32 KiB, strict keys. The request can never supply scope, home, role, caller, key
or an unlisted method; scope is derived server side from {account: alpha|bravo, provider: chatgpt|grok}.
No routes, no workers.dev, no preview URLs.

## Probes
bad_sig, stale/future iat, mutated method/args, wrong caller name, missing/wrong platform caller (extra bindings with
different props), replay_same_nonce, replay_preseeded_nonce (D1 nonce seeded by the driver; proves the durable barrier because
isolates cannot be attested from a Worker), selector injection, wrong_audience_token, revoked_oauth, wrong_account_association
(real verifier + real staging auth D1, positive control first), legacy_regression (owner-supplied https URLs). Misconfiguration
returns an explicit fail-closed result (`private_worker_unconfigured`, `harness_oauth_unconfigured`, `legacy_not_configured`).

## What CI proves and does not
CI runs the unmodified driver with `allowStubs` off over an injected transport against binding doubles and real SQLite with the
staging migrations; evidence is labeled `mode: simulated`, `harness_transport: injected`. It is NOT live acceptance.
Platform behavior (props attestation shape, Workers RPC error transport, isolates) is only verified by the owner-dispatched live run.
Typed codes are recovered by value (`.code`, then `.message`, allowlisted) because RPC may drop class and `.code`.

## Remaining owner staging prerequisites
1. Create `cairnstone-staging-auth` D1 and apply its migration; replace placeholder ids.
2. Deploy `cairnstone-private-staging` (reviewed merged main ce565ef97eb7; see S1_3_STAGING_ACTIVATION.md) and the harness Worker; provision an access-restricted hostname for the harness.
3. Secrets: `STAGE_C_HARNESS_TOKEN`, `PRIVATE_GATEWAY_HMAC_KEY`, `STAGING_OAUTH_SIGNING_KEY`; optional `LEGACY_MCP_HEALTH_URL`, `LEGACY_MCP_TOOLS_URL`; set `STAGE_C_HARNESS_ENABLED="true"` only for the run, then back to false.
4. Dispatch the PR #93 live workflow; review evidence; record it in a CairnStone Stone.
Stop/rollback: set `STAGE_C_HARNESS_ENABLED` to "false" (or delete the harness Worker); the harness holds no state beyond synthetic rows.
Human-controlled release is issue #90.
