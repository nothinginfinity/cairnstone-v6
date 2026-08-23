# Skill: Verify live state

Tool success, source commit, deployment success, runtime behavior, and accepted CairnStone state are different claims. Verify the level the task actually requires.

For code/deploy work:
1. Validate syntax/tests locally or in CI.
2. Confirm the pushed commit and workflow trigger that actually applies.
3. Inspect the real run, jobs, and failing step evidence when CI fails; do not guess from a red badge.
4. After deploy success, query the live endpoint/tool catalog and exercise the changed behavior.
5. Re-stone GitHub-backed artifacts at an immutable commit SHA and explicitly promote the correct path HEADs.
6. Only then write a completion/orientation stone if the slice is accepted.

For source freshness, compare content identity; unrelated repository commits must not create false drift.
