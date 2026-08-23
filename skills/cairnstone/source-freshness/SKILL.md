# Skill: CairnStone source freshness

Freshness compares accepted CairnStone path state with observed GitHub source; it does not automatically accept the observed source.

1. Identify the chain, accepted path, GitHub owner/repo, and ref to observe.
2. Use `cairnstone_check_source_freshness` for a live content-identity comparison. Treat the repository commit SHA as provenance/context; path drift is determined by the file content identity.
3. Use `cairnstone_get_source_freshness` for the last recorded check when a new GitHub read is unnecessary.
4. Use `cairnstone_freshness_status` for a cheap chain-wide summary of recorded checks and never-checked accepted paths.
5. Report `drift_reason` explicitly. A changed, removed, or missing accepted path needs human/agent review before any path HEAD movement.
6. Never advance chain HEADs or path HEADs as a side effect of checking freshness.
