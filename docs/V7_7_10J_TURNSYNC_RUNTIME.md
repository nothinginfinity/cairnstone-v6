# V7.7.10j — TurnSync runtime aggregate + ingest bridge

Date: 2026-09-29
Status: feature branch only / not merged / not deployed
Branch: `v7710j-turnsync-runtime`

## Purpose

This slice adds the runtime half of CairnStone Unified Conversation Sync / TurnSync without creating a parallel transcript database. It composes existing Conversation Sessions, AC1 correspondence, Task Runs, event projection, and Core-auth connection identity.

Two tools are added:

- `cairnstone_unified_conversations` — authenticated account-scoped read model.
- `cairnstone_turnsync_append` — authenticated replay-safe end-of-turn append bridge.

Neither tool grants accepted-state authority or promotes conversation history into project memory.

## Authenticated aggregate read model

`cairnstone_unified_conversations` derives its visibility boundary server-side from `CORE_AUTH_CONTEXT` plus active `auth_connection_principals` for the same account and tenant.

The browser cannot widen that boundary by submitting actor IDs. Optional `actor_ids[]` and `client_families[]` are intersection-only filters over identities already resolved from active account connections.

The aggregate reuses existing per-identity reads and then de-duplicates:

- Conversation Sessions by `conversation_id`;
- AC1 mailbox threads by `thread_id` while retaining recipient-specific views;
- Task Runs by `task_run_id`;
- one event-plane projection per de-duplicated Task Run.

Every aggregate record retains `visible_via[]` provenance with the actor identity, client family, connection ID, and identity kind that made the record visible.

If `CORE_AUTH_CONTEXT` is absent, the tool fails closed with `authenticated_account_context_required`. It does not fall back to arbitrary actor reads inside the runtime.

## Replay-safe TurnSync append bridge

`cairnstone_turnsync_append` is a bootstrap ingestion primitive for provider/host end-of-turn hooks.

The bridge:

1. resolves the current active Core-auth connection;
2. constrains `actor_id` to that connection's principal/routing aliases;
3. loads the current Conversation Session revision server-side;
4. calls the existing append-only Conversation Session turn primitive;
5. retries one clean CAS conflict with a freshly loaded session revision;
6. treats an exact already-persisted `turn_id` + `message_id` identity as an idempotent replay instead of a second append.

A replay is reported only when the durable turn identity matches the same conversation, actor, and role **and** the Conversation Session `message_log` contains the corresponding turn/message projection. If a durable row exists without that projection, the bridge fails closed with `turnsync_turn_projection_incomplete` rather than claiming success.

The caller does not provide `base_revision` to this bridge.

## Sync policy boundary

This slice intentionally does **not** evaluate project/workspace standing TurnSync policy (`ON | OFF | ASK`, payload mode, or project permission) inside the append bridge.

For this bootstrap stage, the host/provider instruction or lifecycle layer must determine that a turn is eligible before calling `cairnstone_turnsync_append`. The tool returns `sync_policy_evaluated:false` so callers cannot mistake ingestion mechanics for standing authorization.

The next runtime policy slice should make standing project/workspace sync permission deterministic and auditable before provider auto-upload is enabled broadly.

## Broker classification

- `cairnstone_unified_conversations`: `risk_class: read`, `authorization: automatic`. It still fails closed without authenticated account context.
- `cairnstone_turnsync_append`: `risk_class: mutation`, `authorization: scoped_grant`. It is never eligible for the automatic-read delegation loop.

## Console integration boundary

The Console feature branch progressively prefers `cairnstone_unified_conversations`, but the current static Console default runtime still points at the legacy `/mcp` surface. Account-wide aggregation therefore requires a Console Core-auth/OAuth session against `/mcp/core-auth` before it is actually available to the operator.

Until that integration exists, the Console honestly falls back to the prior actor-scoped `cairnstone_conversation_session_list` path and labels the fallback.

## Validation performed on this feature branch

- AFO GitZip verified every committed write/patch.
- CairnStone AST syntax lint reports zero parse errors for:
  - `src/unified-conversations.js`
  - `src/turnsync-ingest.js`
  - final `src/index.js`
  - final `src/model-router.js`
  - `test/unified-conversations.test.js`
  - `test/turnsync-ingest.test.js`
- Dependency contracts for `authDb`, Conversation Session reads/appends, Task Run reads, AC1 thread reads, and event projection were inspected against current `main`.

Node test execution has **not** been completed for this branch in the present environment: no feature-branch CI run started, and the local container could not clone the private working repo because outbound DNS was unavailable. Syntax/static validation is not represented as a test-suite pass.

## Remaining gates before merge/deploy consideration

1. Wire the Console to a real Core-auth/OAuth session so the authenticated account aggregate can be exercised end to end.
2. Implement auditable project/workspace standing TurnSync policy (`ON | OFF | ASK` plus payload mode).
3. Run the focused Node tests and relevant broader runtime suite in CI or another executable environment.
4. Canary the aggregate against multiple active provider connections and verify visibility/provenance.
5. Canary duplicate/retry TurnSync append behavior, including the projection-incomplete fail-closed path.
6. Only after those gates: review PRs and separately authorize merge/deploy.

## Authority invariants

Both new surfaces preserve:

- `accepted_state_authority:false`
- no chain HEAD mutation
- no path HEAD mutation
- no capability grant
- no automatic project-memory promotion
- no merge/deploy authority
