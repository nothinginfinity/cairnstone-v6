-- V7.3.3 — repair tool_authorizations schema collision from duplicate 0009 migrations.
--
-- Two different 0009 migrations were historically applied. The singular-name
-- migration created the original lifecycle schema first; the plural-name
-- migration then used CREATE TABLE IF NOT EXISTS and could not replace it.
-- Preserve the legacy table for forensic inspection, remove its conflicting
-- indexes, and create the schema expected by src/tool-authorization.js.
--
-- This migration is intentionally monotonic: do not rewrite either applied
-- 0009 migration.

DROP INDEX IF EXISTS idx_tool_authorizations_status;
DROP INDEX IF EXISTS idx_tool_authorizations_tool;
DROP INDEX IF EXISTS idx_tool_authorizations_request_stone;

ALTER TABLE tool_authorizations RENAME TO tool_authorizations_v733_legacy;

CREATE TABLE tool_authorizations (
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

CREATE INDEX idx_tool_authorizations_status
  ON tool_authorizations(status, updated_at);

CREATE INDEX idx_tool_authorizations_request_stone
  ON tool_authorizations(request_stone_hash);
