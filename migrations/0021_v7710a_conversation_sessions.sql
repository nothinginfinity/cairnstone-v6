-- V7.7.10a: Durable Conversation Session operational state.
--
-- Operational continuity plane only. Does NOT participate in chain_heads /
-- path_heads / accepted project truth. Conversation history must never be
-- bulk-promoted into project memory. accepted_state_authority is always false
-- (enforced in application responses; CHECK below for the column default).
--
-- Lean forward-compatible hooks only for access_grant_ids / typed object refs /
-- task_run_ids. Full grant CRUD, attachment resolvers, intent router, context
-- packs, Task Run dispatch, and Durable Objects are later 10b–f slices.

CREATE TABLE IF NOT EXISTS conversation_sessions (
  conversation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'closed', 'superseded')),
  message_log_json TEXT NOT NULL DEFAULT '[]',
  attachment_set_json TEXT NOT NULL DEFAULT '[]',
  active_scope_json TEXT,
  selected_actors_json TEXT NOT NULL DEFAULT '[]',
  selected_repo TEXT,
  selected_chain TEXT,
  code_session_id TEXT,
  last_response_ids_json TEXT NOT NULL DEFAULT '[]',
  routing_envelope_json TEXT,
  tool_receipts_json TEXT NOT NULL DEFAULT '[]',
  intent_mode TEXT NOT NULL DEFAULT 'read'
    CHECK (intent_mode IN ('read', 'compare', 'propose-action')),
  access_grant_ids_json TEXT NOT NULL DEFAULT '[]',
  task_run_ids_json TEXT NOT NULL DEFAULT '[]',
  workspace_id TEXT,
  session_revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_state_authority INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_state_authority = 0)
);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_created_by
  ON conversation_sessions (created_by, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_status
  ON conversation_sessions (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_code_session
  ON conversation_sessions (code_session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_workspace
  ON conversation_sessions (workspace_id, updated_at DESC);

-- Append-only durable turn identity. Never mutated after insert.
CREATE TABLE IF NOT EXISTS conversation_turns (
  turn_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('user', 'assistant', 'system', 'tool', 'operational')),
  turn_type TEXT NOT NULL DEFAULT 'message',
  content_ref TEXT,
  content_preview TEXT,
  response_ids_json TEXT NOT NULL DEFAULT '[]',
  context_pack_id TEXT,
  tool_receipt_refs_json TEXT NOT NULL DEFAULT '[]',
  attachment_refs_json TEXT NOT NULL DEFAULT '[]',
  access_grant_ids_json TEXT NOT NULL DEFAULT '[]',
  object_refs_json TEXT NOT NULL DEFAULT '[]',
  task_run_ids_json TEXT NOT NULL DEFAULT '[]',
  routing_envelope_json TEXT,
  intent_mode TEXT
    CHECK (intent_mode IS NULL OR intent_mode IN ('read', 'compare', 'propose-action')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation_sessions(conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_conversation
  ON conversation_turns (conversation_id, seq ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turns_message_id
  ON conversation_turns (message_id);
