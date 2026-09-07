# AC1 worker session pattern (`task_request` → `task_result`)

Status: **third bounded slice** of the subagent upgrade (after compact-result PR #2 and brokered read-loop PR #3).
Origin proposal: AC1 `msg:propose-subagent-brokered-read-loop-20260907` §C.

## Purpose

Let an **outer agent** hand a bounded vault task to a **CairnStone worker** over immutable AC1 correspondence without burning parent context:

1. Parent sends `intent: "task_request"` to a canonical product inbox.
2. Worker picks up **only its own** inbox via `get_inbox(own to, since=, thread_id=)`.
3. Worker runs vault-grounded work (prefer `cairnstone_delegate` with `max_turns` + `compact_result`).
4. Worker replies with `intent: "task_result"` whose body embeds `cairnstone-subagent-result-v1`.
5. Parent keeps **answer + citations** (and the result message id / stone hash); expands only via `expand_hints`.

## Hard non-goals

- No `set_head` / `set_path_head`
- No deploy / wrangler publish
- No new Cloudflare D1/R2/KV/Vectorize bindings
- No mutation auto-execution for models
- No new product inbox addresses — use the frozen canonical actor IDs
- Never scan another actor's inbox

Canonical product `to` addresses (do not invent new ones):

- `claude:cairnstone-v6`
- `chatgpt:cairnstone-v6`
- `grok:cairnstone-v6`
- `grok-bot:cairnstone-v6`
- `cursor:cairnstone-v6`

Device/session suffixes remain **from-only**.

## API choice

| Surface | Role |
| --- | --- |
| Existing `cairnstone_send_message` | Parent posts `task_request`; worker posts `task_result` |
| Existing `cairnstone_get_inbox` / `cairnstone_read_message` | Own-inbox pickup with `since` + `thread_id` |
| Existing `cairnstone_delegate` | Vault-grounded work (`max_turns`, `compact_result`) |
| **New** `cairnstone_run_task_request` | Thin one-tick orchestrator that composes the above reliably |

No giant new runtime. Schema remains `additionalProperties: false` on the new tool.

## Parent ritual (manual composition)

```json
{
  "from": "chatgpt:cairnstone-v6",
  "to": ["grok-bot:cairnstone-v6"],
  "intent": "task_request",
  "thread_id": "worker-thread-20260907-a",
  "message_id": "msg:task-req-dual-inbox",
  "subject": "Summarize dual-inbox AC1 decision",
  "content": "{\"schema\":\"cairnstone-task-request-v1\",\"task\":\"Summarize the accepted dual-inbox AC1 decision and cite it.\",\"chain\":\"cairnstone-conversation\",\"profile_id\":null,\"max_turns\":4,\"compact_result\":true,\"reply_to\":null,\"policy\":{\"transport_only\":true,\"execution_authority\":false,\"mutation_authority\":false,\"accepted_state_authority\":false}}"
}
```

Helper: `buildTaskRequestContent({ task, chain, ... })` in `src/worker-session.js`.

## Worker pickup ritual

1. `cairnstone_health`
2. `cairnstone_resume_chain` on the task chain (orientation only; no HEAD write)
3. Pickup one of:
   - **Thin tool:** `cairnstone_run_task_request({ worker_actor_id, route, thread_id?, since?, message_id? })`
   - **Manual:** `get_inbox(recipient_id=<own>, since=, thread_id=)` → filter `intent=="task_request"` → `read_message` → `delegate` → `send_message(intent="task_result")`

`since` is inclusive on delivery `created_at`. `thread_id` is an exact match. Filters AND-compose with optional `status` (default `delivered` when scanning).

Foreign inbox attempts fail closed with `foreign_inbox_denied`.

## `cairnstone_run_task_request` input

```json
{
  "worker_actor_id": "grok-bot:cairnstone-v6",
  "route": { "provider": "workers-ai", "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  "thread_id": "worker-thread-20260907-a",
  "since": "2026-09-07T00:00:00.000Z",
  "max_turns": 4,
  "compact_result": true
}
```

| Field | Notes |
| --- | --- |
| `worker_actor_id` | Own product inbox only |
| `route` | Required for the server-side delegate call |
| `message_id` | Process one exact request (skips inbox scan) |
| `thread_id` / `since` / `status` / `limit` | Inbox pickup filters |
| `max_turns` | Default **4** (brokered read loop) |
| `compact_result` | Default **true** |
| `profile_id` / `chain` | Overrides / plain-text fallbacks |
| `reply_to` | Defaults to the request sender |

When no matching `task_request` is found, the tool returns `ok:true`, `status:"idle"`, `picked_up:false` (no reply sent).

## Message contracts

### `cairnstone-task-request-v1` (message content)

```json
{
  "schema": "cairnstone-task-request-v1",
  "task": "…",
  "chain": "cairnstone-conversation",
  "profile_id": null,
  "package_id": null,
  "max_turns": 4,
  "compact_result": true,
  "reply_to": null,
  "policy": {
    "transport_only": true,
    "execution_authority": false,
    "mutation_authority": false,
    "accepted_state_authority": false
  }
}
```

Plain-text content is accepted only when the runner supplies `chain`. Handoff JSON (`cairnstone-handoff-v1`) may be processed if the delivery intent is `task_request`.

### `cairnstone-task-result-v1` (message content)

```json
{
  "schema": "cairnstone-task-result-v1",
  "request_message_id": "msg:task-req-dual-inbox",
  "thread_id": "worker-thread-20260907-a",
  "worker_actor_id": "grok-bot:cairnstone-v6",
  "status": "ok",
  "compact_result_schema": "cairnstone-subagent-result-v1",
  "answer": "Short grounded answer…",
  "citations": [{ "stone_hash": "…", "path": "…", "authority": "PATH_HEAD" }],
  "result": { "schema": "cairnstone-subagent-result-v1", "ok": true, "answer": "…", "citations": [] },
  "policy": {
    "transport_only": true,
    "execution_authority": false,
    "mutation_authority": false,
    "accepted_state_mutation": false,
    "embeds": "cairnstone-subagent-result-v1"
  }
}
```

Parent keep-path: **answer + citations** from the embedded compact result (also mirrored at the top level when present). Expand only via `expand_hints` inside `result`.

## Authority

- Worker session never calls `set_head` / `set_path_head`.
- Correspondence stones are created with `set_as_head: false` (`chain_head_written: false`).
- Delegate loop deny / `require_authorization` paths remain closed for mutations.
- `policy.mutation_authority` / `accepted_state_mutation` are always `false` on the worker result envelope.
- Own-inbox only: attempting another `recipient_id` fails closed.

## Implementation map

- Contract + orchestration: `src/worker-session.js`
- MCP wire-up: `cairnstone_run_task_request` in `src/index.js`
- Compact body: `src/subagent-result.js` / `docs/V7_SUBAGENT_COMPACT_RESULT.md`
- Delegate loop: `src/delegate-loop.js` / `docs/V7_SUBAGENT_DELEGATE_LOOP.md`
- Tests: `test/worker-session.test.js`

## Manual smoke (after a future deploy — not part of this PR)

1. Parent: `cairnstone_send_message(..., intent="task_request", thread_id=..., content=buildTaskRequestContent(...))` to a canonical worker inbox.
2. Worker: `cairnstone_run_task_request({ worker_actor_id, route, thread_id, since })`.
3. Assert `picked_up == true`, `task_result.chain_head_written == false`, embedded `result.schema == "cairnstone-subagent-result-v1"`, `policy.mutation_authority == false`.
4. Parent: `get_inbox(own to, thread_id=...)` → read the `task_result` → keep answer + citations.
5. Confirm HEADs unchanged via `cairnstone_resume_chain` before/after.
6. Force a mutation-class intent inside delegate (fixture) and confirm deny/`require_authorization` with no HEAD move.

## Follow-ups (explicitly deferred)

- Starter profiles `inbox-triage` and `decision-summarizer` (config-only; zero new authority)
- Ack/archive tooling
- Paid/x402 worker settlement
