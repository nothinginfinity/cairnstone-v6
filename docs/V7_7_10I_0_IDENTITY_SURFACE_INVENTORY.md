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

## Tools that currently accept actor/mailbox identity (must bind or assert)

These accept `recipient_id`, `from`/`to`, `actor_id`, or equivalent and MUST apply the migration assertion rule on core-auth:

- `cairnstone_send_message`, `cairnstone_dispatch_handoff`
- `cairnstone_get_inbox`, `cairnstone_list_threads`, `cairnstone_get_thread`, `cairnstone_read_message`
- `cairnstone_note_self`, `cairnstone_get_notes`
- `cairnstone_run_task_request`
- `cairnstone_mailbox_policy_preview`
- `cairnstone_forward_with_note`
- `cairnstone_access_grant_*` (`principal_actor_id`, `grantor`)
- `cairnstone_task_run_propose` / `get` / `list` / `dispatch` / `cancel` (requester, assignee, `committed_by`)
- `cairnstone_conversation_session_*` (`created_by`, `selected_actors`)
- `cairnstone_agent_bootstrap` (`actor_id`)
- `cairnstone_tool_authorization_prepare` / `request` (`actor`)
- `cairnstone_workspace_invite_claim` (claimant MUST be server principal)
- `cairnstone_code_session_*` membership + `write_draft` actor
- `cairnstone_intent_route` (never auto-mutate; still must not honor foreign actor claims)

## Tools that accept workspace / Code Session / economic identity

Must constrain by realm + tenant + principal membership; caller IDs may only narrow:

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
