-- V7.7.10i.1c1a — DCR registration rate-limit buckets (auth_* firewall).
-- Auth-only D1 stream: migrations/auth/ → CAIRNSTONE_AUTH_DB (cairnstone-v6-auth).
--
-- Persists per-IP (or unknown) registration windows for POST /oauth/register.
-- Never put auth_* tables on shared CAIRNSTONE_DB.
-- Legacy /mcp|/mcp/core|/mcp-b MUST NOT join this table.

CREATE TABLE IF NOT EXISTS auth_dcr_rate_buckets (
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  bucket_key TEXT NOT NULL,
  window_start_iso TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
    CHECK (count >= 0),
  PRIMARY KEY (realm, bucket_key)
);

CREATE INDEX IF NOT EXISTS idx_auth_dcr_rate_buckets_window
  ON auth_dcr_rate_buckets (realm, window_start_iso);
