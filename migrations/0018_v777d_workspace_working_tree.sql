-- V7.7.7d: Repo-scale persistent working tree + Git / GitZip backing.
--
-- Extends Shared Agent Workspace draft plane (0012) with:
--   - revision op / content encoding / content_ref / git_blob_sha metadata
--   - tip-side content_ref + git_blob_sha (large/binary pointers)
--   - append-only workspace_tree_ops audit (delete/rename/hydrate/batch)
--   - append-only workspace_gitzip_transport_receipts (transport only)
--
-- NEVER participates in chain_heads / path_heads / accepted project truth.
-- GitHub / GitZip remain version-control transport — not accepted-state authority.
-- Reuses existing workspace_capability + workspace_members (no second ticket).

-- Additive columns on append-only revisions (defaults preserve 5a–7c rows).
ALTER TABLE workspace_revisions ADD COLUMN op TEXT NOT NULL DEFAULT 'write';
ALTER TABLE workspace_revisions ADD COLUMN content_encoding TEXT NOT NULL DEFAULT 'utf8_text';
ALTER TABLE workspace_revisions ADD COLUMN content_ref TEXT;
ALTER TABLE workspace_revisions ADD COLUMN git_blob_sha TEXT;
ALTER TABLE workspace_revisions ADD COLUMN rename_to_path TEXT;

-- Tip-side pointers for non-inline content (body stays out of MCP JSON).
ALTER TABLE workspace_tips ADD COLUMN content_encoding TEXT NOT NULL DEFAULT 'utf8_text';
ALTER TABLE workspace_tips ADD COLUMN content_ref TEXT;
ALTER TABLE workspace_tips ADD COLUMN git_blob_sha TEXT;

-- Append-only tree operation receipts (coordination / audit; not accepted state).
CREATE TABLE IF NOT EXISTS workspace_tree_ops (
  op_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  op TEXT NOT NULL
    CHECK (op IN ('delete', 'rename', 'hydrate', 'content_ref', 'set_github_transport', 'tree_diff')),
  actor_id TEXT NOT NULL,
  from_path TEXT,
  to_path TEXT,
  base_revision_id TEXT,
  result_revision_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_tree_ops_ws
  ON workspace_tree_ops (workspace_id, created_at DESC);

-- GitZip / direct-byte ingress transport receipts.
-- Recording a receipt NEVER means the change is accepted or deployed.
CREATE TABLE IF NOT EXISTS workspace_gitzip_transport_receipts (
  receipt_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  code_session_id TEXT,
  actor_id TEXT NOT NULL,
  proposal_snapshot_id TEXT,
  gitzip_content_refs_json TEXT NOT NULL DEFAULT '[]',
  expected_base_sha TEXT,
  observed_commit_sha TEXT,
  working_branch TEXT,
  transport_status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (transport_status IN ('recorded', 'pushed', 'failed', 'superseded')),
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_gitzip_receipts_ws
  ON workspace_gitzip_transport_receipts (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_gitzip_receipts_session
  ON workspace_gitzip_transport_receipts (code_session_id, created_at DESC);
