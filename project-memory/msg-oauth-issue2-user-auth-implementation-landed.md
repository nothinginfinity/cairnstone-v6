# Messages OAuth Issue 2 — implementation landed (PR pending merge/deploy)

Authority: Jared decision 2026-09-26 via Claude `msg-oauth-issue2-decision-20260926`.
Repo tip base: Issue 1 canonicalize (`13d59a9` / PR #53).

## Landed

- `GET /oauth/authorize` renders consent HTML after CIMD/redirect/PKCE/resource checks; no anonymous `bootstrapAccountConnection`; no code without auth + Approve.
- Passkey (WebAuthn UV, RP ID `cairnstone-v6.jaredtechfit.workers.dev`) + invite-code fallback.
- Auth D1 migration `migrations/auth/0004_msg_oauth_issue2_user_auth.sql`.
- Operator: `POST /oauth/operator/owner-account`, `POST /oauth/operator/login-invites` (Bearer `CAIRNSTONE_OPERATOR_TOKEN`).
- Redeem uses `mintConnectionUnderAccount` (same account_id, new connection/token family).
- Orphan anonymous accounts left intact (no merge/revoke).
- Docs: `docs/MESSAGES_OAUTH_ISSUE2_USER_AUTH.md`.
- Tests: `test/msg-oauth-issue2-user-auth.test.js` (+ updated core-auth / 10l.7 authorize expectations).

## Hard stops unchanged

- `CORE_AUTH_ENFORCEMENT=shadow`, `CORE_AUTH_DCR_ENABLED=false`, Messages send stays off.
- Do not merge/deploy from this note — coordinator after review.
