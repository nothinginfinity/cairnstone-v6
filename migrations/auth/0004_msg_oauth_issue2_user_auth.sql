-- Messages OAuth Issue 2 — real user auth + consent for /oauth/authorize.
-- Auth-only D1 stream: migrations/auth/ → CAIRNSTONE_AUTH_DB (cairnstone-v6-auth).
--
-- Adds passkey (WebAuthn) credentials, single-use WebAuthn challenges,
-- operator-minted login invites, authorize browser sessions, and
-- step_up_confirmed on authorization codes.
--
-- Does NOT merge or revoke orphan anonymous acct_* rows from prior connects.
-- Legacy /mcp|/mcp/core|/mcp-b MUST NOT join these tables.
-- Secrets (invite plaintext, private keys) are never stored — hashes/public keys only.

-- Passkey public credentials (no private key material).
CREATE TABLE IF NOT EXISTS auth_passkeys (
  credential_id TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  account_id TEXT NOT NULL,
  authenticator_id TEXT NOT NULL,
  public_key_jwk_json TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0
    CHECK (sign_count >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]',
  user_handle TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  FOREIGN KEY (account_id) REFERENCES auth_accounts(account_id),
  FOREIGN KEY (authenticator_id) REFERENCES auth_authenticators(authenticator_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_passkeys_account
  ON auth_passkeys (realm, account_id, status);

-- Single-use WebAuthn challenges (assertion or registration).
CREATE TABLE IF NOT EXISTS auth_webauthn_challenges (
  challenge_hash TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  purpose TEXT NOT NULL
    CHECK (purpose IN ('assertion', 'registration')),
  session_id TEXT,
  account_id TEXT,
  status TEXT NOT NULL DEFAULT 'unused'
    CHECK (status IN ('unused', 'used', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0)
);

CREATE INDEX IF NOT EXISTS idx_auth_webauthn_challenges_session
  ON auth_webauthn_challenges (realm, session_id, status);

-- Operator-minted login invites (hashed plaintext; single-use; short TTL).
CREATE TABLE IF NOT EXISTS auth_login_invites (
  invite_hash TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  invite_id TEXT NOT NULL UNIQUE,
  target_account_id TEXT NOT NULL,
  target_tenant_id TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused'
    CHECK (status IN ('unused', 'redeemed', 'expired', 'revoked')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by_session_id TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  FOREIGN KEY (target_account_id) REFERENCES auth_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_login_invites_account
  ON auth_login_invites (realm, target_account_id, status);

-- Rate-limit buckets for invite redemption (per IP and per client_id).
CREATE TABLE IF NOT EXISTS auth_login_invite_rate_buckets (
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  bucket_key TEXT NOT NULL,
  window_start_iso TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
    CHECK (count >= 0),
  PRIMARY KEY (realm, bucket_key)
);

-- Browser authorize sessions: hold validated OAuth params until auth + consent.
CREATE TABLE IF NOT EXISTS auth_authorize_sessions (
  session_id TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  session_token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_name TEXT,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256'
    CHECK (code_challenge_method = 'S256'),
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  state TEXT,
  iss TEXT NOT NULL,
  cimd_content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending_auth'
    CHECK (status IN ('pending_auth', 'authenticated', 'approved', 'denied', 'expired')),
  account_id TEXT,
  tenant_id TEXT,
  authenticator_id TEXT,
  auth_method TEXT
    CHECK (auth_method IS NULL OR auth_method IN ('passkey_webauthn', 'invite_code')),
  step_up_confirmed INTEGER NOT NULL DEFAULT 0
    CHECK (step_up_confirmed IN (0, 1)),
  offer_passkey_enroll INTEGER NOT NULL DEFAULT 0
    CHECK (offer_passkey_enroll IN (0, 1)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  authenticated_at TEXT,
  completed_at TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0)
);

CREATE INDEX IF NOT EXISTS idx_auth_authorize_sessions_token
  ON auth_authorize_sessions (realm, session_token_hash);

CREATE INDEX IF NOT EXISTS idx_auth_authorize_sessions_status
  ON auth_authorize_sessions (realm, status, expires_at);

-- Record whether real user verification occurred when the code was issued.
ALTER TABLE auth_authorization_codes
  ADD COLUMN step_up_confirmed INTEGER NOT NULL DEFAULT 0;
