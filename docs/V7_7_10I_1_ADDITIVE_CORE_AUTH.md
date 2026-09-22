# V7.7.10i.1 — Additive authenticated Core canary (implementation note)

Status: **IMPLEMENTATION LANDED IN REPO / DEPLOY NOT AUTHORIZED.**
Authority: `48c87468211ceefa496637fc1d05efacd3f912ca44afb7507518169647f5439e`
Upstream freeze: `cdd79ae23c69f6013b573a72cf9126e3f9cea73eda185be81dc3032dbb3f3e09`
Git freeze lineage: `29bc1f9693db753c38763998c79f284f3b26e0e1`
10i.1a Auth D1 authority: Jared approved dedicated Auth D1 via ChatGPT `msg:e938b6a9-51a3-4287-aac8-791795a17769`
Live runtime until a separate deploy gate: **`0.5.43` (unchanged)**

## What landed

| Piece | Location |
|---|---|
| `/mcp/core-auth` route (core profile + auth gate) | `src/index.js` |
| Auth kernel (ladder, PRM, token family, CIMD SSRF, identity asserts) | `src/core-auth.js` |
| Dedicated Auth D1 binding + migrations stream | `wrangler.toml` (`CAIRNSTONE_AUTH_DB`) + `migrations/auth/` |
| Auth-only schema (re-homed from retired shared `0024`) | `migrations/auth/0001_v7710i1_core_auth.sql` |
| OAuth client registry (10i.1c1) | `migrations/auth/0002_v7710i1c1_oauth_clients.sql` |
| DCR rate-limit buckets (10i.1c1a) | `migrations/auth/0003_v7710i1c1a_dcr_rate_limit.sql` |
| Negative fixtures + canary isolation + Auth D1 wiring tests | `test/v7710i1-core-auth.test.js`, `test/v7710i1a-auth-d1.test.js` |
| OAuth discovery / authorize / token / revoke / register (DCR off by default) | path-only PRM + `/oauth/*` |

Legacy `/mcp`, `/mcp/core`, and `/mcp-b` behavior is unchanged. Authentication failure on the canary cannot disable them.

## Storage architecture (10i.1a)

| Binding | D1 name | Role | Migrations |
|---|---|---|---|
| `CAIRNSTONE_DB` | `cairnstone-v6` | vault / graph / workspace / AC1 (**unchanged**) | `migrations/` (shared stream; **no** `auth_*`) |
| `CAIRNSTONE_AUTH_DB` | `cairnstone-v6-auth` | auth-only state | `migrations/auth/` |

`authDb(env)` in `src/core-auth.js` **prefers** `CAIRNSTONE_AUTH_DB`, with shared-`CAIRNSTONE_DB` fallback for local/test only. Production wrangler **must** bind `CAIRNSTONE_AUTH_DB` explicitly (do not point it at the shared DB id).

### Retired shared-path migration

`migrations/0024_v7710i1_core_auth.sql` was **superseded / retired before production application**. Auth schema lives only under `migrations/auth/0001_v7710i1_core_auth.sql`. Shared `CAIRNSTONE_DB` migration runs must never create `auth_*` tables.

### Provision Auth D1 (manual — Jared)

`wrangler.toml` currently carries:

`database_id = "PLACEHOLDER_CREATE_cairnstone-v6-auth"`

Until replaced, remote auth migration apply fails closed. Create and wire:

```bash
npx wrangler d1 create cairnstone-v6-auth
# paste returned database_id into wrangler.toml CAIRNSTONE_AUTH_DB.database_id
# do NOT reuse cairnstone-v6 / CAIRNSTONE_DB id
```

Local auth apply (dev/test):

```bash
npm run db:migrate:auth:local
```

## Enforcement ladder (core-auth only)

Env: `CORE_AUTH_ENFORCEMENT`

| Mode | Behavior |
|---|---|
| `off` (default) | Discovery may be probed. Protected `tools/call` fail closed with `401`. No unauthenticated execution mode. |
| `shadow` | Bearer + server-derived principal required on protected tools. Realm/tenant/principal isolation enforced. Canary admission not required. |
| `canary` | Same as shadow, plus only admitted connections (second Perplexity account first) may use core-auth. Non-selected stay on legacy URLs. |
| `required` | **Not authorized in 10i.1.** Runtime coerces to `canary` if set. |

Flip without touching legacy:

```bash
# probe / publish discovery only
npx wrangler secret put CORE_AUTH_ENFORCEMENT   # value: off

# auth mandatory; audit-friendly
# value: shadow

# admit selected connections (also seed auth_canary_admissions / CORE_AUTH_CANARY_CONNECTIONS)
# value: canary
```

Optional:

