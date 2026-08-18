-- 0006: V6.2.1 freshness correctness hardening.
--
-- V6.2 originally compared an accepted file stone's repository commit SHA against
-- the current branch-tip commit SHA. That produces false drift whenever some other
-- file changes. Repository commit SHA remains valuable provenance/context, but
-- path freshness must be decided by path-specific content identity.
--
-- These columns store the accepted stone's exact source-content SHA-256 and the
-- last observed GitHub file content SHA-256. Freshness checks remain read-only with
-- respect to both path_heads and chain_heads.

ALTER TABLE source_freshness ADD COLUMN accepted_content_sha256 TEXT;
ALTER TABLE source_freshness ADD COLUMN observed_content_sha256 TEXT;

CREATE INDEX IF NOT EXISTS idx_source_freshness_path_content
  ON source_freshness(chain, path, accepted_content_sha256, observed_content_sha256);
