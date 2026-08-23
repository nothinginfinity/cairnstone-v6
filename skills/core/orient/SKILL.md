# Skill: Canonical orientation

Use this as the boot skill for CairnStone work.

1. Read the canonical `docs/AI_OPERATING_GUIDE.md` referenced by the provider/project instructions.
2. Call `cairnstone_health` and note the live version and tool catalog; do not assume a cached connector schema is current.
3. Resume `cairnstone-v6-project-memory` with `cairnstone_resume_chain`. Treat chain HEAD and path HEADs as authoritative accepted state; never infer currentness from timestamps.
4. Check AC1 correspondence when the client exposes those tools, especially when concurrent work is plausible. If the live server advertises a capability the client has not surfaced, report the schema mismatch rather than silently pretending the check happened.
5. Load specialized skills only after orientation. Prefer `cairnstone_resolve_skills` and then `cairnstone_get_skill` for the smallest useful set.

Do not mutate project state during orientation.
