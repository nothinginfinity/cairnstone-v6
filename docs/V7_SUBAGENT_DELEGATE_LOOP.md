# Brokered multi-turn read loop (`cairnstone_delegate` + `max_turns`)

Status: **second bounded slice** of the subagent upgrade (after compact-result PR #2).
Origin proposal: AC1 `msg:propose-subagent-brokered-read-loop-20260907`.

## API choice

Extend existing `cairnstone_delegate` with optional `max_turns` (no new MCP tool).

| `max_turns` | Behavior |
| --- | --- |
| omitted / `1` | Existing single-shot V7.2/V7.4 path (model gets **zero** tools) |
| `2`..`8` | Brokered automatic-read loop (recommended **`4`**) |

**Compact default for loop mode:** when `max_turns >= 2` and `compact_result` is omitted, the server defaults to **`compact_result: true`** (`cairnstone-subagent-result-v1`). Pass `compact_result: false` to keep the fuller `cairnstone-delegation-result-v1`. Single-shot still defaults compact to false.

MCP input schema remains `additionalProperties: false`.

## How parents call the loop

```json
{
  "actor_id": "chatgpt:cairnstone-v7",
  "task": "Find the accepted decision about dual-inbox AC1 and cite it.",
  "chain": "cairnstone-v6-project-memory",
  "route": { "provider": "workers-ai", "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  "profile_id": "cairnstone-maintainer",
  "max_turns": 4
}
```

Optional: `"compact_result": false` if the parent wants the legacy delegation envelope.

Parent keep-path is unchanged from the compact-result slice: **answer + citations**; expand only via `expand_hints`.

## Loop sketch (server-side)

1. Compile V7.0 package (same bootstrap path; prefer sparse/runtime brief when configured).
2. Optional V7.4 profile automatic reads (unchanged pre-route grounding).
3. Model turn with **structured tool-intent channel only** — request IR lists allowlisted automatic-read tool ids; adapters still normalize to unexecuted `tool_intents` (`executed:false`).
4. For each proposed intent: `tool_policy_preview` → execute only when decision is `allow` **and** tool is in the loop allowlist (broker automatic-read ∩ optional `profile.tool_allowlist`).
5. `tool_execute` those intents; collect receipts + bounded evidence.
6. Re-ground working set into the next bootstrap task; next model turn.
7. Stop conditions (see below).
8. Emit compact result by default in loop mode.

## Allowlist

- Base set: broker registry entries with `risk_class:"read"` + `authorization:"automatic"`.
- With `profile_id`: intersect with that profile’s `tool_allowlist` (profiles may only **narrow**).
- Mutation-class tools are never on the allowlist and never appear in the model’s intent-channel tool list.

## Stop conditions

| Reason | Meaning |
| --- | --- |
| `final_answer` | Model returned text with **zero** tool intents |
| `max_turns` | Turn budget exhausted |
| `deny` | Policy deny / invalid intent / not on loop allowlist — **no execute** |
| `require_authorization` | Eligible only after auth — **no auto-run** |
| `budget` | Cross-loop automatic-read call budget exhausted |
| `bootstrap_failed` / `route_failed` | Infrastructure failure |

Deny / require_authorization stops the loop immediately and returns that status in the result (`error`, `detail.decision`, `diagnostics.stop_reason`). Prior automatic reads already executed in earlier turns remain in receipts; the blocked intent itself is never executed.

## Authority guarantees

- **Model intent is never execution authority.**
- Loop path never calls `set_head` / `set_path_head`.
- `policy.execution_authority`, `policy.mutation_authority`, and `policy.accepted_state_mutation` are always `false`.
- Tool execution stays outside provider adapters (same V7.3 broker as `cairnstone_tool_execute`).
- Immutable execution receipts may be written on `cairnstone-v7-tool-execution-receipts` (`set_as_head: false`) — correspondence/receipt transport only, not accepted-state authority.

## Diagnostics (compact)

When wrapped as `cairnstone-subagent-result-v1`:

- `diagnostics.turns` — model turns completed
- `diagnostics.stop_reason` — see table above
- `diagnostics.loop` — `{ max_turns, turns, stop_reason, allowlist_size }`
- `tool_receipts[]` — profile grounding + mid-loop automatic-read receipts
- `policy.delegation_mode` — `"brokered_read_loop"` when loop ran

## Implementation map

- Loop orchestration: `src/delegate-loop.js`
- Delegate wiring / MCP schema: `src/model-router.js` (`max_turns` on `cairnstone_delegate`)
- Compact wrapper: `src/subagent-result.js` (multi-turn diagnostics + loop receipts)
- Tests: `test/delegate-loop.test.js`
- Compact-result contract: `docs/V7_SUBAGENT_COMPACT_RESULT.md`

## Manual smoke (after a future deploy — not part of this PR)

1. `cairnstone_delegate(..., max_turns=4)` on an accepted chain with a mock or live route.
2. Assert compact schema by default, `diagnostics.turns >= 1`, `policy.mutation_authority == false`.
3. Force a mid-loop automatic read (fixture/mock returning a `cairnstone_health` intent) and confirm a receipt appears.
4. Force a `cairnstone_set_head` / `cairnstone_commit_v2` intent and confirm deny/require_authorization with HEADs unchanged via `cairnstone_resume_chain`.
5. Oversized final answer still fail-closes with `subagent_answer_exceeds_cap`.

## Non-goals (honored)

- No model-held mutation / set_head / set_path_head
- No deploy / wrangler publish
- No new Cloudflare D1/R2/KV/Vectorize bindings
- No paid/x402 work
- No ack/archive inbox tools
- No new starter profiles in this slice
