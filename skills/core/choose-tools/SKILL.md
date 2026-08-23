# Skill: Deterministic tool selection

Choose tools by evidence and scope, not by name similarity.

- Prefer the narrowest read-only primitive that directly answers the question.
- For GitHub, inspect the endpoint/tool capability before invoking mutations. Use explicit file SHA or equivalent concurrency guards for writes.
- For CairnStone, prefer deterministic resume/source/path-head tools before fuzzy search or LLM synthesis.
- For code edits, dry-run anchored patches before apply whenever patching is appropriate; use atomic multi-file commits when full file contents are safely available.
- Never substitute a clone for an in-place canonical repo change unless a new repository or isolated copy is actually required.
- A tool being installed or advertised does not prove the current client exposes it. Distinguish server capability from connector-schema capability.

If a required capability is absent, stop that operation cleanly and surface the exact missing capability.
