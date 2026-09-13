-- V7.7.7b: Durable Code Checkpoints + append-only task ledger events.
--
-- Operational / derived plane only. Does NOT participate in chain_heads /
-- path_heads / accepted project truth. Checkpoints are immutable append-only
-- rows; session tip still holds latest_checkpoint_id + ledger snapshot via CAS.
-- Reuses Shared Agent Workspace + V7.7.6 workspace_capability (no second ticket).

CREATE TABLE IF NOT EXISTS code_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  code_session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  boundary TEXT NOT NULL
    CHECK (boundary IN (
      'handoff',
      'pause',
      'task_completion',
      'conflict_rebase',
      'test_gate',
      'proposal',
      'user_requested'
    )),
  session_revision INTEGER NOT NULL,
  tip_vector_json TEXT NOT NULL,
  tip_vector_digest TEXT NOT NULL,
  workspace_snapshot_id TEXT,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (code_session_id) REFERENCES code_sessions(code_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_code_checkpoints_session
  ON code_checkpoints (code_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_code_checkpoints_workspace
  ON code_checkpoints (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_code_checkpoints_digest
  ON code_checkpoints (payload_digest);

CREATE TABLE IF NOT EXISTS code_session_task_ledger_events (
  event_id TEXT PRIMARY KEY,
  code_session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL
    CHECK (to_state IN (
      'queued',
      'claimed',
      'active',
      'blocked',
      'review',
      'done',
      'abandoned'
    )),
  actor_id TEXT NOT NULL,
  author_id TEXT,
  note TEXT,
  session_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (code_session_id) REFERENCES code_sessions(code_session_id)
);

CREATE INDEX IF NOT EXISTS idx_code_session_task_events_session
  ON code_session_task_ledger_events (code_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_code_session_task_events_task
  ON code_session_task_ledger_events (code_session_id, task_id, created_at DESC);
