# Skill: CairnStone repository reconciliation

Use repository reconciliation when the task needs a deterministic repo-wide drift picture rather than one-file freshness.

1. Resolve the requested repository ref once to one immutable commit snapshot.
2. Call `cairnstone_reconcile_repo` with the chain and repository identity.
3. Interpret classifications separately: `added`, `changed`, `removed`, `in_sync`, and `unknown` each describe observed-vs-accepted state, not an acceptance decision.
4. Keep `include_in_sync` false for compact drift work unless a complete inventory is needed.
5. If the Git tree is truncated or repository identity is ambiguous, fail closed instead of classifying removals from incomplete evidence.
6. Reconciliation is read-only: it must not create stones or move path/chain HEADs.

Use the resulting tuples to plan bounded acceptance work, not to auto-import an entire repository.
