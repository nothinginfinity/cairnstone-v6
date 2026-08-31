-- V7.6.2b: operational MCP /mcp/core native-hydration session state.
-- This table is transport/runtime state only. It is NOT CairnStone accepted
-- state and is never consulted for chain_heads/path_heads authority.

CREATE TABLE IF NOT EXISTS mcp_core_sessions (
  session_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  hydrated_tool_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_core_sessions_expires_at
  ON mcp_core_sessions(expires_at);
