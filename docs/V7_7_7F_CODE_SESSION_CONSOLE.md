# V7.7.7f — Persistent Code Mode Console UX

**Status:** in-repo implementation slice. Operator UX / projection plane only. Does **not** move `cairnstone-v6-project-memory` chain/path HEADs. Console is a client of existing Code Session + V7.7.6 invite planes — **not** a new trust root. `accepted_state_authority: false` and `console_grants_no_new_authority: true` on every Console view response. Never stores or returns raw capability bearers.

**Plan stone:** `297ffc7a5894f89464f413812646763ed670c53ef6093a39e3f06355d9d1136e`  
(`project-memory/v777-persistent-code-mode-durable-multi-agent-code-sessions-plan.md` § V7.7.7f)

**Builds on:** V7.7.7a–e (Code Session, checkpoints, leases, repo-scale tree, environment/sandbox) + V7.7.6 invite/mailbox.

**Reuses:** Shared Agent Workspace (V7.7.5), mailbox/invite + `workspace_capability` (V7.7.6). No second ticket format.

## Product surface

Mobile-friendly Console view centered on the **Code Session** rather than one model chat:

```text
PROJECT
Student Loan Advisor

PERSISTENT CODE SESSION
Active

Current task
Advisor Workspace refactor

Actors
Claude     active · parser
ChatGPT    paused · checkpoint 14m ago
Grok       reviewing
Grok Bot   release owner

Tests
184 / 184 passing

Working tree
12 modified · 3 added · 0 conflicts

[ Invite Agent ] [ Send Message ] [ Checkpoints ] [ View Work ] [ Propose / Merge ]
```

## Authority invariants

1. **Console ≠ trust root.** Aggregation + action descriptors only; every mutating action still goes through existing capability + membership gates.
2. **Invite Agent = V7.7.6 only.** Operator mint via `POST /v1/workspace-invites`; claim via `cairnstone_workspace_invite_claim`. Continuation prompt: *Check your CairnStone inbox and continue the Code Session.* No second ticket format.
3. **Propose / Merge** = existing `cairnstone_workspace_propose_accept` only (requires explicit `propose` scope). Sandbox test success never implies deploy/merge/accepted-state.
4. **Never accepted-state authority.** Responses set `accepted_state_authority: false`; ops never mutate `chain_heads` / `path_heads`.
5. **No secrets in Console state.** View strips bearers; invite AC1 notices carry invite_id/fingerprint/instructions only.
6. Auth for the view = existing `workspace_capability` + membership with `read` (same class as `compile_context`).

## API

### MCP

| Tool | Auth | Notes |
|------|------|--------|
| `cairnstone_code_session_console_view` | membership + `read` | Thin aggregation over compile-context + checkpoints + receipts + workspace name |

Broker: `risk_class:read` + `scoped_grant`. **Not** automatic-read for `cairnstone_delegate`. Total broker tools = **68**.

### REST

- `POST /v1/code-sessions/console-view`

Body: `{ code_session_id, actor_id, workspace_capability, checkpoint_limit?, receipt_limit? }`

### Response (shape)

- `schema: cairnstone-code-session-console-view-v1`
- `project`, `persistent_code_session`, `current_task`, `actors`, `tests`, `working_tree`
- `checkpoints` (latest + recent)
- `environment_sandbox` summary when present
- `actions` catalog mapping each button to existing planes
- `operator_surface` (labels/lines for mobile rendering)
- `continuation_prompt`
- `console_grants_no_new_authority: true`, `secrets_absent: true`, `accepted_state_authority: false`

## Action mapping

| Button | Existing plane |
|--------|----------------|
| Invite Agent | V7.7.6 operator mint + mailbox claim (`POST /v1/workspace-invites`, `cairnstone_workspace_invite_claim`) |
| Send Message | AC1 `cairnstone_send_message` |
| Checkpoints | `cairnstone_code_checkpoint_list` / `create` |
| View Work | workspace/tree `ls`/`diff` + `compile_context` |
| Propose / Merge | `cairnstone_workspace_propose_accept` (explicit `propose` scope) |

## Console client

The live browser client lives in `nothinginfinity/cairnstone-v6-console`. V7.7.7f adds a **Code** tab that:

1. Loads `cairnstone_code_session_console_view`
2. Renders the operator surface for small screens
3. Wires Invite Agent into the existing Invite panel (V7.7.6 mint) with the continuation prompt
4. Routes other buttons to existing MCP/REST surfaces without new authority

Portable reference panel assets may also live under `console-panel/` in this repo for contract review.

## Module map

- `src/code-session-console.js` (aggregation + action catalog + MCP tool def)
- `src/index.js` (MCP + REST; worker `0.5.36`)
- `src/model-router.js` (broker registry; 68 tools)
- `test/code-session-console.test.js`
- `docs/V7_7_7F_CODE_SESSION_CONSOLE.md` (this file)

## Smoke steps

1. `node --check src/code-session-console.js src/index.js src/model-router.js`
2. `node --test test/code-session-console.test.js test/model-router.test.js test/code-session.test.js`
3. Confirm broker total = 68; `cairnstone_code_session_console_view` absent from automatic-read list
4. Optional: full `npm test`

## Out of scope

- Full cross-model live continuation acceptance (plan § acceptance test) — operator surface + contract first
- New invite/capability ticket formats
- Automatic merge/deploy from green tests
- Serving raw capability tokens in the Console
