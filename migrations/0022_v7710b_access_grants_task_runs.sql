-- V7.7.10b: Typed attachment support + cairnstone-access-grant-v1 + task-run proposals.
--
-- Operational D1 only. Does NOT participate in chain_heads / path_heads /
-- accepted project truth. Grants never mint capabilities or widen Scope.
-- Task runs created here are proposal stubs only (not dispatched).
-- accepted_state_authority is always false (enforced in application responses).

CREATE TABLE IF NOT EXISTS access_grants (
  grant_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'cairnstone-access-grant-v1'
    CHECK (schema = 'cairnstone-access-grant-v1'),
  object_ref TEXT NOT NULL,
  principal_actor_id TEXT NOT NULL,
  permission TEXT NOT NULL
    CHECK (permission IN ('read', 'discuss', 'execute-against')),
  grantor_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  status TEXT NOT NULL DEFAULT 'granted'
    CHECK (status IN ('granted', 'first_read', 'revoked')),
  first_read_at TEXT,
  notify INTEGER NOT NULL DEFAULT 0
    CHECK (notify IN (0, 1)),
  notify_message_id TEXT,
  notify_stone_hash TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0)
);

CREATE INDEX IF NOT EXISTS idx_access_grants_principal
  ON access_grants (principal_actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_access_grants_object_ref
  ON access_grants (object_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_access_grants_grantor
  ON access_grants (grantor_actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_access_grants_status
  ON access_grants (status, created_at DESC);

-- Proposal-only Task Run stub. Never auto-dispatched (10d/10e own dispatch).
CREATE TABLE IF NOT EXISTS task_runs (
  task_run_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'cairnstone-task-run-v1'
    CHECK (schema = 'cairnstone-task-run-v1'),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'cancelled')),
  conversation_id TEXT,
  parent_turn_id TEXT,
  requested_by TEXT NOT NULL,
  assignee_actor_id TEXT,
  requested_intent TEXT NOT NULL DEFAULT 'ask-to-work',
  intent_mode TEXT NOT NULL DEFAULT 'propose-action'
    CHECK (intent_mode = 'propose-action'),
  attachment_refs_json TEXT NOT NULL DEFAULT '[]',
  object_refs_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  dispatch_state TEXT NOT NULL DEFAULT 'not_dispatched'
    CHECK (dispatch_state = 'not_dispatched'),
  selected_executor_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0)
);

CREATE INDEX IF NOT EXISTS idx_task_runs_requested_by
  ON task_runs (requested_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_runs_assignee
  ON task_runs (assignee_actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_runs_conversation
  ON task_runs (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_runs_status
  ON task_runs (status, created_at DESC);
