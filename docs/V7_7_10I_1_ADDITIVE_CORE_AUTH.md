# V7.7.10i.1 — Additive authenticated Core canary (implementation note)

Status: **IMPLEMENTATION LANDED IN REPO / DEPLOY NOT AUTHORIZED.**
Authority: `48c87468211ceefa496637fc1d05efacd3f912ca44afb7507518169647f5439e`
Upstream freeze: `cdd79ae23c69f6013b573a72cf9126e3f9cea73eda185be81dc3032dbb3f3e09`
Git freeze lineage: `29bc1f9693db753c38763998c79f284f3b26e0e1`
Live runtime until a separate deploy gate: **`0.5.43` (unchanged)**

## What landed

| Piece | Location |
|---|---|
| `/mcp/core-auth` route (core profile + auth gate) | `src/index.js` |
| Auth kernel (ladder, PRM, token family, CIMD SSRF, identity asserts) | `src/core-auth.js` |
| `auth_*` storage firewall migration | `migrations/0024_v7710i1_core_auth.sql` |
| Negative fixtures + canary isolation tests | `test/v7710i1-core-auth.test.js` |
| OAuth discovery / authorize / token / revoke / register (DCR off by default) | path-only PRM + `/oauth/*` |

Legacy `/mcp`, `/mcp/core`, and `/mcp-b` behavior is unchanged. Authentication failure on the canary cannot disable them.

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
- `CORE_AUTH_DCR_ENABLED=true` — enable DCR compatibility (default off / NF-26)
- `CAIRNSTONE_AUTH_DB` — prefer separate auth D1; else shared `CAIRNSTONE_DB` with `auth_*` + `realm='core-auth'`

## Selective canary admission

`redeemAuthorizationCode` / `/oauth/authorize` **do not** auto-admit every minted connection. Admission requires an explicit allowlist hit (`CORE_AUTH_CANARY_CONNECTIONS`), `CORE_AUTH_CANARY_AUTO_ADMIT`, or an operator-seeded `auth_canary_admissions` row. Tests may pass `admitCanary: true` into bootstrap only as an explicit operator-equivalent knob.

## Discovery notes

- PRM is path-only: `/.well-known/oauth-protected-resource/mcp/core-auth` (no root PRM, to avoid confusing legacy discovery).
- AS metadata advertises `authorization_endpoint` because **GET/POST `/oauth/authorize` are implemented**.
- **DELETE `/mcp/core-auth`** clears ephemeral `mcp_core_sessions` hydration only and **skips the Bearer auth gate** (same class as discovery). It cannot read `auth_*` private rows. Documented residual; not a protected-tool execution path.

## Residual risk (NF-25)

Stolen same-resource bearer replay is **documented, not solved**. Mitigations in this slice: short access TTL, TLS, refresh rotation + reuse detection, revocation. Sender-constrained tokens (DPoP / similar) await host support. Do not claim solved.

## Out of scope (held)

- Deploy / Pages cutover / runtime bump
- `required` enforcement or legacy route replacement
- V7.7.10j Tool Belts mutations
- Wallet funding; host install ID continuity; second catalog twin
- Full AC1/workspace principal binding beyond gateway fail-closed selectors (continues in 10i.3); NF-09/10/11 are enforced at the core-auth gateway with home-pointer / grant-proof checks
