# CairnStone V6 Roadmap

CairnStone v6 is an isolated successor to v5 (`nothinginfinity/cairnstone-v5`,
baseline `455e8a795271cc2941bac2aa8f254ede8b7df862`). v5 remains the
production baseline throughout this roadmap and must never be mutated,
deployed over, migrated, or bound to by any v6 work.

Architectural constraints that apply across every phase below:

- Canonical CairnStone HEAD remains a semantic/accepted-state pointer, not a
  Git HEAD mirror.
- Source freshness (what's actually in GitHub right now) is tracked
  independently of accepted-state HEAD.
- Reconciliation against live source must never automatically advance
  canonical HEAD — that's an explicit, separate action.
- Exact source identifiers (owner/repo/path/commit_sha) use structured
  indexed columns, not fuzzy FTS matching.
- Multiple stones may legitimately reference the same Git commit (e.g. a
  file stone and a later review stone both pointing at the same commit).
- Stoning is deliberate, not automatic — v6 does not stone every commit on
  every push.
- v6 uses fully independent storage (D1 `cairnstone-v6`, R2
  `cairnstone-v6-raw`) from v5's `cairnstone-v5` / `cairnstone-v5-raw`.
- v5 hashes, edges, and HEAD semantics remain import-compatible so a future
  v5-vault import (V6.7) doesn't require reshaping already-stoned data.

v5 already carries `repo` and `commit_sha` columns and migration
`0003_v2_path_heads_and_fts.sql` (labeled in-repo as "CairnStone V6 surface
(v2 tools) schema" — applied to v5 production 2026-07-04, adding
`path_heads` and an FTS5 `refs_fts` virtual table). That work is reused as
the starting point for v6's own schema rather than reinvented from scratch.

## V6.0 — Clone + isolation (this slice)

- Seed `nothinginfinity/cairnstone-v6` from v5 baseline SHA
  `455e8a795271cc2941bac2aa8f254ede8b7df862`.
- Prove source equivalence (git tree-hash identity) before any semantic
  change.
- Independent deployment identity: Worker `cairnstone-v6`, D1
  `cairnstone-v6`, R2 `cairnstone-v6-raw`, separate deploy workflow,
  separate MCP endpoint/connector.
- No provenance/freshness architecture yet — bootstrap only, inherited
  behavior preserved.

## V6.1 — First-class provenance + deterministic (repo, commit) lookup

- Every stone created from a GitHub source records `repo`, `path`,
  `commit_sha` as structured, indexed fields (already columns in v5;
  formalize as the primary lookup key in v6, not a side attribute).
- Add a deterministic lookup path: given (repo, path, commit_sha), resolve
  directly to the covering stone(s) without FTS.
- Multiple stones per commit remains explicitly legal (e.g. file stone +
  later review stone on the same commit) — the lookup returns a set, not a
  single row.

## V6.2 — Accepted-state vs observed-source freshness model

- Track two independent signals per (chain, path): the accepted-state HEAD
  (semantic, human/agent-curated) and the observed-source state (what
  GitHub's default branch currently has at that path).
- Surface drift between the two without acting on it automatically.
- No change to HEAD semantics from v5 — this only adds a parallel
  freshness signal.

## V6.3 — `cairnstone_reconcile_repo`

- New tool: given a chain (repo), walk current GitHub source, compare
  against V6.2's freshness model, and report drift (added/changed/removed
  paths vs last-known stones).
- Reconciliation is read-only with respect to HEAD: it never advances
  canonical HEAD automatically. Any HEAD update stays a deliberate,
  separate `cairnstone_set_head` call.
- Output should be actionable: a list of (path, current stone hash,
  observed commit_sha, drift type) tuples, not a prose summary.

## V6.4 — Deterministic chain resume/orientation

- Formalize the "first-turn checklist" pattern (manifest → HEAD → edges)
  as a single deterministic tool response, incorporating V6.1's structured
  provenance so orientation doesn't depend on lod5 prose parsing.
- Target: a fresh chat can resume exact prior state from one call, with no
  ambiguity from timestamp-ordering.

## V6.5 — Search/index hardening

- Build on v5's `refs_fts` (FTS5) approach; address the "single-keyword,
  weak on multi-word phrases" limitation noted in `cairnstone_search`.
- Evaluate ranking quality (bm25 tuning) and multi-term phrase handling
  specifically, since that's the documented weak spot inherited from v5.

## V6.6 — MCP capability/catalog consistency

- Ensure v6's MCP tool catalog (`tools/list`) stays consistent with what's
  actually implemented and enabled, addressing the known
  `tool_search`-lags-registration gotcha from the wider AFO ecosystem —
  verify via direct `tools/list` JSON-RPC, not just catalog presence.

## V6.7 — v5 vault import/migration compatibility

- Build an explicit, reviewable import path for pulling v5 stones/edges
  into v6 storage, preserving v5 hash/edge/HEAD semantics so imported data
  behaves identically to natively-created v6 data.
- This is an opt-in migration tool, not an automatic sync — v5 stays
  authoritative and untouched unless/until an explicit import is run.

## V6.8 — Cross-model/client production acceptance

- Verify v6 MCP behavior across the actual client surfaces in use
  (Claude connector, direct JSON-RPC curl, any other MCP client), matching
  the verification discipline already applied to v5 (e.g. the MCP
  handshake/session-id fix that was v5's last baseline commit).
- Only after this phase does v6 become a candidate to be treated as
  canonical for new work — v5 remains authoritative until an explicit,
  separate decision is made to shift default usage.
