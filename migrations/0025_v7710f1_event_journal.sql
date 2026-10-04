-- V7.7.10f.1a: append-only semantic audit event journal.
-- Operational telemetry only. Never accepted-state authority.
CREATE TABLE IF NOT EXISTS event_journal (
  event_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_class TEXT NOT NULL DEFAULT 'semantic',
  source TEXT NOT NULL DEFAULT 'journal',
  occurred_at TEXT NOT NULL,
  actor_id TEXT,
  object_ref TEXT,
  subject_ref TEXT,
  chain_name TEXT,
  path TEXT,
  stone_hash TEXT,
  related_hash TEXT,
  from_state TEXT,
  to_state TEXT,
  lod_level TEXT,
  observed_commit_sha TEXT,
  content_sha256 TEXT,
  request_correlation_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  accepted_state_authority INTEGER NOT NULL DEFAULT 0 CHECK (accepted_state_authority = 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_event_journal_time
  ON event_journal(occurred_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_type_time
  ON event_journal(event_type, occurred_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_actor_time
  ON event_journal(actor_id, occurred_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_object_time
  ON event_journal(object_ref, occurred_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_chain_time
  ON event_journal(chain_name, occurred_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_stone_time
  ON event_journal(stone_hash, occurred_at DESC, event_id DESC);

CREATE TRIGGER IF NOT EXISTS event_journal_no_update
BEFORE UPDATE ON event_journal
BEGIN
  SELECT RAISE(ABORT, 'event_journal_append_only');
END;

CREATE TRIGGER IF NOT EXISTS event_journal_no_delete
BEFORE DELETE ON event_journal
BEGIN
  SELECT RAISE(ABORT, 'event_journal_append_only');
END;
