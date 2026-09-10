-- V7.7.5a: Shared Agent Workspace foundation (ChatGPT baseline).
--
-- Draft plane only: content-addressed R2 blobs + D1 metadata/tips.
-- Does NOT participate in chain_heads / path_heads / stones / search / Scope.
-- Ordinary Stones appear later at propose_accept freeze time (V7.7.5c).

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  github_bind_json TEXT
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('reader', 'drafter', 'proposer', 'owner')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, actor_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_actor
  ON workspace_members (actor_id, workspace_id);

-- Append-only immutable revision log. Tips point here; never UPDATE rows.
CREATE TABLE IF NOT EXISTS workspace_revisions (
  revision_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  parent_revision_id TEXT,
  content_hash TEXT NOT NULL,
  content_bytes INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
  FOREIGN KEY (parent_revision_id) REFERENCES workspace_revisions(revision_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_revisions_ws_path
  ON workspace_revisions (workspace_id, path, created_at ASC);

-- Mutable per-path tip pointer. Compare-and-swap only; no last-write-wins.
CREATE TABLE IF NOT EXISTS workspace_tips (
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
  FOREIGN KEY (revision_id) REFERENCES workspace_revisions(revision_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_tips_revision
  ON workspace_tips (revision_id);

-- Immutable tip-vector freeze for propose_accept (V7.7.5c).
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  tip_vector_json TEXT NOT NULL,
  tip_vector_digest TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_ws
  ON workspace_snapshots (workspace_id, created_at DESC);
