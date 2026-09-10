# V7.7.5 — Shared Agent Workspace

**Status:** V7.7.5a foundation in-repo (contract + capability + storage/revision CAS). Not LIVE VERIFIED. Propose-only for project-memory until human/main-model confirm after live verify.

**Build baseline:** ChatGPT architecture review `cc6210f33390514d6696319ef2e1e0c0ea5047d058c2018a8b1ab6bfe89a2b7c` locked by design v2 `3dd2891891929216431463dbadf1e8252488e39dfb74547c466133c05c8dc3d8` (`proposals/v775-shared-agent-workspace-design-v2-chatgpt-baseline.md`).

**Predecessor:** V7.7.4a mailbox control plane (`mailbox_capability` is the security analogue).

## What this plane is

A shared **virtual working tree** for product actors — not a shared host filesystem, not another inbox, and not another HEAD registry.

Plane transition:

`private actor scratch` → **workspace drafts (CAS tips)** → **proposal Stone / snapshot** → **separately authorized accepted-state mutation** (existing guarded HEAD path only).

## Staging

| Slice | Scope |
|-------|--------|
| **V7.7.5a** (this PR) | Workspace contract, dedicated capability mint/verify, D1 schema, R2 content-addressed blobs, `write_draft` CAS library API, path hardening, broker registry classifications + unit tests |
| **V7.7.5b** | MCP create/list/stat/ls/read/write_draft/diff + cross-actor capability tests |
| **V7.7.5c** | Snapshot / `propose_accept` + optional GitHub bind + end-to-end acceptance criteria 1–10 |

Do **not** invent V7.7.6 here. Do **not** claim LIVE VERIFIED from 5a alone.

## Locked authority invariants

1. **Storage = B/A-hybrid (ChatGPT).** Content-addressed R2 blobs (`workspace-blobs/<sha256>.txt`) + D1 tables `workspaces`, `workspace_members`, append-only `workspace_revisions`, mutable `workspace_tips` (CAS), optional `workspace_snapshots` schema stub. Draft revisions are **not** inserted into ordinary Stones / search / Scope.
2. **Conflicts.** `write_draft` requires `base_revision` (null only on create). Stale tip → `workspace_conflict` with current tip + content hash. No last-write-wins.
3. **Capability.** Dedicated `CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET`. **No** fallback to mailbox secret or `CAIRNSTONE_OPERATOR_TOKEN`. Fail closed if missing. Payload binds `actor_id`, `workspace_id`, exact scopes (`ls|read|write_draft|diff|propose`), expiry/nonce, optional `path_prefix`, `purpose`/`audience`=`workspace`. Capability may narrow membership roles, never widen.
4. **Scope separation.** `write_draft` does **not** imply `propose`. `propose` does **not** imply accepted-state HEAD mutation.
5. **Broker hard-ban.** `cairnstone_workspace_write_draft`, `cairnstone_workspace_create`, and `cairnstone_workspace_propose_accept` are `risk_class:mutation` + `authorization:scoped_grant` and must never appear on `cairnstone_delegate` automatic-read allowlists. Workspace reads are `read` + `scoped_grant` (not automatic).
6. **Paths.** Canonical relative POSIX only; reject `..`, absolute, NUL, symlink patterns, and default-deny secret basenames (`.env`, keys, credentials).
7. **Accepted state.** Workspace write/propose never moves `chain_heads` / `path_heads`. This documentation and 5a code must **not** move cairnstone project-memory HEAD.

## Module map

- `migrations/0012_v7_7_5a_shared_agent_workspace.sql` — D1 schema
- `src/workspace.js` — capability, path helpers, create/member helpers, `writeDraft` / `readDraft` CAS API
- `src/model-router.js` — broker registry stub entries for workspace tools
- `test/workspace.test.js` — fail-closed capability, CAS conflict, path reject, scope separation, broker non-automatic mutations

## Runtime secret

Set `CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET` in the Worker environment before any mint/verify path can succeed. Absence is an explicit closed failure (`workspace_capability_not_configured`).
