# V6.2.1 Implementation Notes

Implemented correctness hardening before V6.3 repository reconciliation:

- Path-specific freshness now compares the accepted stone's exact content SHA-256 (derived from its immutable R2 raw key) against the observed GitHub file content SHA-256. Repository branch-tip commit SHA remains recorded as provenance/context only.
- Missing observed source for an accepted path is classified as `removed`.
- Added explicit `cairnstone_set_path_head(chain,path,hash)` semantics, which update only `path_heads` and validate that the target stone already belongs to the same chain and path.
- Clarified chain-level `cairnstone_set_head` / legacy `set_as_head` semantics so they are not confused with per-path acceptance.
- `cairnstone_create_repo_stones` now establishes per-path accepted heads for all successfully current file stones (new or reused) while preserving the orientation stone as the separate chain-level HEAD.
- GitHub-backed `cairnstone_commit_v2` now resolves mutable refs to immutable commit SHAs using the same provenance path as `cairnstone_create_github_file_stone`.
- `cairnstone_commit_v2` content dedupe is now path-scoped, preventing identical content at different paths from aliasing one path head to a stone whose canonical path belongs elsewhere.
- Migration 0006 adds accepted/observed content SHA-256 fields to `source_freshness`.

Pre-deploy validation: exact committed `src/index.js` and `src/repo-stones-runtime.js` were re-stoned from GitHub and both passed CairnStone AST lint with zero errors.
