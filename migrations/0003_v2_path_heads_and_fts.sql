-- 0003: CairnStone V6 surface (v2 tools) schema.
-- Applied to production 2026-07-04 directly via the D1 query API (idempotent);
-- committed here for documentation and fresh-environment sync.

CREATE TABLE IF NOT EXISTS path_heads (
  chain TEXT NOT NULL,
  path TEXT NOT NULL,
  head_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain, path)
);

CREATE VIRTUAL TABLE IF NOT EXISTS refs_fts USING fts5(
  ref_id UNINDEXED,
  stone_hash UNINDEXED,
  chain UNINDEXED,
  path,
  keywords,
  preview
);

-- Full rebuild of the FTS index from refs (idempotent as a pair:
-- safe to re-run, never duplicates rows).
DELETE FROM refs_fts;
INSERT INTO refs_fts (ref_id, stone_hash, chain, path, keywords, preview)
SELECT r.ref_id, r.stone_hash, COALESCE(s.chain_hash, ''), r.path,
       COALESCE(r.keywords, ''), COALESCE(r.preview, '')
FROM refs r LEFT JOIN stones s ON s.hash = r.stone_hash;
