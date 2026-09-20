# V7.7.10i.0 — Frozen account-root contracts

Status: **CONTRACT FREEZE / NOT RUNTIME.** No `/mcp/core-auth` enforcement, route replacement, or deploy is authorized by this file.

Slice: `v7710i_0_contract_threat_model_independent_review`
Parent: `docs/V7_7_10I_CONNECTOR_BOUND_IDENTITY.md` @ `f5bf158691442298116ea3aba4e0aca5a5c73182`

## Semantics

```text
account_id -> authenticator_id*
account_id -> connection_id* -> principal_id -> token_family_id*
wallet_account_id is a linked authenticator/economic relationship, never identity root
wallet addresses / payment instruments are rotatable and never principal identity
routing aliases are addresses only
```

Caller-supplied identity JSON may narrow a permitted operation but must never replace the server-derived account, tenant, connection, principal, or token family. Legitimate target selectors (for example message recipients or assignees) may name another principal only when that operation's policy authorizes the target; selecting a target never changes the caller.

Secrets (tokens, codes, wallet proofs, passkeys, refresh material, private keys) must never enter Stones, AC1, GitHub, model context, tool arguments, receipts, or ordinary logs.

## cairnstone-account-v1

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "cairnstone-account-v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "account_id", "home_tenant_id", "status", "created_at"],
  "properties": {
    "schema": { "const": "cairnstone-account-v1" },
    "account_id": { "type": "string", "minLength": 16, "maxLength": 128, "pattern": "^acct_[A-Za-z0-9_-]+$" },
    "home_tenant_id": { "type": "string", "minLength": 16, "maxLength": 128, "pattern": "^ten_[A-Za-z0-9_-]+$" },
    "status": { "enum": ["active", "suspended", "recovering", "closed"] },
    "display_name": { "type": "string", "maxLength": 120 },
    "home_workspace_id": { "type": ["string", "null"] },
    "home_code_session_id": { "type": ["string", "null"] },
    "created_at": { "type": "string", "format": "date-time" },
    "closed_at": { "type": ["string", "null"], "format": "date-time" }
  }
}
```

`home_tenant_id` is the account's bootstrap/default tenant, not the complete tenant-membership model. Membership in additional tenants is relational state. Selecting or binding a tenant for a connection requires validated membership; changing the active tenant never changes `account_id`.

## cairnstone-authenticator-v1

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "cairnstone-authenticator-v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "authenticator_id", "account_id", "method", "status", "assurance_class", "created_at"],
  "properties": {
    "schema": { "const": "cairnstone-authenticator-v1" },
    "authenticator_id": { "type": "string", "pattern": "^authn_[A-Za-z0-9_-]+$" },
    "account_id": { "type": "string", "pattern": "^acct_[A-Za-z0-9_-]+$" },
    "method": { "enum": ["wallet_proof", "passkey_webauthn", "custodial_idp", "other_approved"] },
    "status": { "enum": ["active", "replaced", "revoked"] },
    "assurance_class": { "enum": ["wallet_ownership", "webauthn", "oidc", "other_approved"] },
    "wallet_account_id": { "type": ["string", "null"], "pattern": "^walacct_[A-Za-z0-9_-]+$" },
    "created_at": { "type": "string", "format": "date-time" },
    "revoked_at": { "type": ["string", "null"], "format": "date-time" }
  }
}
```

Authenticator method/assurance pairs are constrained: `wallet_proof -> wallet_ownership`, `passkey_webauthn -> webauthn`, `custodial_idp -> oidc`, and `other_approved -> other_approved`. Step-up is authorization/session evidence, not a base authenticator class. `wallet_account_id` is valid only for an approved wallet linkage and never changes the account root; the authoritative account↔wallet relationship remains separately governed state.

