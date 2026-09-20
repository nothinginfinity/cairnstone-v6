# V7.7.10I.0 — Identity-bearing surface inventory

Status: **CONTRACT FREEZE / INVENTORY.** Not exhaustive of future tools; freeze is fail-closed: any unlisted identity field is treated as untrusted caller JSON.

## Rule

After `/mcp/core-auth` token validation, the gateway injects internal context:

`account_id, tenant_id, connection_id, principal_id, authenticator_assurance, client_family, resource, scopes, token_family_id, authz_version`

This context is outside model-controlled JSON. Hydrated tools and `cairnstone_tool_execute` MUST receive it. Losing it is a defect.

## HTTP routes

| Route | Identity role in 10i.1 |
|---|---|
| `/mcp` | Legacy compatibility realm only. Unchanged. Must not read auth_* rows. |
| `/mcp/core` | Legacy Core twin. Unchanged. |
| `/mcp-b` | Full-catalog twin. Never an auth endpoint. |
| `/mcp/core-auth` | Additive protected resource. Only surface that may bind Core tokens. |
| OAuth PRM / AS discovery / authorize / token / revoke | Public or AS-local; rate-limited; no private vault data. |
| Health | Public, rate-limited. |

No `/mcp/core-auth-b` unless a live client-cache incompatibility proves it.

## Identity-field classes

Every identity-bearing input on core-auth MUST be classified by field, not merely by tool:

- `SERVER_DERIVED_CALLER` — authoritative current caller from the validated token/context; caller JSON is never trusted to replace it.
- `CHECKED_CALLER_ASSERTION` — legacy-compatible assertion of caller/mailbox ownership. If omitted, use server context; if present, it must match the authenticated principal or an already-authorized delegated alias.
- `AUTHORIZED_TARGET_SELECTOR` — names another recipient, assignee, grantee, selected actor, or worker. It may differ from the caller only when the operation's existing policy authorizes that target; it never changes caller identity.
- `RESOURCE_SELECTOR` — workspace, Code Session, object, tenant, checkpoint, receipt, or similar identifier. It may select only resources visible to the server-derived principal under validated tenant/membership/grant constraints.

Target selection is not impersonation. Do not apply the caller-assertion equality rule to `to`, `assignee_actor_id`, `principal_actor_id`, `selected_actors`, or equivalent legitimate target fields.

## Tool identity mapping

- `cairnstone_send_message`, `cairnstone_dispatch_handoff`, `cairnstone_forward_with_note`: `from` / actor is `SERVER_DERIVED_CALLER` or `CHECKED_CALLER_ASSERTION`; `to` is `AUTHORIZED_TARGET_SELECTOR`.
- `cairnstone_get_inbox`, `cairnstone_list_threads`, `cairnstone_get_thread`, `cairnstone_read_message`: `recipient_id` is `CHECKED_CALLER_ASSERTION` unless an explicit delegated-mailbox grant authorizes another mailbox.
- `cairnstone_note_self`, `cairnstone_get_notes`: owner/actor is `SERVER_DERIVED_CALLER`; foreign targets are not valid.
- `cairnstone_run_task_request`: requester is `SERVER_DERIVED_CALLER`; `worker_actor_id` is `AUTHORIZED_TARGET_SELECTOR` and still requires the signed mailbox capability.
- `cairnstone_mailbox_policy_preview`: caller/from is a checked caller assertion; `to` entries are authorized target selectors for preview only.
- `cairnstone_access_grant_*`: grantor is the server caller/checked assertion; `principal_actor_id` is `AUTHORIZED_TARGET_SELECTOR`; `object_ref` is `RESOURCE_SELECTOR`.
- `cairnstone_task_run_propose` / `get` / `list` / `dispatch` / `cancel`: requester / `committed_by` is caller identity; assignee is `AUTHORIZED_TARGET_SELECTOR`; task/object refs are resource selectors.
- `cairnstone_conversation_session_*`: `created_by` / actor is caller identity; `selected_actors` are authorized targets; workspace/session/repo/chain refs are resource selectors.
- `cairnstone_agent_bootstrap` and `cairnstone_tool_authorization_prepare` / `request`: actor is caller identity.
- `cairnstone_workspace_invite_claim`: claimant is the server-derived caller; invite is a resource selector and still requires its mailbox proof.
- `cairnstone_code_session_*`: membership/write actor is caller identity; workspace/session/path/checkpoint/receipt identifiers are resource selectors.
- `cairnstone_intent_route`: actor is caller identity; known/selected actors are target hints only. It remains proposal-only and never auto-mutates.

## Tools that accept workspace / Code Session / economic identity

`RESOURCE_SELECTOR` fields must constrain by realm + tenant + principal membership; they never replace caller identity or widen membership. Economic targets may name another object only through existing explicit grants/policy:

- all `cairnstone_workspace_*`
- all `cairnstone_code_session_*`, checkpoint, lease, sandbox, execution receipt, environment manifest
- `cairnstone_paid_agent_quote_preview`, `cairnstone_paid_agent_x402_quote_preview`
- executor route/list/get/health (no dispatch identity widening)

## Tools that must remain identity-inert (no principal substitution)

Search, stone read, scope, skills, model route, capability route, tool search/contract, vault catalog, resume/manifest, freshness/reconcile, lint. They still execute as the authenticated principal on core-auth and MUST NOT accept a caller principal override.

## Broker / hydration

`cairnstone_tool_execute`, `cairnstone_load_tools`, `cairnstone_tool_policy_preview`, `cairnstone_capability_route` (hydrate), and every dynamically hydrated tool MUST propagate server context. Indirect execution MUST NOT lose, replace, or widen identity.

## Legacy aliases

`perplexity:chat` / `perplexity:cairnstone-v6` and `perplexity-2:*` remain routable only after authenticated ownership proof. Pre-migration strings do not prove current ownership. Conflicting claims fail closed. Historical message bodies are never rewritten.
