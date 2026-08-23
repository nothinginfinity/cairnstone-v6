# Skill: GitHub repository file read

Use this skill when the task depends on the actual contents of a file in a GitHub repository.

1. Establish the exact owner, repository, path, and intended ref. Do not silently switch repositories or branches.
2. Prefer the narrow Contents API read for a known path. Use OpenAPI search only when the endpoint shape is uncertain.
3. Preserve the returned blob SHA and the requested/ref context as evidence. When an immutable commit is required, resolve the branch or tag to a full commit SHA before treating it as provenance.
4. Treat a 404 as evidence that the path/ref combination was not found; do not replace it with a fuzzy repository search unless the user actually asked to discover a path.
5. For source-review or patch work, re-read or use a SHA guard before mutation so stale content is not overwritten.

This skill is read-first. It does not grant mutation authority.
