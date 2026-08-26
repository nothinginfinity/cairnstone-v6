-- V7.3.3 — human-confirmed guarded mutation lifecycle.
-- Immutable request/grant/receipt evidence remains in Stones; this table is
-- only the mutable lifecycle/atomic-consumption envelope.

CREATE TABLE IF NOT EXISTS tool_authorizations (
  authorization_request_id TEXT PRIMARY KEY,
  request_stone_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  argument_digest TEXT NOT NULL,
  required_authorization TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT,
  authorization_subject TEXT,
  authorization_method TEXT,
  grant_stone_hash TEXT,
  denial_stone_hash TEXT,
  issued_at TEXT,
  expires_at TEXT,
  consumption_id TEXT,
  consumed_at TEXT,
  guard_type TEXT,
  guard_expected TEXT,
  guard_observed TEXT,
  guard_matched INTEGER,
  execution_receipt_stone_hash TEXT,
  execution_result_json TEXT,
  error_type TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_authorizations_status
  ON tool_authorizations(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_tool_authorizations_request_stone
  ON tool_authorizations(request_stone_hash);
