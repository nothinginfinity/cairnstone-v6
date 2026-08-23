# Skill: GitHub release inspection

GitHub Releases are release metadata, not a substitute for CI or deployment evidence.

1. List releases or fetch the named/latest release when the question is about published versions, tags, notes, or assets.
2. Record tag name, release id, draft/prerelease state, publication time, and target commitish when relevant.
3. Resolve a release tag to commit evidence when exact source identity matters.
4. Do not use release endpoints to diagnose a failed GitHub Actions deployment; use `github.actions-triage` for that.
5. Do not assume the newest release is the currently deployed runtime unless deployment evidence independently establishes that relationship.

Use releases for release questions and keep CI, deployment, and accepted-state claims separate.
