# V7.7.10i.0 — Canary rollback and compatibility firewall

Status: **CONTRACT FREEZE.** Authentication failure on the canary MUST NOT disable legacy routes.

## Enforcement ladder (core-auth only)

`off -> shadow -> canary -> required`

- `off`: core-auth is not published/usable for protected tools. Discovery may be probed, but protected tool calls fail closed; there is no unauthenticated core-auth execution mode.
- `shadow`: authentication is mandatory. A valid bearer and server-derived principal are required; only downstream authorization/policy differences may be audit-only. Realm/tenant/principal isolation is enforced, never shadowed.
- `canary`: selected connections (second Perplexity account first) are admitted and require valid tokens; non-selected callers remain on unchanged legacy URLs. Any protected request reaching core-auth without a valid token gets `401`.
- `required`: new users default to core-auth. Legacy stays up until parity + this rollback file’s exit criteria.

The ladder controls rollout/admission, not whether authentication exists. Once a protected tool request reaches core-auth, authentication is never optional.

Legacy `/mcp`, `/mcp/core`, `/mcp-b` never enter this ladder in 10i.1.

## Storage firewall

Prefer a **separate authenticated D1** for canary rows.

If one D1 is unavoidable:

- tables/namespaces `auth_*` only;
- every authenticated query includes `realm = 'core-auth'` AND `tenant_id` AND `principal_id` (or account where the operation is account-scoped);
- legacy queries MUST NOT join `auth_*` and MUST filter `realm = 'legacy'` or absence of realm on pre-canary tables only.

Caller-supplied IDs never expand the predicate.

## Rollback procedure

1. Set core-auth enforcement to `off` or remove the route from published client config.
2. Do not mutate `/mcp`, `/mcp/core`, `/mcp-b` code paths.
3. Leave auth_* data in place (do not delete accounts) but unreachable from legacy.
4. Revoke canary token families if a token-leak incident.
5. Record an audit receipt **without secrets**.
6. Resume 10i.0 contract work; do not “fix forward” on production identity.

Rollback is successful when legacy clients still complete health + Core tools on the compatibility realm and cannot read canary private state.

## Exit to 10i.1 implementation

10i.1 may start only when:

- these four freeze docs are on Git `main` and accepted as path HEADs (separate accept step);
- independent review residual-risk statement on stolen bearer is acknowledged;
- CIMD SSRF policy is frozen in the auth kernel design notes;
- the account contract uses `home_tenant_id` plus relational tenant memberships, and connection principals bind only validated active tenants;
- `cairnstone-token-family-v1` plus rotation/revocation/stale-authorization-version lifecycle fixtures are frozen;
- identity-bearing fields are classified as server-derived caller, checked caller assertion, authorized target selector, or resource selector;
- shadow/canary semantics keep authentication mandatory on protected core-auth tool calls;
- x402 kernel reuse excludes single-subject and `fam:<provider>` as uniqueness.

## Non-goals

- No production account-bound Tool Belt mutation (V7.7.10j).
- No wallet funding requirement.
- No host installation ID as continuity key.
- No second catalog twin for auth.
