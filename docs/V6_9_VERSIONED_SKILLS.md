# V6.9 — Version-Controlled Skills + Progressive Skill Resolution

V6.9 separates four AI harness layers: instructions, skills, tools, and accepted memory/state.

## Authority model

- GitHub is the editable source of truth for skill files under `skills/`.
- `skills/manifest.json` is the compact discovery/index layer.
- CairnStone chain `cairnstone-v6-skills` is the acceptance layer.
- Each active skill is selected by the `(chain,path)` CairnStone path HEAD, not by Git `main`.
- The selected stone must carry an immutable 40-hex Git commit SHA. The runtime fetches that exact Git revision when loading the skill.
- A newer edit may exist on `main` without becoming active until explicitly stoned and promoted.

## Progressive loading

A client starts with the operating guide and the boot skill (`core.orient`). It calls `cairnstone_resolve_skills` with the current task, tool catalog, and already-loaded skill IDs. The deterministic resolver scores compact manifest metadata and returns the smallest relevant set. The client then calls `cairnstone_get_skill` only for the skills it actually needs.

This keeps 50+ possible skills cheap: catalog metadata stays compact while full skill bodies are disclosed only when useful.

## Accepted catalog evolution

The first V6.9 accepted catalog contained three foundational CairnStone skills plus two migrated AFO GitHub skills:

- `core.orient`
- `core.choose-tools`
- `core.verify-live-state`
- `github.actions-triage`
- `github.actions-job-logs`

V6.9.2 grows that catalog deliberately to 15 accepted skills. The additional ten are:

- `github.repo-file-read`
- `github.pull-request-triage`
- `github.commit-evidence`
- `github.release-inspection`
- `github.branch-protection-inspection`
- `github.workflow-dispatch-safety`
- `cairnstone.source-freshness`
- `cairnstone.repo-reconcile`
- `cairnstone.skill-acceptance`
- `cairnstone.project-handoff`

The two original GitHub Actions skills preserve field-tested guidance from the AFO GitHub MCP, while Git + CairnStone remain the canonical versioned source for the full catalog.

## MCP surface

- `cairnstone_list_skills` — compact catalog metadata only.
- `cairnstone_get_skill` — load one accepted skill at its immutable Git commit.
- `cairnstone_get_skill_bundle` — V6.9.1 provenance-bearing distribution bundle for accepted skills and downstream caches.
- `cairnstone_lint_skills` — V6.9.2 accepted-state catalog QA; read-only and deterministic.
- `cairnstone_resolve_skills` — deterministic task-to-skill recommendations; no execution authority.

## V6.9.2 QA and acceptance protocol

The same pure catalog linter is used in two contexts:

1. **Candidate Git QA:** `npm run lint:skills` reads `skills/manifest.json` and every referenced `SKILL.md` before deployment/acceptance. Hard errors fail CI.
2. **Accepted-state QA:** `cairnstone_lint_skills` reads the accepted manifest/path HEAD state and verifies immutable accepted source plus catalog invariants.

The linter checks duplicate IDs/paths, semantic versions, canonical paths, dependencies/cycles, declared tool references, boot integrity, file/body size budgets, trigger collisions, and accepted path HEAD completeness. Manifest v2 includes a `tool_registry` for deterministic `requires_tools` validation.

Catalog activation is deliberately staged: commit one immutable candidate; accept every changed/new skill path HEAD first; verify them; move `skills/manifest.json` last. If work stops before the final manifest move, the old accepted catalog remains canonical.

## V6.10 boundary

The Skills Sub-Agent remains deferred until a healthy deterministic corpus demonstrates real routing ambiguity. It may later sit above the deterministic resolver as an ambiguity/fallback layer, but it must never replace accepted-state selection, bypass QA, select mutable/unaccepted skill versions, or grant execution authority.
