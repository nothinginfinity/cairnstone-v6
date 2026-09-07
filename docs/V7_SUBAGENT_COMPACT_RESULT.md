# Subagent compact-result contract (`cairnstone-subagent-result-v1`)

Status: **first bounded slice** (propose/implement). Wraps existing `cairnstone_delegate` only.
Non-goals: no multi-turn brokered tool loop, no `set_head` / `set_path_head`, no deploy, no new Cloudflare bindings, no paid/x402 work.

Origin proposal: AC1 message `msg:propose-subagent-brokered-read-loop-20260907` (recommended engineering step 4: compact-result wrapper before the loop).

## Purpose

Parent LLMs (Grok Bot, ChatGPT, Claude) should keep **answer + citations**, not the full V7.0 context package or the fuller `cairnstone-delegation-result-v1` evidence dump. Server-side delegation still compiles context and (optionally) runs V7.4 profile automatic reads; the parent receives a bounded envelope.

## How parents consume compact results

1. Call `cairnstone_delegate` with the usual fields **and** `compact_result: true`.
2. Keep `answer` and `citations[]` in parent context by default.
3. Expand only when needed via `expand_hints[]` (`cairnstone_expand` / `cairnstone_stone_v2` on hinted `stone_hash` / `ref_id`).
4. Treat `tool_receipts[]` and `diagnostics` as optional receipts — not primary reading material.
5. Never treat the compact result as mutation authority. Correspondence/transport remains separate from accepted-state writes.

## MCP input (additive)

`cairnstone_delegate` gains one optional boolean (schema remains `additionalProperties: false`):

```json
{
  "actor_id": "chatgpt:cairnstone-v7",
  "task": "Summarize the accepted decision for X.",
  "chain": "cairnstone-conversation",
  "route": { "provider": "workers-ai", "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  "compact_result": true
}
```

- Default `compact_result` omitted/false → unchanged `cairnstone-delegation-result-v1`.
- `compact_result: true` → `cairnstone-subagent-result-v1` built from the same internals.
- When compact mode is on, `generation.max_output_tokens` is clamped to **1200**.

## Schema: `cairnstone-subagent-result-v1`

```json
{
  "ok": true,
  "schema": "cairnstone-subagent-result-v1",
  "package_id": "sha256:<64-hex>",
  "profile_id": null,
  "chain": "cairnstone-v6-project-memory",
  "actor_id": "chatgpt:cairnstone-v7",
  "task_fingerprint": "sha256:<64-hex>",
  "request_ir_id": "sha256:<64-hex>",
  "route": { "provider": "mock-a", "model": "mock-a/text-tools-v1" },
  "answer": "Short grounded answer…",
  "citations": [
    {
      "stone_hash": "<64-hex>",
      "path": "project-memory/decisions.md",
      "authority": "PATH_HEAD",
      "note": "optional"
    }
  ],
  "expand_hints": [
    {
      "stone_hash": "<64-hex>",
      "ref_id": "optional",
      "line_start": 10,
      "context_lines": 20
    }
  ],
  "tool_receipts": [
    {
      "tool_id": "cairnstone_reconcile_repo",
      "receipt_stone_hash": "<64-hex>",
      "chain": "optional",
      "read_only": true
    }
  ],
  "diagnostics": {
    "answer_bytes": 420,
    "answer_tokens_estimate": 105,
    "max_answer_bytes": 4096,
    "max_answer_tokens_estimate": 1200,
    "answer_truncated": false,
    "turns": 1,
    "input_tokens": null,
    "output_tokens": null,
    "context_package_returned": false,
    "server_carried_context_package": true
  },
  "policy": {
    "delegation_mode": "read_only",
    "tools_exposed_to_model": 0,
    "tools_executed": 0,
    "execution_authority": false,
    "mutation_authority": false,
    "accepted_state_mutation": false,
    "parent_should_keep": ["answer", "citations"],
    "expand_via": "expand_hints"
  }
}
```

### Field notes

| Field | Rules |
| --- | --- |
| `task_fingerprint` | `sha256` of canonical `{actor_id, chain, task, profile_id}`. Identity for the request, not accepted-state authority. |
| `answer` | Hard cap **4096 UTF-8 bytes** (~4 KiB / ~1200 tokens at 4 bytes/token). **Fail closed** if exceeded (`error: "subagent_answer_exceeds_cap"`); never silently truncate into `ok: true`. |
| `citations[]` | Built from delegate evidence (`memory_refs`, path heads, chain head, selected skills). `authority` ∈ `CHAIN_HEAD` \| `PATH_HEAD` \| `HISTORICAL`. |
| `expand_hints[]` | Optional; parents expand selectively. |
| `tool_receipts[]` | Optional; profile automatic-read receipts when present. |
| `diagnostics` | Token/byte estimates, truncated flags, turn count (always `1` in this slice). |

## Authority

- Models receive **zero** execution/mutation authority.
- Compact wrapper never calls `set_head` / `set_path_head`.
- `policy.accepted_state_mutation` is always `false`.
- Correspondence remains transport-only.

## Implementation map

- Contract helpers: `src/subagent-result.js`
- Delegate wiring: optional `compact_result` on `cairnstone_delegate` in `src/model-router.js`
- Tests: `test/subagent-result.test.js`

## Manual smoke test (after a future deploy — not part of this PR)

1. `cairnstone_health` — confirm runtime advertises `cairnstone_delegate`.
2. `cairnstone_delegate(..., compact_result=true)` with a short task on an accepted chain + mock or live route.
3. Assert response `schema == "cairnstone-subagent-result-v1"`, `ok == true`, `answer` present, `citations` non-empty when evidence exists, `policy.mutation_authority == false`.
4. Force an oversized model answer (test harness) and assert `error == "subagent_answer_exceeds_cap"`.
5. Confirm chain/path HEADs unchanged via `cairnstone_resume_chain` before/after.

## Next slice (explicitly out of scope)

Brokered multi-turn read loop (`delegate_loop` / flag): model tool-intents → V7.3 broker automatic reads → re-ground → compact result. Do not implement here.
