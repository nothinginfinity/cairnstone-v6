# S1-2 — authenticated private inbox tools (DORMANT, default-off)

Status: code and tests only. Not imported by `src/index.js` or `src/worker.js`, not registered in any tool list or `/mcp/core-auth` handler, no binding, no migration, no deploy. Nothing here activates private Home tools; that remains a separate, explicitly authorized live-acceptance step.

## What it is

`src/private-realm/private-inbox-tools.js` defines five tools over the S0b store, driven through the S1-1 bridge:

| Tool | Store call | Notes |
|---|---|---|
| `private_inbox_get` | `listInboxes` + `can` | own addresses and store-decided capabilities |
| `private_inbox_list` | `listInbox` | metadata only, no bodies |
| `private_inbox_read` | `readInbox` | bodies; first read stamps `read_at` |
| `private_inbox_send` | `send` | idempotent by `message_id`; conflict refused |
| `private_inbox_ack` | `ack` | idempotent |

`createPrivateInboxTools({ bridge, store, enabled })` returns `{ call(accessToken, name, args), definitions, enabled }`. `enabled` defaults to **false**: every call then fails with `private_tools_disabled` before any authentication or store access.

## Authority model

- **Identity only from the bridge.** The new bridge method `authorizeHome(accessToken)` verifies the Core-auth token for the exact `/mcp/core-auth` resource, resolves the Home from the verified connection (`resolveHome`: authorized, audited, non-provisioning) and derives the caller's own inbox addresses. It takes no selector and never provisions.
- **The token is not a tool argument.** It is a transport input. `access_token`, `token` and `authorization` in arguments are rejected.
- **Callers address inboxes by `{plane, kind}` only** (`plane` ∈ chat/work, `kind` ∈ home/connection). Inbox ids, Home ids, account/tenant/principal/connection ids, actor strings, roles, capabilities and provider labels are rejected with `caller_selectors_forbidden`; other unknown keys with `invalid_arguments`. Schemas are `additionalProperties: false`.
- **Only own inboxes are addressable.** A sibling connection's private inbox has no derivable address for the caller, so it is unreachable even for an admin. Sends are limited to the caller's own Home and own connection-private inboxes.
- **Capabilities come from the store on every call.** Admin role alone grants no mailbox access; a member needs an explicit grant to use a Home inbox.
- **Normalised failures.** Only a stable `PrivateRealmError` code leaves the module. Error `detail` is dropped and any non-`PrivateRealmError` becomes `private_tool_failed`.
- **Strict validation, no partial writes.** Bounds mirror the store: body 1–65536 chars, 1–20 recipients, limit 1–200, message/thread id patterns from `ID_PATTERNS`.

## Tests

`test/private-realm-inbox-tools.test.js` (23 tests, run on the in-memory store and on real SQLite via the existing D1 harness): default-off with zero verifier calls; capability display for admin vs member; send/list/read/ack round trip with idempotent replay and conflict; member denied on the Home inbox; sibling-private and tenant isolation; unauthenticated, unprovisioned and revoked callers; selector and credential smuggling; argument validation with no store write; error normalisation; schema hygiene; constructor fail-closed; dormancy (no production file references the tools).

Mutation check: default-on, ignoring forbidden selectors, and leaking raw errors were each broken and each failed a test.

## Not done / still gated

No live wiring or tool registration, no private storage binding, no D1/R2 migration, no S0 guard activation, no onboarding exposure, no legacy identity claim. Admin-recovery admission stays default deny; the F1 owner decision (recovered-admin self-grant of old Home-owned history) is unchanged and still open. Also still open: private scope (F4), HMAC key versioning/rotation (F5), `can()` N+1 (F6), admin-side provider grant flow (F7), cross-isolate replay, atomic audit, orphan R2, legacy L0–L3.
