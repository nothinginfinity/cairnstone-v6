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
