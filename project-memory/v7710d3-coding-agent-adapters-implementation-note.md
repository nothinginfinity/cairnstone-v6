# V7.7.10d.3 — Gated coding-agent adapters (GitHub Copilot + Cursor Cloud)

**Status:** source + mocked tests landed. No production deploy. No secrets provisioned. Seed registry availability remains `stub` until operator configures secrets **and** live probe evidence succeeds.

**Runtime VERSION:** `0.5.44` (source bump; deploy not authorized by this slice).

## What landed

- `src/coding-agent-common.js` — shared secret names, scrubbing, SHA/repo parsing, HTTP retries, status maps, concurrency gate
- `src/github-copilot-adapter.js` — GitHub **Agent Tasks** REST (`POST/GET /agents/repos/{owner}/{repo}/tasks`); cancel unsupported by GitHub API (local cancel only)
- `src/cursor-cloud-adapter.js` — Cursor **Cloud Agents API v1** (`POST /v1/agents`, run status, cancel); idempotent `agentId` from task_run_id
- `src/executor-adapters.js` — live path when Worker token present; else dry-run stub; never claims stub as live
- `src/executor-profile.js` — `executorHealthAsync` overlays probe evidence
- `src/task-run.js` — persist compact `extjob:…` artifact refs; status poll; provider cancel when supported
- `test/v7710d3-coding-agent-adapters.test.js` — mocked HTTP coverage

## Guardrails preserved

- `human_commit:true` + `committed_by` still required for dispatch
- Immutable 40-hex base SHA required for **live** coding-agent dispatch
- Restricted repo (+ branch/startingRef) via Worker env allowlists
- Fail closed on missing token (live API), permission denial, stale SHA
- No auto-merge, no deploy, no HEAD moves, no secret logging

## Operator secrets (NAMES only)

See PR checklist. Adapters stay stub/blocked until tokens + allowlists + successful health probe.
