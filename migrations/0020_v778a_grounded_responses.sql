-- V7.7.8a: Progressive Grounded Chat LOD — response identity + lazy LOD cache.
--
-- Operational answer-identity plane only. Does NOT participate in chain_heads /
-- path_heads / accepted project truth. Responses bind to an exact Scope /
-- authority_digest / evidence-set / claim-skeleton snapshot. Expansion never
-- mutates accepted state. Refresh creates a new response_id.

CREATE TABLE IF NOT EXISTS grounded_responses (
  response_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL,
  question TEXT NOT NULL,
  question_digest TEXT NOT NULL,
  scope_request_json TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  authority_digest TEXT NOT NULL,
  evidence_set_digest TEXT NOT NULL,
  answer_skeleton_digest TEXT NOT NULL,
  scope_snapshot_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  skeleton_json TEXT NOT NULL,
  materialized_lods_json TEXT NOT NULL DEFAULT '{}',
  highest_materialized_lod INTEGER NOT NULL DEFAULT 1
    CHECK (highest_materialized_lod >= 1 AND highest_materialized_lod <= 5),
  model TEXT,
  provider_envelope_json TEXT,
  actor_id TEXT,
  thread_id TEXT,
  code_session_id TEXT,
  parent_response_id TEXT,
  telemetry_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grounded_responses_scope_authority
  ON grounded_responses (scope_id, authority_digest, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_grounded_responses_question
  ON grounded_responses (question_digest, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_grounded_responses_parent
  ON grounded_responses (parent_response_id, created_at DESC);
