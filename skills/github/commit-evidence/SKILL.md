# Skill: GitHub commit evidence

Use concrete commit SHAs whenever repository identity, deployment provenance, or accepted source must be precise.

1. A mutable branch or tag name is a request target, not immutable evidence.
2. Resolve the relevant ref to a full 40-hex commit SHA using repository commit/ref evidence.
3. When comparing two states, keep the requested ref and resolved commit separate so later branch movement is visible.
4. For deployment claims, correlate the workflow run's `head_sha` with the source commit actually under discussion.
5. For CairnStone Git-backed acceptance, use only an immutable commit SHA. Never store `main` as if it were a commit.
6. If a commit cannot be resolved, fail closed on provenance-sensitive work rather than guessing from timestamps.

A timestamp can help select evidence, but it is never a substitute for commit identity.
