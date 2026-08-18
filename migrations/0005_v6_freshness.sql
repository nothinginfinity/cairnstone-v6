-- 0005: V6.2 accepted-state vs observed-source freshness model.
-- Tracks two independent signals per (chain, path): the accepted-state HEAD (path_heads,
-- unchanged -- semantic, curated by cairnstone_set_head or a stone's set_as_head flag) and
-- the last-observed GitHub source state (checkSourceFreshnessFromBody in src/index.js).
--
-- This table is written ONLY by explicit freshness checks. It never feeds back into
-- path_heads/chain_heads -- reconciliation stays read-only with respect to canonical HEAD,
-- by design. Accepting a new source state remains a deliberate, separate action
-- (cairnstone_set_head, or stoning + linking a new version).

CREATE TABLE IF NOT EXISTS source_freshness (
  chain TEXT NOT NULL,
  path TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  checked_ref TEXT NOT NULL,
  observed_commit_sha TEXT,
  observed_at TEXT NOT NULL,
  accepted_stone_hash TEXT,
  accepted_commit_sha TEXT,
  drift INTEGER NOT NULL,
  drift_reason TEXT,
  PRIMARY KEY (chain, path)
);

CREATE INDEX IF NOT EXISTS idx_source_freshness_drift ON source_freshness(drift);
