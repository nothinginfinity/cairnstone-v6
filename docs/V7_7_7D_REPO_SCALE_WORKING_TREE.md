# V7.7.7d — Repo-scale persistent working tree + Git / GitZip backing

**Status:** in-repo implementation slice. Draft / transport plane only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. `accepted_state_authority: false` on every tree / transport response. GitHub and GitZip remain **version-control transport** — never accepted-state authority and never deploy.

**Plan stone:** `297ffc7a5894f89464f413812646763ed670c53ef6093a39e3f06355d9d1136e`  
(`project-memory/v777-persistent-code-mode-durable-multi-agent-code-sessions-plan.md` § V7.7.7d)

**Builds on:** [V7.7.7a Durable Code Session](./V7_7_7A_DURABLE_CODE_SESSION.md) + [V7.7.7b Code Checkpoints](./V7_7_7B_CODE_CHECKPOINT.md) + [V7.7.7c Task Leases](./V7_7_7C_TASK_LEASES.md)

**Reuses:** Shared Agent Workspace (V7.7.5), mailbox/invite + `workspace_capability` (V7.7.6). No second ticket format.

## What this plane is

Repo-scale **draft tips** that can point at large/binary content via `content_ref` / `git_blob_sha`, plus Git hydrate and GitZip **transport receipts**. Working branches record an **observed** tip SHA for mutable refs; source identity stays on **immutable** commit SHAs.

| Capability | Role |
|------------|------|
| `delete_draft` / `rename_draft` | CAS tip mutations + tombstone / rename revisions |
| `write_content_ref` | Tip with `content_encoding=content_ref` (no R2 body) |
| `hydrate_from_git` | Import tree from immutable 40-hex commit (skip existing; small may inline) |
| `set_github_transport` | `working_branch` + `observed_commit_sha` on `github_bind` (`transport_only:true`) |
| `tree_ls` / `tree_diff` | List + tip-vector diff (files + synthetic directories) |
| `record_gitzip_transport` | Append-only transport receipt (`gitzip_success_is_not_accepted_state`) |

## Authority invariants

1. Draft / transport only — `accepted_state_authority: false` always; Git/GitZip success ≠ accepted state / ≠ deploy.
2. Tree + transport ops **never** mutate `chain_heads` or `path_heads`.
3. Mutable branch/PR refs are **observed tip** metadata; immutable 40-hex SHAs are required for hydrate source and when asserting observed commits.
4. Auth = existing `workspace_capability` + live `workspace_members` (mutations need `write_draft`; ls needs `ls`; diff needs `diff`).
5. Never persist raw capability bearers / secrets.
6. Tip mutations use **CAS** on `base_revision` (no last-write-wins).
7. Fail closed on expired/revoked capability, wrong actor, missing membership, or stale CAS.

## Schema

### `migrations/0018_v777d_workspace_working_tree.sql`

Additive columns on `workspace_revisions` (`op`, `content_encoding`, `content_ref`, `git_blob_sha`, `rename_to_path`) and `workspace_tips` (`content_encoding`, `content_ref`, `git_blob_sha`).

New append-only tables:

- `workspace_tree_ops` — audit for delete/rename/hydrate/content_ref/set_github_transport
- `workspace_gitzip_transport_receipts` — transport receipts with `accepted_state_authority = 0` enforced

## APIs

### MCP

| Tool | Auth | Notes |
|------|------|--------|
| `cairnstone_workspace_delete_draft` | membership + `write_draft` | CAS delete; tombstone revision |
| `cairnstone_workspace_rename_draft` | membership + `write_draft` | CAS rename; dest must not exist |
| `cairnstone_workspace_write_content_ref` | membership + `write_draft` | content_ref tip; no R2 body |
| `cairnstone_workspace_hydrate_from_git` | membership + `write_draft` | immutable `commit_sha` required |
| `cairnstone_workspace_set_github_transport` | membership + `write_draft` | observed tip + `transport_only` |
| `cairnstone_workspace_tree_ls` | membership + `ls` | files + synthetic directories |
| `cairnstone_workspace_tree_diff` | membership + `diff` | against prior tip vector |
| `cairnstone_workspace_record_gitzip_transport` | membership + `write_draft` | GitZip ≠ accept |
| `cairnstone_code_session_set_working_transport` | membership + `write_draft` | session CAS on `base_revision` |

Broker: mutations = `risk_class:mutation` + `scoped_grant`; reads = `scoped_grant`. None are automatic-read for `cairnstone_delegate`.

### REST

- `POST /v1/workspaces/delete-draft`
- `POST /v1/workspaces/rename-draft`
- `POST /v1/workspaces/write-content-ref`
- `POST /v1/workspaces/hydrate-from-git`
- `POST /v1/workspaces/github-transport`
- `POST /v1/workspaces/tree-ls`
- `POST /v1/workspaces/tree-diff`
- `POST /v1/workspaces/gitzip-transport`
- `POST /v1/code-sessions/working-transport`

## Code session integration

- `cairnstone_code_session_set_working_transport` CAS-updates `working_transport_json` (`transport_only:true`, `accepted_state_authority:false`); optional `observed_commit_sha` resolve via injected GitHub resolver.
- `cairnstone_code_session_compile_context` includes `workspace.tree_stats` (`tip_count`, `content_ref_count`, `git_blob_count`, digest) and `workspace.git_transport` (`transport_only`, `gitzip_success_is_not_accepted_state`).

## Module map

- `migrations/0018_v777d_workspace_working_tree.sql`
- `src/workspace-tree.js` (tree ops + MCP FromBody + tool defs)
- `src/code-session.js` (working transport + compile-context tree_stats)
- `src/index.js` (MCP + REST wiring; worker `0.5.34`)
- `src/model-router.js` (broker registry; 58 tools)
- `test/workspace-tree.test.js`
- `test/code-session.test.js` (working transport + tree_stats regressions)
- `docs/V7_7_7D_REPO_SCALE_WORKING_TREE.md` (this file)

## Smoke steps

1. Apply migration `0018_v777d_workspace_working_tree.sql`.
2. `node --check src/workspace-tree.js src/code-session.js src/model-router.js src/index.js`
3. `node --test test/workspace-tree.test.js test/model-router.test.js`
4. Optional: `node --test test/workspace.test.js test/code-session.test.js`
5. Confirm broker total = 58; tree mutations absent from automatic-read list.

## Out of scope (later slices)

- **7.7.7e** environment reconstruct / sandbox adapter — **shipped** in [V7_7_7E_ENVIRONMENT_SANDBOX.md](./V7_7_7E_ENVIRONMENT_SANDBOX.md)
- **7.7.7f** Console Persistent Code Mode UX — see [V7_7_7F_CODE_SESSION_CONSOLE.md](./V7_7_7F_CODE_SESSION_CONSOLE.md)
- Promoting Git/GitZip transport success into project-memory accepted HEAD
- Treating `content_ref` hydrate as accepted deploy or chain mutation
