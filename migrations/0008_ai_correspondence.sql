-- 0008: AC1 local AI correspondence mailbox foundation.
--
-- Message content remains an immutable normal CairnStone in stones/R2.
-- This table stores only recipient-specific mutable delivery state.
-- It deliberately does not participate in chain_heads or path_heads.

CREATE TABLE IF NOT EXISTS correspondence_deliveries (
  id TEXT PRIMARY KEY,
  stone_hash TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_fingerprint TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'delivered'
    CHECK (status IN ('queued','delivered','read','acked','archived')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  read_at TEXT,
  acked_at TEXT,
  archived_at TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  FOREIGN KEY (stone_hash) REFERENCES stones(hash),
  UNIQUE (sender_id, message_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_correspondence_inbox
  ON correspondence_deliveries (recipient_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_correspondence_message
  ON correspondence_deliveries (sender_id, message_id);

CREATE INDEX IF NOT EXISTS idx_correspondence_thread
  ON correspondence_deliveries (thread_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_correspondence_stone
  ON correspondence_deliveries (stone_hash);
