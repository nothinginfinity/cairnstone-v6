-- V7.7.10i.1a — Additive Core-auth canary storage (auth_* firewall).
-- Auth-only D1 stream: migrations/auth/ → CAIRNSTONE_AUTH_DB (cairnstone-v6-auth).
--
-- Supersedes retired shared-path migrations/0024_v7710i1_core_auth.sql (never applied
-- in production). Do NOT place this file under migrations/ for CAIRNSTONE_DB.
-- Shared CAIRNSTONE_DB remains vault/graph/workspace/AC1 only.
-- Local/test may still fall back to shared CAIRNSTONE_DB via authDb(); production
-- wrangler must bind CAIRNSTONE_AUTH_DB explicitly.
-- Legacy routes MUST NOT join these tables.
-- accepted_state_authority is always 0 — never moves chain_heads / path_heads.

CREATE TABLE IF NOT EXISTS auth_tenants (
  tenant_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'cairnstone-tenant-v1'
    CHECK (schema = 'cairnstone-tenant-v1'),
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at TEXT NOT NULL,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0)
);

CREATE TABLE IF NOT EXISTS auth_accounts (
  account_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'cairnstone-account-v1'
    CHECK (schema = 'cairnstone-account-v1'),
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  home_tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'recovering', 'closed')),
  display_name TEXT,
  home_workspace_id TEXT,
  home_code_session_id TEXT,
  authz_version INTEGER NOT NULL DEFAULT 1
    CHECK (authz_version >= 1),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  FOREIGN KEY (home_tenant_id) REFERENCES auth_tenants(tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_accounts_realm_status
  ON auth_accounts (realm, status);

CREATE TABLE IF NOT EXISTS auth_tenant_memberships (
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  authz_version INTEGER NOT NULL DEFAULT 1
    CHECK (authz_version >= 1),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  PRIMARY KEY (realm, account_id, tenant_id),
  FOREIGN KEY (account_id) REFERENCES auth_accounts(account_id),
  FOREIGN KEY (tenant_id) REFERENCES auth_tenants(tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_tenant_memberships_tenant
  ON auth_tenant_memberships (realm, tenant_id, status);

CREATE TABLE IF NOT EXISTS auth_authenticators (
  authenticator_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'cairnstone-authenticator-v1'
    CHECK (schema = 'cairnstone-authenticator-v1'),
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  account_id TEXT NOT NULL,
  method TEXT NOT NULL
    CHECK (method IN ('wallet_proof', 'passkey_webauthn', 'custodial_idp', 'other_approved')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'replaced', 'revoked')),
  assurance_class TEXT NOT NULL
    CHECK (assurance_class IN ('wallet_ownership', 'webauthn', 'oidc', 'other_approved')),
  wallet_account_id TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  FOREIGN KEY (account_id) REFERENCES auth_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_authenticators_account
  ON auth_authenticators (realm, account_id, status);

CREATE TABLE IF NOT EXISTS auth_wallet_accounts (
  wallet_account_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'cairnstone-wallet-account-v1'
    CHECK (schema = 'cairnstone-wallet-account-v1'),
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotated', 'revoked')),
  balance_units INTEGER NOT NULL DEFAULT 0
    CHECK (balance_units >= 0),
  address TEXT,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  FOREIGN KEY (account_id) REFERENCES auth_accounts(account_id)
);

CREATE TABLE IF NOT EXISTS auth_connection_principals (
  connection_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'cairnstone-connection-principal-v1'
    CHECK (schema = 'cairnstone-connection-principal-v1'),
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  principal_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'superseded')),
  client_family TEXT NOT NULL,
  routing_aliases_json TEXT NOT NULL DEFAULT '[]',
  oauth_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  FOREIGN KEY (account_id) REFERENCES auth_accounts(account_id),
  FOREIGN KEY (tenant_id) REFERENCES auth_tenants(tenant_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_connection_principals_principal
  ON auth_connection_principals (realm, principal_id);

CREATE INDEX IF NOT EXISTS idx_auth_connection_principals_account
  ON auth_connection_principals (realm, account_id, status);

CREATE TABLE IF NOT EXISTS auth_token_families (
  token_family_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'cairnstone-token-family-v1'
    CHECK (schema = 'cairnstone-token-family-v1'),
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  connection_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  origin_authenticator_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'superseded')),
  authz_version INTEGER NOT NULL DEFAULT 1
    CHECK (authz_version >= 1),
  refresh_generation INTEGER NOT NULL DEFAULT 0
    CHECK (refresh_generation >= 0),
  created_at TEXT NOT NULL,
  last_rotated_at TEXT,
  revoked_at TEXT,
  superseded_by_token_family_id TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  FOREIGN KEY (connection_id) REFERENCES auth_connection_principals(connection_id),
  FOREIGN KEY (origin_authenticator_id) REFERENCES auth_authenticators(authenticator_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_token_families_principal
  ON auth_token_families (realm, principal_id, status);

CREATE INDEX IF NOT EXISTS idx_auth_token_families_connection
  ON auth_token_families (realm, connection_id, status);

CREATE TABLE IF NOT EXISTS auth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  token_family_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  authz_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (token_family_id) REFERENCES auth_token_families(token_family_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_access_tokens_family
  ON auth_access_tokens (realm, token_family_id);

CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  token_family_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  refresh_generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotated', 'revoked', 'reuse_detected')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (token_family_id) REFERENCES auth_token_families(token_family_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_family
  ON auth_refresh_tokens (realm, token_family_id, refresh_generation);

CREATE TABLE IF NOT EXISTS auth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  connection_id TEXT,
  principal_id TEXT,
  authenticator_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256'
    CHECK (code_challenge_method = 'S256'),
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  iss TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused'
    CHECK (status IN ('unused', 'used', 'expired', 'revoked')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_routing_aliases (
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  alias TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (realm, alias)
);

CREATE TABLE IF NOT EXISTS auth_cimd_cache (
  client_id TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  content_hash TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL,
  document_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_canary_admissions (
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  connection_id TEXT NOT NULL,
  client_family TEXT,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'admitted'
    CHECK (status IN ('admitted', 'revoked')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (realm, connection_id)
);

CREATE TABLE IF NOT EXISTS auth_audit_events (
  event_id TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  event_type TEXT NOT NULL,
  account_id TEXT,
  tenant_id TEXT,
  principal_id TEXT,
  connection_id TEXT,
  token_family_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0)
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_events_created
  ON auth_audit_events (realm, created_at DESC);
