-- V7.7.6a: Secure workspace invitation + recipient-authenticated claim/revoke.
-- Invite records are control-plane only. Never store a live workspace bearer.

CREATE TABLE IF NOT EXISTS workspace_invites (
  invite_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  principal_actor_id TEXT NOT NULL,
  membership_role TEXT NOT NULL
    CHECK (membership_role IN ('reader', 'drafter', 'proposer', 'owner')),
  scopes_json TEXT NOT NULL,
  path_prefix TEXT,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'claimed', 'expired', 'revoked')),
  invite_fingerprint TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by TEXT,
  grant_nonce TEXT,
  grant_expires_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_invites_ws_principal
  ON workspace_invites (workspace_id, principal_actor_id, state);

CREATE INDEX IF NOT EXISTS idx_workspace_invites_state_exp
  ON workspace_invites (state, expires_at);

CREATE TABLE IF NOT EXISTS workspace_capability_denylist (
  grant_nonce TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_actor_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  revoked_by TEXT NOT NULL,
  FOREIGN KEY (invite_id) REFERENCES workspace_invites(invite_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_capability_denylist_invite
  ON workspace_capability_denylist (invite_id);