- `CORE_AUTH_RESOURCE` — canonical resource/audience (default `{origin}/mcp/core-auth`)
- `CORE_AUTH_ISSUER` — AS issuer (default `{origin}/oauth`)
- `CORE_AUTH_CANARY_CONNECTIONS` — comma-separated allowlist: `connection_id`, `family:<clientFamily>`, or `label:<label>`
- `CORE_AUTH_CANARY_AUTO_ADMIT=true` — operator flag to admit on mint (default **off**; OAuth redeem never hardcodes admit)
- `CORE_AUTH_DCR_ENABLED=true` — enable bounded public-client DCR (default off / NF-26). When off, AS metadata omits `registration_endpoint`. When on, `/oauth/register` persists opaque clients into `auth_oauth_clients` (no `client_secret`; PKCE `token_endpoint_auth_method=none` only). DCR/CIMD never auto-admit canary.
- `CORE_AUTH_DCR_RATE_LIMIT_MAX` — max DCR registrations per client IP per window (default `5`). Client IP prefers `CF-Connecting-IP`, else first `X-Forwarded-For` hop.
- `CORE_AUTH_DCR_RATE_LIMIT_MAX_UNKNOWN` — stricter max when IP resolves to `unknown` (default `2`).
- `CORE_AUTH_DCR_RATE_LIMIT_WINDOW_SECONDS` — rate-limit window length (default `3600`). Buckets persist in Auth D1 `auth_dcr_rate_buckets` (`migrations/auth/0003_v7710i1c1a_dcr_rate_limit.sql`). Exceeded → HTTP `429` `slow_down` + `Retry-After` when practical.
- `CORE_AUTH_DCR_MAX_ACTIVE_CLIENTS` — hard cap on `auth_oauth_clients` rows with `status=active` (default `1000`). Exceeded → HTTP `403` `dcr_capacity_exceeded`.
- `CORE_AUTH_DCR_INITIAL_ACCESS_TOKEN` — optional RFC 7591-style initial-access gate. When set/non-empty, `POST /oauth/register` requires `Authorization: Bearer <token>` (timing-safe compare against env secret). Missing/wrong → `401` `invalid_token`. When unset, register remains open aside from rate limit + active-client cap (backward compatible for tests).
- `CAIRNSTONE_AUTH_DB` — dedicated auth D1 binding (required in production wrangler)

**Broad DCR enablement (`CORE_AUTH_DCR_ENABLED=true` in live) requires this 10i.1c1a hardening** (IP rate limit + active-client cap; strongly recommend setting `CORE_AUTH_DCR_INITIAL_ACCESS_TOKEN` before any public expose). Do not flip DCR live in this slice.

## Deploy packet (10i.1a intent — NOT AUTHORIZED YET)

Workflow: `.github/workflows/deploy-cloudflare.yml`

| Input | First 10i.1a deploy intent | Notes |
|---|---|---|
| `apply_migrations` | `false` | Shared vault/graph DB untouched |
| `apply_auth_migrations` | `true` | Dedicated auth DB only; **fails closed** if `CAIRNSTONE_AUTH_DB` absent / still `PLACEHOLDER_*` |
| `run_v*_acceptance` | all `false` | No live acceptance gates in this packet |
| `CORE_AUTH_ENFORCEMENT` | leave `off` | Do not flip |
| Canary | no auto-admit / no seed admissions | `CORE_AUTH_CANARY_AUTO_ADMIT` stays off |

**STOP until explicit human deploy authorization:** no `workflow_dispatch`, no Worker publish, no remote migration apply, no shadow/canary/required flip, no `CANARY_AUTO_ADMIT`, no seeded admissions.

## Selective canary admission

`redeemAuthorizationCode` / `/oauth/authorize` **do not** auto-admit every minted connection. Admission requires an explicit allowlist hit (`CORE_AUTH_CANARY_CONNECTIONS`), `CORE_AUTH_CANARY_AUTO_ADMIT`, or an operator-seeded `auth_canary_admissions` row. Tests may pass `admitCanary: true` into bootstrap only as an explicit operator-equivalent knob.

## Discovery notes

- PRM is path-only: `/.well-known/oauth-protected-resource/mcp/core-auth` (no root PRM, to avoid confusing legacy discovery).
- AS metadata is served at RFC 8414 `/.well-known/oauth-authorization-server/oauth` (issuer `{origin}/oauth`), plus compatibility aliases at root `/.well-known/oauth-authorization-server` and `/oauth/.well-known/oauth-authorization-server`.
- AS metadata advertises `authorization_endpoint` because **GET/POST `/oauth/authorize` are implemented**.
- AS metadata advertises `client_id_metadata_document_supported: true` (CIMD preferred). `registration_endpoint` is advertised **only** when `CORE_AUTH_DCR_ENABLED` is true.
- `/oauth/register` (when DCR enabled) enforces per-IP rate limits, an active-client hard cap, and an optional initial-access Bearer gate (10i.1c1a). Broad live DCR expose requires this hardening.
- `/oauth/token` and `/oauth/revoke` accept `application/x-www-form-urlencoded` (primary) and `application/json` (compatibility); other media types → 415.
- Opaque `client_id` at authorize requires an active persisted DCR client + exact registered `redirect_uri`. HTTPS URL `client_id` uses CIMD validation.
- **DELETE `/mcp/core-auth`** clears ephemeral `mcp_core_sessions` hydration only and **skips the Bearer auth gate** (same class as discovery). It cannot read `auth_*` private rows. Documented residual; not a protected-tool execution path.

## Residual risk (NF-25)

Stolen same-resource bearer replay is **documented, not solved**. Mitigations in this slice: short access TTL, TLS, refresh rotation + reuse detection, revocation. Sender-constrained tokens (DPoP / similar) await host support. Do not claim solved.

## Out of scope (held)

- Deploy / Pages cutover / runtime bump
- Remote Auth D1 create / migration apply (manual Jared step + later deploy gate)
- `required` enforcement or legacy route replacement
- V7.7.10j Tool Belts mutations
- Wallet funding; host install ID continuity; second catalog twin
- Full AC1/workspace principal binding beyond gateway fail-closed selectors (continues in 10i.3); NF-09/10/11 are enforced at the core-auth gateway with home-pointer / grant-proof checks
