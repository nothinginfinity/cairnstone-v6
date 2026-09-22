# V7.7.10i.1c1 — OAuth client compatibility + safe DCR registry

Status: **IMPLEMENTATION LANDED / DEPLOY NOT AUTHORIZED / LIVE RUNTIME STILL 0.5.43 / ENFORCEMENT STILL SHADOW.**

Authority: Jared authorized via ChatGPT `msg:fe2af19c-d46c-4065-b2d5-b35c2b3a57d9`.
Plan stone: `73e51fb5c725a60183409d74d6af85ba977d64e6a2f7d567705d7fc2c582f9db`
(`project-memory/v7710i1c1-oauth-client-compatibility-fix-plan.md`).
Branches from main SHA: `676dbf5918794d2655eb93b8364526e3d75a3937`.
START HERE remains 10i.1b shadow (`6f7f1e108559…`); this slice does **not** flip canary/enforcement.

## What landed

- Strict shared OAuth POST parser (`parseOauthPostBody`) for `/oauth/token` and `/oauth/revoke`: form-urlencoded preferred; JSON retained for compatibility/tests; unsupported → 415.
- RFC 8414 issuer-path discovery at `/.well-known/oauth-authorization-server/oauth`, preserving root and `/oauth/.well-known/...` aliases.
- AS metadata advertises `client_id_metadata_document_supported: true`; advertises `registration_endpoint` **only** when `CORE_AUTH_DCR_ENABLED` is true.
- Real bounded public-client DCR registry in dedicated Auth D1: `migrations/auth/0002_v7710i1c1_oauth_clients.sql` → `auth_oauth_clients`.
- Persists normalized `redirect_uris` + non-authoritative metadata; `token_endpoint_auth_method=none`; **never** stores `client_secret`.
- `/oauth/authorize` rejects unknown opaque `client_id`; enforces exact persisted `redirect_uri`. HTTPS URL `client_id` continues through CIMD validation.
- Token exchange keeps exact `client_id` + `redirect_uri` + PKCE + issuer + resource binding.
- DCR/CIMD never auto-admit canary connections.

## Held boundaries

- No deploy / merge to main / live DCR flag flip / enforcement change / canary seeding / auto-admit / required mode.
- Legacy `/mcp`, `/mcp/core`, `/mcp-b` untouched.
- VERSION remains `0.5.43`.

See `docs/V7_7_10I_1_ADDITIVE_CORE_AUTH.md`.
