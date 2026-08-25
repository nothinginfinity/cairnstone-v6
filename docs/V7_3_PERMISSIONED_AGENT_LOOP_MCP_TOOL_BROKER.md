# CairnStone V7.3 — Permissioned Agent Loop / MCP Tool Broker

Status: **V7.3.0 implemented and live-accepted — broker registry + deterministic policy preview only; zero broker tool execution**

Predecessor: **V7.2 complete**  
Runtime baseline: **0.5.9**

## Core invariant

> Model intent is not execution authority.

V7.1 may return normalized tool intents. V7.3 is the separate governance and execution layer that decides whether any intent is eligible, requires authorization, or must be denied. Provider adapters never execute tools and never receive connector credentials.

## V7.3.0 — Broker registry + policy preview

V7.3.0 establishes the non-executing broker foundation.

### Normalized registry

`cairnstone_tool_registry` exposes operational metadata for explicitly registered downstream tools:

- stable `tool_id`;
- downstream connector and handler identity;
- JSON input schema;
- risk class: `read`, `mutation`, `execution`, or `prohibited`;
- authorization policy: `automatic`, `scoped_grant`, `human_confirmation`, or `prohibited`;
- runtime availability.

The registry is operational configuration, not accepted-state authority. It contains no provider or connector credentials.

### Deterministic policy preview

`cairnstone_tool_policy_preview` accepts:

- a complete V7.0 `cairnstone-agent-context-v1` package; and
- one normalized V7.1-style `tool_intent`.

Before issuing a verdict it:

1. re-verifies the V7.0 package identity and zero-authority policy;
2. rejects intents already claiming `executed:true`;
3. resolves the tool only through the explicit broker registry;
4. verifies the tool was present in the V7.0 capability evidence;
5. validates tool arguments against the registered JSON schema;
6. produces a deterministic content-identified policy decision.

Possible decisions:

- `allow` — policy-eligible automatic read;
- `require_authorization` — eligible only after the required scoped grant or human confirmation;
- `deny` — unregistered, unavailable, absent from capability evidence, invalid arguments, or prohibited.

### V7.3.0 hard boundary

A policy verdict is **not** execution.

Every V7.3.0 decision reports:

- `preview_only: true`;
- `can_execute_now: false`;
- `executed: false`;
- `tools_executed: 0`;
- `execution_authority: false`;
- `mutation_authority: false`.

Even a read intent with decision `allow` remains unexecuted in V7.3.0.

### Initial registry

Automatic read-only:

- `cairnstone_health`
- `cairnstone_resume_chain`
- `cairnstone_find_v2`
- `cairnstone_expand`
- `cairnstone_get_source_freshness`
- `cairnstone_check_source_freshness`
- `cairnstone_reconcile_repo`

Scoped mutation:

- `cairnstone_send_message`
- `cairnstone_dispatch_handoff`

Human-confirmed mutation:

- `cairnstone_commit_v2`
- `cairnstone_set_path_head`
- `cairnstone_set_head`

Registration does not grant authority. The V7.0 context package must independently expose the tool capability, and the broker policy must still approve the intent.

## Acceptance

V7.3.0 acceptance requires all of the following:

- full syntax/regression suite green;
- runtime advertises `cairnstone_tool_registry` and `cairnstone_tool_policy_preview`;
- registry reports operational, non-authoritative configuration and zero tool execution;
- a V7.0 package containing `cairnstone_health` can yield `allow/read_only_automatic`;
- that allowed read still reports `can_execute_now:false`, `executed:false`, and `tools_executed:0`;
- a V7.0 package containing `cairnstone_commit_v2` yields `require_authorization/human_confirmation`;
- no preview call changes chain HEAD or any accepted path HEAD.

## Next bounded slices

### V7.3.1 — Read-only execution loop

Wire only a narrow allowlist of automatic read tools behind the broker. The loop must:

- execute outside provider adapters;
- issue an immutable execution/tool receipt;
- return the tool result to the same model request loop;
- preserve `package_id`, request/model identities, tool intent identity, and policy decision identity;
- enforce turn/tool/output budgets;
- fail closed on unavailable/unregistered tools or capability mismatch;
- keep mutation/execution classes unavailable.

### V7.3.2 — Mutation stop boundary

Allow the model to propose mutation intents but stop with an explicit authorization requirement. No mutation is performed.

### V7.3.3 — Human-confirmed guarded mutation

After explicit authorization, execute a narrowly registered mutation through concurrency guards, verify resulting state/tests, and issue immutable execution receipts linked to the originating package and model envelope.

The first end-to-end target remains the roadmap acceptance scenario: inspect accepted repo state, request read tools, diagnose, propose a guarded GitHub change, stop at the mutation boundary, receive authorization, apply and verify, then return a compact evidence-bearing receipt.
