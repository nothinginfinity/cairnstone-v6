-- V7.7.7e: Reconstructable execution environment + disposable sandbox attachment.
--
-- Provider-neutral environment manifests, sandbox attachment records, and
-- immutable sandbox-local execution receipts. Operational / reconstructability
-- plane only — NEVER participates in chain_heads / path_heads / accepted project
-- truth. Sandbox-local execution is NOT production/infrastructure mutation
-- authority. Reuses existing workspace_capability + workspace_members (no second
-- ticket). Never stores raw provider credentials / API keys / bearers / secrets.

-- Additive pointer on durable Code Sessions for latest sandbox attachment.
ALTER TABLE code_sessions ADD COLUMN latest_sandbox_attachment_id TEXT;

-- Immutable-ish environment manifests (append-only create; CAS attach to session).
CREATE TABLE IF NOT EXISTS environment_manifests (
  environment_manifest_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  code_session_id TEXT,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  sandbox_execution_class TEXT NOT NULL DEFAULT 'none'
    CHECK (sandbox_execution_class IN ('none', 'local_build_test', 'local_install_build_test')),
  secrets_absent INTEGER NOT NULL DEFAULT 1
    CHECK (secrets_absent = 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_environment_manifests_ws
  ON environment_manifests (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_environment_manifests_session
  ON environment_manifests (code_session_id, created_at DESC);

-- Disposable sandbox attachment records (replaceable compute only).
CREATE TABLE IF NOT EXISTS code_session_sandbox_attachments (
  attachment_id TEXT PRIMARY KEY,
  code_session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  environment_manifest_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  adapter_profile_id TEXT,
  status TEXT NOT NULL DEFAULT 'attached'
    CHECK (status IN ('attached', 'hydrating', 'ready', 'executing', 'detached', 'failed', 'destroyed')),
  detail_json TEXT NOT NULL DEFAULT '{}',
  attached_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detached_at TEXT,
  secrets_absent INTEGER NOT NULL DEFAULT 1
    CHECK (secrets_absent = 1),
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_attachments_session
  ON code_session_sandbox_attachments (code_session_id, attached_at DESC);

CREATE INDEX IF NOT EXISTS idx_sandbox_attachments_ws
  ON code_session_sandbox_attachments (workspace_id, attached_at DESC);

-- Immutable sandbox-local execution receipts (evidence of what ran).
-- Recording a receipt NEVER means deploy/merge/accepted-state.
CREATE TABLE IF NOT EXISTS code_session_execution_receipts (
  receipt_id TEXT PRIMARY KEY,
  code_session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  environment_manifest_id TEXT,
  sandbox_attachment_id TEXT,
  actor_id TEXT NOT NULL,
  command_class TEXT NOT NULL
    CHECK (command_class IN ('install', 'build', 'test', 'lint', 'other_local')),
  command_summary TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pass', 'fail', 'error', 'timeout', 'cancelled')),
  exit_code INTEGER,
  duration_ms INTEGER,
  tip_vector_digest TEXT,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  log_ref TEXT,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  secrets_absent INTEGER NOT NULL DEFAULT 1
    CHECK (secrets_absent = 1),
  production_mutation INTEGER NOT NULL DEFAULT 0
    CHECK (production_mutation = 0),
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_execution_receipts_session
  ON code_session_execution_receipts (code_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_receipts_ws
  ON code_session_execution_receipts (workspace_id, created_at DESC);
