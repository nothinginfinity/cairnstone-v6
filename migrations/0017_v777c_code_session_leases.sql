-- V7.7.7c: Multi-agent awareness + short renewable task/path leases.
--
-- Operational coordination hints only. Does NOT participate in chain_heads /
-- path_heads / accepted project truth. Leases are NOT locks and are never
-- accepted-state authority. Hard path correctness remains workspace CAS.
-- Reuses Shared Agent Workspace + V7.7.6 workspace_capability (no second ticket).
--
-- Liveness is expires_at vs server now (+ explicit lease_id / status).
-- Timestamps (acquired_at / renewed_at) are informational for currentness.
-- Stale/expired leases never block indefinitely.

CREATE TABLE IF NOT EXISTS code_session_leases (
  lease_id TEXT PRIMARY KEY,
  code_session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  task_id TEXT,
  path_prefix_json TEXT NOT NULL DEFAULT '[]',
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  checkpoint_id TEXT,
  session_revision INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (code_session_id) REFERENCES code_sessions(code_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_code_session_leases_session_expires
  ON code_session_leases (code_session_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_code_session_leases_live
  ON code_session_leases (code_session_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_code_session_leases_actor
  ON code_session_leases (code_session_id, actor_id, status);
