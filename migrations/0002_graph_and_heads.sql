-- Graph edges + HEAD pointers: turns the flat parent_hash/related-in-JSON model into
-- a queryable relationship graph, so the vault stays navigable past thousands of stones.
CREATE TABLE IF NOT EXISTS stone_edges (
  id TEXT PRIMARY KEY,
  from_hash TEXT NOT NULL,
  to_hash TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON stone_edges(from_hash);
CREATE INDEX IF NOT EXISTS idx_edges_to ON stone_edges(to_hash);
CREATE INDEX IF NOT EXISTS idx_edges_type ON stone_edges(edge_type);

-- edge_type vocabulary (enforced in application code, not a SQL CHECK constraint):
--   supersedes  - this stone replaces another as the canonical version of the same artifact
--   patches     - this stone documents/contains a fix for a problem found in another
--   documents   - an orientation/summary stone describing a set of other stones
--   reviews     - a review-report stone evaluating another stone
--   references  - generic/loose relationship (default for migrated or ambiguous links)

CREATE TABLE IF NOT EXISTS chain_heads (
  chain TEXT PRIMARY KEY,
  head_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
