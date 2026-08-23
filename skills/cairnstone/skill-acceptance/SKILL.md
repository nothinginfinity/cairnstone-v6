# Skill: CairnStone skill acceptance

Canonical skills are Git-versioned source whose active authority is the CairnStone `(chain,path)` HEAD.

1. Run candidate catalog lint before acceptance. Hard errors block the catalog.
2. Commit skill files and the candidate manifest to Git and resolve that source to an immutable 40-hex commit SHA.
3. Create/accept every changed or new `SKILL.md` at that immutable commit and move each skill path HEAD first.
4. Do not move `skills/manifest.json` yet. The old accepted manifest remains authority while individual new path HEADs are prepared.
5. Verify all manifest entries have valid dependencies, tool references, canonical paths, and accepted path HEADs.
6. Accept the manifest **last** by moving its path HEAD to the Git-backed manifest stone. That single movement makes the new catalog active.
7. Run accepted-state lint and representative list/get/bundle/resolve tests after activation.
8. Mutable Git branches and downstream caches are never acceptance authority.

If acceptance is interrupted before the manifest moves, the old catalog remains canonical by design.
