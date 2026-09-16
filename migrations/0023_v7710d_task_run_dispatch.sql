-- V7.7.10d: Expand cairnstone-task-run-v1 for dispatchable async status + route receipts.
--
-- Operational D1 only. Does NOT participate in chain_heads / path_heads /
-- accepted project truth. accepted_state_authority remains 0 always.
-- Rebuilds task_runs to widen status/dispatch_state CHECKs (SQLite cannot
-- ALTER CHECK). Legacy rows preserved via rename + copy.

ALTER TABLE task_runs RENAME TO task_runs_v7710b_legacy;

CREATE TABLE IF NOT EXISTS task_runs (
  task_run_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'cairnstone-task-run-v1'
    CHECK (schema = 'cairnstone-task-run-v1'),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'queued', 'running', 'completed', 'failed', 'cancelled')),
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
    CHECK (dispatch_state IN (
      'not_dispatched', 'dispatched', 'running', 'completed', 'failed', 'cancelled'
    )),
  selected_executor_id TEXT,
  executor_route_reason TEXT,
  required_capabilities_json TEXT NOT NULL DEFAULT '[]',
  policy_preset TEXT,
  budget_envelope_json TEXT,
  parent_task_run_id TEXT,
  child_task_run_ids_json TEXT NOT NULL DEFAULT '[]',
  delegation_depth INTEGER NOT NULL DEFAULT 0
    CHECK (delegation_depth >= 0 AND delegation_depth <= 8),
  route_receipt_id TEXT,
  route_receipt_json TEXT,
  adapter_job_id TEXT,
  receipt_refs_json TEXT NOT NULL DEFAULT '[]',
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  pr_refs_json TEXT NOT NULL DEFAULT '[]',
  test_refs_json TEXT NOT NULL DEFAULT '[]',
  result_summary TEXT,
  failure_reason TEXT,
  human_committed_by TEXT,
  human_committed_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0)
);

INSERT INTO task_runs (
  task_run_id, schema, status, conversation_id, parent_turn_id, requested_by,
  assignee_actor_id, requested_intent, intent_mode, attachment_refs_json,
  object_refs_json, note, dispatch_state, selected_executor_id,
  created_at, updated_at, cancelled_at, accepted_state_authority
)
SELECT
  task_run_id, schema, status, conversation_id, parent_turn_id, requested_by,
  assignee_actor_id, requested_intent, intent_mode, attachment_refs_json,
  object_refs_json, note, dispatch_state, selected_executor_id,
  created_at, updated_at, cancelled_at, accepted_state_authority
FROM task_runs_v7710b_legacy;

CREATE INDEX IF NOT EXISTS idx_task_runs_requested_by
  ON task_runs (requested_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_runs_assignee
  ON task_runs (assignee_actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_runs_conversation
  ON task_runs (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_runs_status
  ON task_runs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_runs_dispatch_state
  ON task_runs (dispatch_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_runs_parent
  ON task_runs (parent_task_run_id, created_at DESC);

-- Inspectable operational route receipts (not accepted-state authority).
CREATE TABLE IF NOT EXISTS executor_route_receipts (
  route_receipt_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'cairnstone-executor-route-receipt-v1'
    CHECK (schema = 'cairnstone-executor-route-receipt-v1'),
  task_run_id TEXT,
  actor_id TEXT,
  selected_executor_id TEXT,
  selection_reason TEXT,
  policy_preset TEXT,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0)
);

CREATE INDEX IF NOT EXISTS idx_executor_route_receipts_task_run
  ON executor_route_receipts (task_run_id, created_at DESC);
