# CairnStone V6.7 — V5 vault import compatibility

V6.7 adds an explicit, reviewable import path for complete CairnStone V5 chain snapshots. It is a migration mechanism, not synchronization.

## Safety model

- V5 remains authoritative and is never mutated by the V6 importer.
- There is no background, scheduled, or automatic V5-to-V6 sync.
- Preview is the default: omit `dry_run` or set it to `true`.
- Apply requires both `dry_run: false` and `confirm_import: true`.
- Destination collisions fail closed. There is no overwrite/force mode.
- The bundle must represent one graph-complete V5 chain snapshot.
- Exact V5 stone hashes, raw-object identity, ref IDs and metadata, compression receipts, typed edge IDs, path heads, and chain HEAD are preserved.
- Imported stones are inserted directly as validated V5 records. They are not recreated through the normal V6 create/commit path.
- Raw objects and non-HEAD relational state are written before the canonical chain HEAD. The HEAD is the final write.

Cloudflare D1 and R2 do not provide one shared cross-service transaction. A failure after an R2 raw-object write but before D1 completion can therefore leave an unreferenced raw object. V6.7 deliberately treats the canonical chain HEAD as the commit boundary: it is never advanced until all preceding validated writes succeed. Exact replay is idempotent and can safely complete a partially written import whose existing rows/objects match byte-for-byte.

## Tool

`cairnstone_import_v5_bundle`

Input:

- `bundle` — one `cairnstone-v5-transfer-v1` full-chain snapshot.
- `dry_run` — optional boolean; defaults to `true`.
- `confirm_import` — must be `true` for apply.

A REST equivalent is also exposed at `POST /v1/import-v5-bundle`.

## Transfer bundle

The top-level bundle contains:

- `format: "cairnstone-v5-transfer-v1"`
- `source.vault: "cairnstone-v5"`
- `source.snapshot_at`
- `chain`
- `head_hash`
- `head_updated_at`
- `source_manifest` with exact stone/edge/path-head counts, `graph_complete: true`, and matching `head_hash`
- `stones`: exact V5 stone JSON paired with `raw_content`
- `edges`: exact typed V5 graph rows
- `path_heads`: exact V5 path-head rows

The importer independently recomputes and checks V5 identity before any destination write, including raw SHA-256, stone hash seed, deterministic 80-line refs, ref IDs and metadata, receipt byte counts/ratio/identity, edge IDs, path-head membership, manifest counts, and HEAD membership.

## Extraction rule

A transfer bundle should be produced from a read-only V5 snapshot. Prefer immutable origin bytes (for example the exact GitHub commit recorded on a GitHub-backed stone) and verify those bytes against the stone's V5 raw key before import. Do not use a V5 read surface that records retrieval telemetry when the migration acceptance requires the source vault to remain unchanged.

V6.7 intentionally does not add a V5 credential, V5 service binding, or network pull path to the V6 Worker. This keeps migration opt-in and prevents accidental source coupling.

## Collision semantics

Preflight compares the destination state before writes. Any existing identity with a different immutable payload fails the whole import preview/apply, including:

- chain HEAD or HEAD timestamp
- raw object bytes
- stone row / encoded JSON fields
- ref row or ref-ID ownership
- receipt row or receipt-ID ownership
- typed edge row
- path-head row

Matching existing state is treated as replay, not collision. Derived FTS rows are rebuildable and are repaired when missing.

## Acceptance sequence

1. Snapshot V5 health and the source chain manifest.
2. Snapshot the existing V6 `cairnstone-v6` project-memory HEAD so it cannot be silently replaced.
3. Validate a small graph-complete V5 chain bundle that exercises stones, refs, at least one typed edge, path heads when present, and canonical HEAD.
4. Run `cairnstone_import_v5_bundle` as a dry run and review planned writes.
5. Apply only with explicit confirmation.
6. Verify exact stone/ref/raw/receipt/edge/path-head identity, graph completeness, canonical HEAD, read surfaces, and searchability in V6.
7. Replay the exact import and require zero new writes.
8. Exercise a destination collision with an internally valid but conflicting immutable destination row and require fail-closed/no-change behavior.
9. Re-read V5 health and the source chain manifest and require the source chain to be unchanged.
10. Re-run V6 MCP catalog/dispatcher/regression checks.

V6.8 must not begin until those live checks are complete and V6.7 is closed into the `cairnstone-v6` project-memory chain.