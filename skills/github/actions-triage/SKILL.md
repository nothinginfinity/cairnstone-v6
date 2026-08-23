# Skill: GitHub Actions triage

For CI or deployment questions, start with GitHub Actions evidence.

1. List recent workflow runs, scoped to the relevant workflow or branch when known.
2. Select the run by concrete commit/event/timestamp evidence, not by assumption.
3. List jobs for that run and inspect job and step `status` / `conclusion` fields.
4. Only download raw logs when step-level conclusions are insufficient.
5. Use release, commit, or repository endpoints only when the question actually requires them.
6. Confirm whether the workflow supports `workflow_dispatch` before trying to trigger it manually; many AFO deploy workflows are push-only.

This skill is the Git-versioned successor to the original mutable R2 `actions-triage` AFO GitHub skill.
