-- V7.7.10i.1c1 — Bounded public-client DCR registry (auth_* firewall).
-- Auth-only D1 stream: migrations/auth/ → CAIRNSTONE_AUTH_DB (cairnstone-v6-auth).
--
-- Persists opaque OAuth clients registered via /oauth/register when
-- CORE_AUTH_DCR_ENABLED=true. Public PKCE only: token_endpoint_auth_method=none.
-- Never stores client_secret. DCR/CIMD must never auto-admit canary connections.
-- Legacy /mcp|/mcp/core|/mcp-b MUST NOT join this table.

CREATE TABLE IF NOT EXISTS auth_oauth_clients (
  client_id TEXT PRIMARY KEY,
  realm TEXT NOT NULL DEFAULT 'core-auth'
    CHECK (realm = 'core-auth'),
  registration_type TEXT NOT NULL DEFAULT 'dcr'
    CHECK (registration_type = 'dcr'),
  client_name TEXT,
  software_id TEXT,
  redirect_uris_json TEXT NOT NULL DEFAULT '[]',
  grant_types_json TEXT NOT NULL DEFAULT '["authorization_code"]',
  response_types_json TEXT NOT NULL DEFAULT '["code"]',
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
    CHECK (token_endpoint_auth_method = 'none'),
  application_type TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0)
);

CREATE INDEX IF NOT EXISTS idx_auth_oauth_clients_realm_status
  ON auth_oauth_clients (realm, status);
