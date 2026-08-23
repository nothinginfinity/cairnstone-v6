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

## Initial catalog

The first accepted catalog contains three foundational CairnStone skills plus two migrated AFO GitHub skills:

- `core.orient`
- `core.choose-tools`
- `core.verify-live-state`
- `github.actions-triage`
- `github.actions-job-logs`

The two GitHub skills preserve the field-tested guidance already stored in the AFO GitHub MCP's mutable R2 skill document, but Git + CairnStone now become the canonical versioned source.

## MCP surface

- `cairnstone_list_skills` — compact catalog metadata only.
- `cairnstone_get_skill` — load one accepted skill at its immutable Git commit.
- `cairnstone_resolve_skills` — deterministic task-to-skill recommendations; no execution authority.

A future Skills Sub-Agent can sit above this deterministic resolver for ambiguous tasks. It should not replace accepted-state selection or become authority for skill versions.
