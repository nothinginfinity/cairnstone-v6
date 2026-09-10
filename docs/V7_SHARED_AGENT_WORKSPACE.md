# V7.7.5 — Shared Agent Workspace

**Status:** V7.7.5c complete in-repo (immutable snapshots + `propose_accept` + optional GitHub bind) on top of 5a foundation and 5b MCP surface. Not LIVE VERIFIED. Propose-only for project-memory until human/main-model confirm after live verify.

**Build baseline:** ChatGPT architecture review `cc6210f33390514d6696319ef2e1e0c0ea5047d058c2018a8b1ab6bfe89a2b7c` locked by design v2 `3dd2891891929216431463dbadf1e8252488e39dfb74547c466133c05c8dc3d8` (`proposals/v775-shared-agent-workspace-design-v2-chatgpt-baseline.md`).

**Predecessor:** V7.7.4a mailbox control plane (`mailbox_capability` is the security analogue).

## What this plane is

A shared **virtual working tree** for product actors — not a shared host filesystem, not another inbox, and not another HEAD registry.

Plane transition:

`private actor scratch` → **workspace drafts (CAS tips)** → **proposal Stone / snapshot** → **separately authorized accepted-state mutation** (existing guarded HEAD path only).

## Staging

| Slice | Scope |
|-------|--------|
| **V7.7.5a** | Workspace contract, dedicated capability mint/verify, D1 schema, R2 content-addressed blobs, `write_draft` CAS library API, path hardening, broker registry classifications + unit tests |
| **V7.7.5b** | MCP create/list/stat/ls/read/write_draft/diff + cross-actor capability/membership tests |
| **V7.7.5c** (this PR) | Immutable snapshot / `propose_accept` + optional GitHub bind + acceptance criteria 1–10 |

Do **not** invent V7.7.6 here. Do **not** claim LIVE VERIFIED from 5c alone.

## Locked authority invariants

1. **Storage = B/A-hybrid (ChatGPT).** Content-addressed R2 blobs (`workspace-blobs/<sha256>.txt`) + D1 tables `workspaces`, `workspace_members`, append-only `workspace_revisions`, mutable `workspace_tips` (CAS), immutable `workspace_snapshots`. Draft revisions are **not** inserted into ordinary Stones / search / Scope. Ordinary Stones appear at `propose_accept` freeze time only.
2. **Conflicts.** `write_draft` requires `base_revision` (null only on create). Stale tip → `workspace_conflict` with current tip + content hash. No last-write-wins.
3. **Capability.** Dedicated `CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET`. **No** fallback to mailbox secret or `CAIRNSTONE_OPERATOR_TOKEN`. Fail closed if missing. Payload binds `actor_id`, `workspace_id`, exact scopes (`ls|read|write_draft|diff|propose`), expiry/nonce, optional `path_prefix`, `purpose`/`audience`=`workspace`. Capability may narrow membership roles, never widen.
4. **Membership + capability.** Every MCP mutation/read validates the signed capability **and** live `workspace_members` grant (create is the sole exception: owner capability for a not-yet-existing `workspace_id`, then owner row is inserted). Third actor without grant denied even with a valid semantic actor string.
5. **Scope separation.** `write_draft` does **not** imply `propose`. `propose` does **not** imply accepted-state HEAD mutation.
6. **Snapshot before propose.** `propose_accept` freezes `workspace_snapshot_id` over the selected path-tip vector + content hashes; re-reads tips; fails closed with `workspace_snapshot_race` if anything changed during compilation. Proposal packet references the snapshot digest, never a moving tip.
7. **Broker hard-ban.** `cairnstone_workspace_write_draft`, `cairnstone_workspace_create`, and `cairnstone_workspace_propose_accept` are `risk_class:mutation` + `authorization:scoped_grant` and must never appear on `cairnstone_delegate` automatic-read allowlists. Workspace reads are `read` + `scoped_grant` (not automatic).
8. **Paths.** Canonical relative POSIX only; reject `..`, absolute, NUL, symlink patterns, and default-deny secret basenames (`.env`, keys, credentials). GitHub bind `root_path` is sandboxed the same way.
9. **V1 content.** Bounded UTF-8/text only via MCP read/write. Large/binary content stays on the optional GitHub/GitZip path.
10. **GitHub bind.** Optional transport/backing only. Branch refs resolve to an immutable commit SHA on every diff/snapshot; responses return `observed_commit_sha`. `propose_accept` may point at a PR/commit only after that immutable identity exists.
11. **Accepted state.** Workspace write/propose never moves `chain_heads` / `path_heads`. This documentation and 5c code must **not** move cairnstone project-memory HEAD. Existing guarded HEAD mutation remains the only acceptance path.

## Module map

- `migrations/0012_v7_7_5a_shared_agent_workspace.sql` — D1 schema (including `workspace_snapshots`)
- `src/workspace.js` — capability, path helpers, CAS API, snapshot freeze, GitHub bind resolve, MCP `*FromBody` handlers + tool definitions
- `src/model-router.js` — broker registry entries (mutations never automatic-read)
- `src/index.js` — MCP `tools/list` + `tools/call` wiring (propose_accept injects `createStone` + GitHub commit resolver)
- `test/workspace.test.js` — fail-closed capability, CAS conflict, path deny, scope separation, broker classification, cross-actor MCP, snapshot race, GitHub observed SHA

## MCP tools

| Tool | Auth | Notes |
|------|------|--------|
| `cairnstone_workspace_create` | owner capability + `write_draft` (no prior membership) | Optional `github_bind` `{owner,repo,ref?,root_path?}` |
| `cairnstone_workspace_list` | membership + `ls` | Lists workspaces the principal is a member of |
| `cairnstone_workspace_stat` | membership + `ls` | Metadata, members, tips, github_bind |
| `cairnstone_workspace_ls` | membership + `ls` | Paths under optional prefix |
| `cairnstone_workspace_read` | membership + `read` | UTF-8 tip content |
| `cairnstone_workspace_write_draft` | membership + `write_draft` | CAS; conflict on stale tip; never HEADs |
| `cairnstone_workspace_diff` | membership + `diff` | Tip vs parent/`against_revision`; returns `observed_commit_sha` when bound |
| `cairnstone_workspace_propose_accept` | membership + `propose` | Freezes snapshot; emits proposal packet/Stone; `accepted_state_authority:false`; never HEADs |

## Runtime secret

Set `CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET` in the Worker environment before any mint/verify path can succeed. Absence is an explicit closed failure (`workspace_capability_not_configured`).
