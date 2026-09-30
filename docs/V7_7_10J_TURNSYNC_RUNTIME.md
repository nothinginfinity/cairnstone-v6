# V7.7.10j — TurnSync runtime aggregate + ingest bridge

Date: 2026-09-29
Status: feature branch only / not merged / not deployed
Branch: `v7710j-turnsync-runtime`

## Purpose

This slice adds the runtime half of CairnStone Unified Conversation Sync / TurnSync without creating a parallel transcript database. It composes existing Conversation Sessions, AC1 correspondence, Task Runs, event projection, and Core-auth connection identity.

Four authenticated TurnSync surfaces are added:

- `cairnstone_unified_conversations` — authenticated account-scoped read model.
- `cairnstone_turnsync_append` — authenticated replay-safe, policy-gated end-of-turn append bridge.
- `cairnstone_turnsync_policy_get` — effective account/workspace/chain standing-policy read.
- `cairnstone_turnsync_policy_set` — human-confirmed CAS write of account-owned operational policy.

None grants accepted-state authority or promotes conversation history into project memory.

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

`cairnstone_turnsync_append` is the authenticated ingestion boundary for provider/host end-of-turn hooks.

The bridge:

1. resolves the current active Core-auth connection;
2. constrains `actor_id` to that connection's principal/routing aliases;
3. checks for an exact already-persisted stable replay before any new mutation;
4. loads the current Conversation Session and derives policy scope only from its durable `workspace_id` / `selected_chain` bindings;
5. evaluates workspace → chain → account → safe-default-ASK policy from the authenticated account's Auth D1 rows;
6. calls the existing append-only Conversation Session turn primitive only when policy permits;
7. retries one clean CAS conflict with a freshly loaded session revision;
8. treats an exact already-persisted `turn_id` + `message_id` identity as an idempotent replay instead of a second append.

A replay is reported only when the durable turn identity matches the same conversation, actor, and role **and** the Conversation Session `message_log` contains the corresponding turn/message projection. If a durable row exists without that projection, the bridge fails closed with `turnsync_turn_projection_incomplete` rather than claiming success.

The caller does not provide `base_revision` to this bridge.

## Standing TurnSync policy boundary

Standing policy is account-owned operational authorization/preference state in the dedicated Core-auth D1, not project memory. The migration is `migrations/auth/0005_v7710j_turnsync_policy.sql`.

Effective precedence is deterministic and fail-closed:

1. exact Conversation Session `workspace_id` policy;
2. exact Conversation Session `selected_chain` policy;
3. authenticated account default;
4. safe default `ASK + full_turns`.

New append behavior:

- `OFF` → `turnsync_sync_disabled`; no append.
- `ASK + full_turns` → `turnsync_confirmation_required` unless the host/UI supplies an explicit one-turn `sync_confirmed:true` marker after human confirmation.
- `ON + full_turns` → append allowed.
- `decisions_tasks` or `summaries` → `turnsync_payload_transform_required`; no raw full-turn fallback occurs until a trusted transformer exists.

`sync_confirmed` is a one-turn host/UI confirmation marker, not an override: it cannot bypass `OFF` or selective-payload transform requirements, and it is stripped before the durable turn append. Exact stable replays are checked first because they perform no new upload or mutation; an already-persisted turn may therefore be reported as replayed even after policy is later changed.

Policy writes require `human_commit:true`; existing rows additionally require the current `base_revision`. Stale writes fail with a policy conflict instead of silently overwriting another tab/provider.

## Broker classification

- `cairnstone_unified_conversations`: `risk_class: read`, `authorization: automatic`. It still fails closed without authenticated account context.
- `cairnstone_turnsync_append`: `risk_class: mutation`, `authorization: scoped_grant`.
- `cairnstone_turnsync_policy_get`: `risk_class: read`, `authorization: scoped_grant` — intentionally not an automatic model read of account settings.
- `cairnstone_turnsync_policy_set`: `risk_class: mutation`, `authorization: scoped_grant`.

None of the append/policy surfaces is eligible for the automatic-read delegation loop.

## Console integration boundary

The Console feature branch includes a public-client PKCE Core-auth flow and switches authenticated sessions to `/mcp/core-auth`. The authenticated Core profile is additively extended with exactly four TurnSync-native surfaces: aggregate, append, policy-get, and policy-set. The legacy `/mcp/core` bounded boot surface is unchanged, and these mutation/settings tools are not added to generic native hydration.

When authenticated, the Console uses the account aggregate and reads/writes the account-default TurnSync policy. Without Core-auth it honestly falls back to the prior actor-scoped Conversation Session list and treats local TurnSync select values as browser drafts only.

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

1. Run the focused Node tests and relevant broader runtime suite in CI or another executable environment.
2. Review/apply the Auth D1 TurnSync-policy migration as part of an explicitly authorized deployment plan.
3. Publish/canary the Console CIMD + PKCE flow, refresh rotation/revoke, and authenticated account policy editor.
4. Canary the aggregate against multiple active provider connections and verify visibility/provenance and cross-account isolation.
5. Canary `OFF`, `ASK`, `ON`, duplicate/retry, stale-CAS, and projection-incomplete TurnSync paths.
6. Implement trusted selective-payload transformers before enabling `decisions_tasks` or `summaries` automatic append.
7. Add deterministic provider/host end-of-turn lifecycle hooks; prompt/instruction-driven calls remain interim.
8. Only after those gates: review PRs and separately authorize merge/deploy.

## Authority invariants

Both new surfaces preserve:

- `accepted_state_authority:false`
- no chain HEAD mutation
- no path HEAD mutation
- no capability grant
- no automatic project-memory promotion
- no merge/deploy authority
