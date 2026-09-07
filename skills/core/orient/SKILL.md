# Skill: Canonical orientation

Use this as the boot skill for CairnStone work.

1. Read the canonical `docs/AI_OPERATING_GUIDE.md` referenced by the provider/project instructions.
2. Call `cairnstone_health` and note the live version and tool catalog; do not assume a cached connector schema is current.
3. Resume `cairnstone-v6-project-memory` with `cairnstone_resume_chain(detail="start_here")` for normal continuation. Treat the returned chain HEAD and sparse-authority identity as accepted orientation; never infer currentness from timestamps. Expand to `detail="compact"` only when accepted path-head/HEAD-edge context is needed, and to `detail="full"` only for explicit complete authority/edge inspection. If the server advertises `detail=start_here` but the client schema does not expose `detail`, report the schema mismatch and use the safest available fallback until the connector is refreshed.
4. Check **both canonical AC1 inbox planes** for the current main-session model when the client exposes correspondence tools: `<namespace>:chat` for conversation/coordination/design and `<namespace>:cairnstone-v6` for durable repo/engineering handoffs and existing work history. Inspect compact inbox metadata first and read only relevant unread messages; inbox LOD5 is coordination metadata, not accepted project state. Do not replace the durable work inbox with a `:cairnstone-v7` alias merely because the runtime is V7. Compatibility aliases are supplemental only. Correspondence transports coordination intent but never grants execution authority.
5. For multi-chain retrieval, use `cairnstone_vault_catalog` → `cairnstone_resolve_scope` → `cairnstone_find_scope`. Scope is retrieval/navigation context, never synthetic global authority. Do not assume `cairnstone_ask_scope` exists until live discovery and accepted documentation both confirm it is shipped.
6. Load specialized skills only after orientation. Prefer `cairnstone_resolve_skills` and then `cairnstone_get_skill` for the smallest useful set.

Do not mutate project state during orientation.
