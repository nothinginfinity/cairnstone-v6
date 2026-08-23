# Skill: GitHub branch protection inspection

Use branch-protection evidence before diagnosing why a merge or protected-branch update is blocked.

1. Identify the exact repository and branch.
2. Read the branch protection endpoint before proposing changes.
3. Inspect required status checks, review requirements, admin enforcement, restrictions, signature rules, or other returned protections relevant to the symptom.
4. If a required check is failing, follow its commit/Actions evidence rather than weakening protection by default.
5. A 404 can mean protection is not configured or the caller lacks required visibility; report the observed response rather than inventing policy.
6. Changing protection is a separate mutation requiring explicit authorization and should not be bundled into read-only diagnosis.

Prefer explaining the blocking rule and the evidence needed to satisfy it.
