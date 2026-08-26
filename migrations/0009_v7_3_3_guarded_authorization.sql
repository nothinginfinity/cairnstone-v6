-- V7.3.3 — human-confirmed guarded mutation lifecycle.
-- Immutable request/grant/receipt evidence remains in CairnStone/R2.
-- D1 stores only mutable lifecycle/atomic-consumption state plus the isolated
-- acceptance resource used to prove guards and one-time execution.

CREATE TABLE IF NOT EXISTS tool_authorizations (
  authorization_request_id TEXT PRIMARY KEY,
  request_stone_hash TEXT NOT NULL,
  package_id TEXT NOT NULL,
  request_ir_id TEXT,
  decision_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  arguments_digest TEXT NOT NULL,
  required_authorization TEXT NOT NULL,
  status TEXT NOT NULL,
  authorization_decision TEXT,
  authorization_stone_hash TEXT,
  authorization_subject TEXT,
  authorization_method TEXT,
  issued_at TEXT,
  expires_at TEXT,
  claim_id TEXT,
  claimed_at TEXT,
  execution_id TEXT,
  execution_receipt_stone_hash TEXT,
  result_json TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_authorizations_status
  ON tool_authorizations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_authorizations_tool
  ON tool_authorizations(tool_id, created_at DESC);

CREATE TABLE IF NOT EXISTS v733_acceptance_resources (
  resource_id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
