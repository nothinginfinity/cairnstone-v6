# V6.2.1 Correctness Hardening Acceptance

This bounded slice hardens V6.2 before V6.3 repository reconciliation.

Acceptance invariants:

1. GitHub-backed `cairnstone_commit_v2` resolves mutable refs (branch/tag) to an immutable 40-hex commit SHA for stored provenance.
2. `cairnstone_commit_v2` dedupe is path-scoped; identical content at different paths cannot alias one path head to a stone whose canonical path is another path.
3. Chain HEAD and path HEAD remain separate concepts. `cairnstone_set_path_head` updates only `path_heads`; `cairnstone_set_head` remains chain-level only.
4. `cairnstone_create_repo_stones` populates `path_heads` for every successfully current file stone (created or reused) while the repository orientation remains the chain-level HEAD.
5. Per-path freshness compares exact accepted vs observed file content identity. Repository commit SHA is provenance/context only and unrelated commits elsewhere in the repository must not produce false drift.
6. A path that existed in accepted state but is missing from observed GitHub source reports `removed`.
7. Freshness checks never mutate `path_heads` or `chain_heads`.
8. v5 remains untouched.

Live acceptance should prove a stable unchanged file remains in-sync after an unrelated repository commit, and should separately prove changed-content and removed-path drift classification without auto-accepting either state.