## cairnstone-connection-principal-v1

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "cairnstone-connection-principal-v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema", "connection_id", "principal_id", "account_id", "tenant_id",
    "status", "client_family", "created_at"
  ],
  "properties": {
    "schema": { "const": "cairnstone-connection-principal-v1" },
    "connection_id": { "type": "string", "pattern": "^conn_[A-Za-z0-9_-]+$" },
    "principal_id": { "type": "string", "pattern": "^prin_[A-Za-z0-9_-]+$" },
    "account_id": { "type": "string", "pattern": "^acct_[A-Za-z0-9_-]+$" },
    "tenant_id": { "type": "string", "pattern": "^ten_[A-Za-z0-9_-]+$" },
    "status": { "enum": ["active", "revoked", "superseded"] },
    "client_family": { "type": "string", "maxLength": 64 },
    "routing_aliases": {
      "type": "array",
      "maxItems": 16,
      "items": { "type": "string", "maxLength": 128 }
    },
    "oauth_sub": { "type": "string", "description": "Token sub MUST equal principal_id." },
    "created_at": { "type": "string", "format": "date-time" },
    "revoked_at": { "type": ["string", "null"], "format": "date-time" }
  }
}
```

`tenant_id` on the connection principal is the active/bound tenant for that connection. It is valid only while the owning account has membership in that tenant and does not make the account itself single-tenant.

## cairnstone-token-family-v1

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "cairnstone-token-family-v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema", "token_family_id", "connection_id", "principal_id", "account_id", "tenant_id",
    "origin_authenticator_id", "resource", "status", "authz_version", "refresh_generation", "created_at"
  ],
  "properties": {
    "schema": { "const": "cairnstone-token-family-v1" },
    "token_family_id": { "type": "string", "pattern": "^tfam_[A-Za-z0-9_-]+$" },
    "connection_id": { "type": "string", "pattern": "^conn_[A-Za-z0-9_-]+$" },
    "principal_id": { "type": "string", "pattern": "^prin_[A-Za-z0-9_-]+$" },
    "account_id": { "type": "string", "pattern": "^acct_[A-Za-z0-9_-]+$" },
    "tenant_id": { "type": "string", "pattern": "^ten_[A-Za-z0-9_-]+$" },
    "origin_authenticator_id": { "type": "string", "pattern": "^authn_[A-Za-z0-9_-]+$" },
    "resource": { "type": "string", "minLength": 1, "maxLength": 512 },
    "scopes": { "type": "array", "maxItems": 64, "uniqueItems": true, "items": { "type": "string", "minLength": 1, "maxLength": 128 } },
    "status": { "enum": ["active", "revoked", "superseded"] },
    "authz_version": { "type": "integer", "minimum": 1 },
    "refresh_generation": { "type": "integer", "minimum": 0 },
    "created_at": { "type": "string", "format": "date-time" },
    "last_rotated_at": { "type": ["string", "null"], "format": "date-time" },
    "revoked_at": { "type": ["string", "null"], "format": "date-time" },
    "superseded_by_token_family_id": { "type": ["string", "null"], "pattern": "^tfam_[A-Za-z0-9_-]+$" }
  }
}
```

A connection principal may have zero or many token families over time. Refresh rotation increments `refresh_generation` within one family; a fresh authorization may mint a new family. A token family never changes its owning account, connection, or principal. Access tokens bind `sub = principal_id`, `token_family_id`, the canonical resource/audience, and the current `authz_version`; stale authorization versions fail closed after membership/grant revocation.

## Wallet / instrument separation

- `wallet_account_id` may be auto-provisioned at zero balance for the first canary authenticator.
- Authentication MUST NOT mint spend, payment, or economic authority.
- Payment instruments and chain addresses are child records of `wallet_account_id`; rotating them does not replace `account_id`.
- A fresh MCP authorization MAY mint a new `connection_id`/`principal_id` under the same `account_id`, MUST mint a new token family for that authorization, and MUST resume account-owned home/workspace/session pointers.

## CIMD fetch policy (SSRF)

Authorization-server fetch of a CIMD `client_id` URL MUST:

- HTTPS only; no HTTP, no redirects to private/link-local/metadata IPs;
- timeout ≤ 3s, body ≤ 64 KiB, no file/gopher/data schemes;
- require the document URL to equal the presented `client_id`;
- allowlist `redirect_uri` exactly as published;
- cache by URL+content hash; fail closed on fetch error.

DCR remains compatibility-only and disabled unless an explicit canary flag is on.

## Migration assertion rule

This rule applies only to caller-identity claims and mailbox-owner assertions. It does not turn legitimate target selectors such as `to`, `assignee_actor_id`, `principal_actor_id`, or `selected_actors` into caller-identity fields; targets are separately authorized by operation policy.

Caller-supplied `from`, `recipient_id`, `actor_id`, `account_id`, `tenant_id`, `principal_id`, or `connection_id`:

1. If omitted: use server-derived context only.
2. If present and equal to the authenticated principal (or an alias already bound to it): accept as assertion.
3. Else: `403` fail-closed. Never rewrite, never impersonate, never “helper select.”

## Authenticator and token-family revocation

`status = replaced` on an authenticator prevents it from being used for new authentication but does not by itself rewrite the durable account or connection identity. `status = revoked` for compromise MUST revoke every active token family whose `origin_authenticator_id` matches. Neither replacement nor revocation changes `account_id`.

## Residual risk (same-resource stolen bearer)

Until sender-constrained tokens (DPoP / similar) are host-supported, stolen same-audience bearer replay is mitigated only by short access TTL, TLS, refresh rotation + reuse detection, revocation, and later sender constraints. This is **not** claimed solved.
