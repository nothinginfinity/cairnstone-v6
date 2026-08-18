-- 0004: V6.1 first-class provenance -- structured (repo, path, commit_sha) lookup.
-- commit_sha now stores a real resolved git commit SHA (see resolveGitHubCommit in
-- src/index.js), not a mutable ref name like "main". This migration adds a first-class
-- `path` column to `stones` so (repo, path, commit_sha) lookups run as a direct indexed
-- SQL match -- no JSON parsing of stone_json, no FTS involved.

ALTER TABLE stones ADD COLUMN path TEXT;

-- Backfill any pre-existing rows from stone_json (safe no-op if the vault is still empty).
UPDATE stones SET path = json_extract(stone_json, '$.border.path') WHERE path IS NULL;

CREATE INDEX IF NOT EXISTS idx_stones_repo_path_commit ON stones(repo, path, commit_sha);
CREATE INDEX IF NOT EXISTS idx_stones_repo_path ON stones(repo, path);
