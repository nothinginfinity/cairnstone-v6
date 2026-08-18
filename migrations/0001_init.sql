CREATE TABLE IF NOT EXISTS stones (
  hash TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  repo TEXT,
  commit_sha TEXT,
  parent_hash TEXT,
  chain_hash TEXT,
  raw_key TEXT NOT NULL,
  stone_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refs (
  ref_id TEXT PRIMARY KEY,
  stone_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  keywords TEXT NOT NULL,
  preview TEXT NOT NULL,
  raw_key TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refs_stone_hash ON refs(stone_hash);
CREATE INDEX IF NOT EXISTS idx_refs_keywords ON refs(keywords);
CREATE INDEX IF NOT EXISTS idx_refs_path ON refs(path);
CREATE INDEX IF NOT EXISTS idx_stones_created_at ON stones(created_at);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  stone_hash TEXT NOT NULL,
  original_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  ratio REAL NOT NULL,
  strategy TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_events (
  id TEXT PRIMARY KEY,
  stone_hash TEXT,
  ref_id TEXT,
  query TEXT,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
