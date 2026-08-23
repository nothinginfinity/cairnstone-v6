# Skill: GitHub pull request triage

Use pull-request evidence in layers instead of jumping directly to a merge recommendation.

1. Identify the PR by repository and pull number, or list open PRs when the number is unknown.
2. Read the PR state, base/head branches, mergeability fields when available, and the head commit SHA.
3. Inspect changed files when the question concerns scope or code impact.
4. Inspect commit/check evidence for the PR head when the question concerns CI, required checks, or merge readiness.
5. If a check failed, hand off to `github.actions-triage` for workflow-run and job evidence rather than treating the PR surface as the CI log source.
6. Distinguish "GitHub says mergeable" from "project policy says approved"; branch protection, reviews, and external acceptance may impose additional gates.

Default to read-only investigation unless mutation was explicitly authorized.
