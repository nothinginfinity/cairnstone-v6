-- V7.7.7a: Durable Code Session operational state.
--
-- Operational continuity plane only. Does NOT participate in chain_heads /
-- path_heads / accepted project truth. Reuses Shared Agent Workspace for the
-- draft tree and V7.7.6 workspace_capability for authorization (no second
-- ticket format).

CREATE TABLE IF NOT EXISTS code_sessions (
  code_session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_chain TEXT,
  scope_json TEXT,
  source_repos_json TEXT NOT NULL,
  base_commits_json TEXT NOT NULL,
  working_transport_json TEXT,
  tip_vector_json TEXT,
  tip_vector_digest TEXT,
  workspace_snapshot_id TEXT,
  task_ledger_json TEXT NOT NULL DEFAULT '[]',
  unresolved_issues_json TEXT NOT NULL DEFAULT '[]',
  actors_json TEXT NOT NULL DEFAULT '[]',
  environment_manifest_id TEXT,
  latest_execution_receipt_refs_json TEXT NOT NULL DEFAULT '[]',
  latest_checkpoint_id TEXT,
  checkpoint_tip_vector_digest TEXT,
  capability_policy_profile_id TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle IN ('active', 'paused', 'blocked', 'proposed', 'closed', 'superseded')),
  session_revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_code_sessions_workspace
  ON code_sessions (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_code_sessions_lifecycle
  ON code_sessions (lifecycle, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_code_sessions_chain
  ON code_sessions (project_chain, updated_at DESC);
