-- 0007: V6.5 search/index hardening.
-- Applied to production 2026-08-18 directly via the D1 query API (idempotent
-- as a drop+rebuild pair, same pattern as migration 0003); committed here for
-- documentation and fresh-environment sync.
--
-- Two problems addressed:
--
-- 1. Tokenizer bug: the default unicode61 tokenizer treats "_" as a
--    separator (Unicode category Pc, "connector punctuation"), so an
--    identifier like "chain_heads" or "cairnstone_resume_chain" was
--    indexed as two separate tokens ("chain"/"heads"). Since this vault's
--    content is overwhelmingly source code and structured identifiers
--    (extractKeywords() in src/index.js already treats `[a-z0-9_]{3,}` as
--    a single keyword), splitting on underscore silently broke exact
--    identifier search and phrase matching for the vault's most common
--    query shape. Fixed via `tokenchars '_'`, verified live: a phrase
--    query for "commit_sha" only matches refs whose keywords contain that
--    exact identifier, not any ref containing "commit" or "sha" alone.
--
-- 2. No column weighting: cairnstone_find_v2 previously called bm25(refs_fts)
--    with no weight arguments, so a raw-text hit in `preview` scored
--    identically to a hit in the curated `keywords` column, even though
--    keywords are a much higher-precision relevance signal (they're the
--    per-ref top-12 extracted terms, not arbitrary prose). Fixed in
--    application code (src/index.js findV2FromBody) by passing explicit
--    per-column weights: bm25(refs_fts, 0, 0, 0, 2.0, 4.0, 1.0) -- the
--    first three 0-weights are required placeholders for the UNINDEXED
--    ref_id/stone_hash/chain columns (bm25's weight arguments map 1:1 to
--    ALL table columns in declaration order, not just indexed ones; too
--    few arguments silently defaults the remaining columns to weight 1.0,
--    which would have made the fix a silent no-op if the UNINDEXED
--    placeholders were omitted -- verified against live D1 before commit).

DROP TABLE IF EXISTS refs_fts;

CREATE VIRTUAL TABLE refs_fts USING fts5(
  ref_id UNINDEXED,
  stone_hash UNINDEXED,
  chain UNINDEXED,
  path,
  keywords,
  preview,
  tokenize = "unicode61 tokenchars '_'"
);

-- Full rebuild of the FTS index from refs (idempotent as a pair:
-- safe to re-run, never duplicates rows).
INSERT INTO refs_fts (ref_id, stone_hash, chain, path, keywords, preview)
SELECT r.ref_id, r.stone_hash, COALESCE(s.chain_hash, ''), r.path,
       COALESCE(r.keywords, ''), COALESCE(r.preview, '')
FROM refs r LEFT JOIN stones s ON s.hash = r.stone_hash;
