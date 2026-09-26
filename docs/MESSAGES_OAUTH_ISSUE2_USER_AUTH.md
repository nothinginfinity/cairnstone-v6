# Messages OAuth Issue 2 — real user auth + consent

Status: **IMPLEMENTATION IN REPO / DEPLOY NOT AUTHORIZED BY THIS PR.**
Authority: Jared decision 2026-09-26 via Claude `msg-oauth-issue2-decision-20260926`.
Builds on: Issue 1 audience canonicalize (PR #53 / `13d59a9`).

## What changed

`GET /oauth/authorize` no longer calls `bootstrapAccountConnection` and no longer issues an authorization code on first hit. After CIMD/redirect/PKCE/resource checks pass, the AS:

1. Creates an `auth_authorize_sessions` row (HttpOnly `cs_oauth_sess` cookie).
2. Renders an HTML consent page (client name, scopes, resource).
3. Requires passkey assertion **or** invite redemption, then explicit **Approve**.
4. **Deny** redirects to `redirect_uri` with `error=access_denied`.

Token redeem mints a **new connection + token family under the existing account** via `mintConnectionUnderAccount` — it does not create anonymous `acct_*` rows or new wallet authenticators.

Orphan anonymous accounts from prior connects are left intact (no merge, no revoke).

## Auth D1 schema / migration

Apply on **`CAIRNSTONE_AUTH_DB`** (`cairnstone-v6-auth`) only:

```bash
npm run db:migrate:auth:local   # local
npm run db:migrate:auth:remote  # production — coordinator only after merge
```

Migration: `migrations/auth/0004_msg_oauth_issue2_user_auth.sql`

| Table | Purpose |
|---|---|
| `auth_passkeys` | credential_id, account_id, authenticator_id, public_key_jwk_json, sign_count (no secrets) |
| `auth_webauthn_challenges` | single-use assertion/registration challenges (short TTL) |
| `auth_login_invites` | hashed invite codes → target account (single-use, ~15m) |
| `auth_login_invite_rate_buckets` | per-IP and per-client_id redeem rate limits |
| `auth_authorize_sessions` | pending OAuth browser sessions until auth + consent |
| `auth_authorization_codes.step_up_confirmed` | 1 only when WebAuthn UV succeeded |

## WebAuthn

| Setting | Default |
|---|---|
| RP ID | `cairnstone-v6.jaredtechfit.workers.dev` |
| Origin | `https://cairnstone-v6.jaredtechfit.workers.dev` |
| UV | required |

Env overrides (names only): `CORE_AUTH_WEBAUTHN_RP_ID`, `CORE_AUTH_WEBAUTHN_ORIGIN`.

Passkey ceremony runs **inline** in the authorize page (`navigator.credentials.get/create`) so it works inside iOS `ASWebAuthenticationSession` / in-app browsers (no popup-only flow).

`step_up_confirmed` is true only when the WebAuthn UV flag is set on a verified assertion/registration.

## Operator: first owner invite + passkey enroll

Requires secret **`CAIRNSTONE_OPERATOR_TOKEN`** (same operator bearer used elsewhere). Optional display subject: `CAIRNSTONE_OPERATOR_SUBJECT`.

1. **Create canonical owner account** (does **not** reuse anonymous `acct_*` rows):

```bash
curl -sS -X POST "$AS/oauth/operator/owner-account" \
  -H "authorization: Bearer $CAIRNSTONE_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"display_name":"Jared","account_key":"owner"}'
```

Note the returned `account_id` / `home_tenant_id`.

2. **Mint a one-time invite** (plaintext returned once; only the hash is stored):

```bash
curl -sS -X POST "$AS/oauth/operator/login-invites" \
  -H "authorization: Bearer $CAIRNSTONE_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"account_id":"<account_id>","ttl_seconds":900}'
```

3. Start an OAuth authorize URL from Claude/ChatGPT (or a test client). On the consent page, enter the invite code → **Approve**. Optionally tap **Enroll passkey** (Face ID) before Approve so subsequent connects use passkey + UV.

Open passkey registration from `pending_auth` is not offered — first enrollment is invite-gated.

## Env / secrets (names only)

| Name | Role |
|---|---|
| `CAIRNSTONE_OPERATOR_TOKEN` | Gates `/oauth/operator/*` |
| `CAIRNSTONE_OPERATOR_SUBJECT` | Optional audit subject |
| `CORE_AUTH_WEBAUTHN_RP_ID` | Optional RP ID override |
| `CORE_AUTH_WEBAUTHN_ORIGIN` | Optional origin override |
| `CORE_AUTH_LOGIN_INVITE_RATE_LIMIT_MAX` | Optional invite redeem rate max |
| `CORE_AUTH_LOGIN_INVITE_RATE_LIMIT_WINDOW_SECONDS` | Optional window |

Unchanged hard stops: `CORE_AUTH_ENFORCEMENT=shadow`, `CORE_AUTH_DCR_ENABLED=false`, `MESSAGES_SEND` / `MESSAGES_SEND_ENABLED` remain off.

## Tests / CI note

`test/msg-oauth-issue2-user-auth.test.js` covers:

- Passkey happy path (synthetic ES256 assertion → consent → code)
- Invite happy path
- Invite reuse + expiry rejected
- Authorize without auth yields no code
- Deny → `access_denied`
- Same `account_id` across two clients after auth

WebAuthn crypto is exercised with in-process ECDSA P-256 keys and crafted authenticatorData/clientDataJSON (no live Face ID). If CI cannot run SubtleCrypto ECDSA verify, those cases fail closed — unit coverage still validates session/invite/consent gating without platform authenticators.
