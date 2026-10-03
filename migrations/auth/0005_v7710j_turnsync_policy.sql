-- V7.7.10j — account-owned TurnSync standing policy.
-- Operational authorization/preference state only. Never accepted project state.

CREATE TABLE IF NOT EXISTS auth_turnsync_policies (
  policy_id TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth',
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account', 'workspace', 'chain')),
  scope_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('on', 'off', 'ask')),
  payload_mode TEXT NOT NULL CHECK (payload_mode IN ('full_turns', 'decisions_tasks', 'summaries')),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by_principal_id TEXT NOT NULL,
  updated_by_connection_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0 CHECK (accepted_state_authority = 0),
  UNIQUE (realm, account_id, tenant_id, scope_kind, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_auth_turnsync_policy_account
  ON auth_turnsync_policies(realm, account_id, tenant_id, scope_kind, scope_key);
