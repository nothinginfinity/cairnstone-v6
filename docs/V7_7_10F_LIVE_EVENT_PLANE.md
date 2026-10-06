# V7.7.10f — Live Event Plane + Agent Tree (first slice)

This slice adds a **READ projection** over existing Task Runs only.

## Schemas

- `cairnstone-event-v1`
- `cairnstone-agent-tree-v1`

## Authority and state invariants

- Events are operational telemetry only.
- `accepted_state_authority` is always `false`.
- Never move chain HEADs or path HEADs.
- Task Run completion is **not** accepted state.
- Human Commit boundary from 10e is unchanged.

## Scope of 10f first slice

- Poll/list projection only:
  - `cairnstone_event_list`
  - `cairnstone_agent_tree`
- Live WebSocket + Durable Object upgrade is explicitly residual in this slice.
- No new DO bindings and no WS upgrade path in this slice.

## V7.7.10f.1d journal query

`cairnstone_event_list` remains the Event Plane surface. Omit `source` or pass `source=task_run` for the existing Task Run projection. Pass `source=journal` to query persistent `event_journal` rows.

Journal query is read-only telemetry:

- `accepted_state_authority` is always false.
- Chain and path HEADs are not read as authority and are not moved.
- Responses project identity columns only. `detail_json` is used for visibility and is not returned, so message bodies and LOD payloads stay out of the query result.
- Default visibility is participant: `actor_id`, `detail_json.sender_id`, or `detail_json.recipient_id` must match the caller.
- Null-actor chain telemetry (for example freshness checks) is returned only when `include_chain_telemetry=true` and `chain_name` matches.
- Filters are bounded: `event_class`, `event_type`, `chain_name`, `object_ref`, `stone_hash`, exclusive `since`, exclusive `after_cursor`, and `limit` 1–100.
- `source=journal` requires `CORE_AUTH_CONTEXT.principal_id`. The participant boundary is that principal, not a caller-supplied `actor_id`. A mismatched `actor_id` is rejected. Legacy unauthenticated `/mcp` is denied for journal source and unchanged for the Task Run projection.
- `include_chain_telemetry` still requires `chain_name` and cannot substitute for the authenticated principal.
- No new migration. No DO/WS upgrade.
