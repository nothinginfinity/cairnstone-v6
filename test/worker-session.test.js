import assert from "node:assert/strict";
import { test } from "node:test";
import { createCorrespondenceService } from "../src/correspondence.js";
import {
  SUBAGENT_RESULT_SCHEMA,
  SUBAGENT_RESULT_MAX_ANSWER_BYTES
} from "../src/subagent-result.js";
import {
  TASK_REQUEST_SCHEMA,
  TASK_RESULT_SCHEMA,
  WORKER_SESSION_RESULT_SCHEMA,
  RUN_TASK_REQUEST_TOOL_DEFINITION,
  buildTaskRequestContent,
  buildTaskResultContent,
  parseTaskRequest,
  selectTaskRequestCandidates,
  runTaskRequestFromBody
} from "../src/worker-session.js";

const HASH_A = "a".repeat(64);

function makeCorrespondenceHarness() {
  const deliveries = [];
  const stones = new Map();
  const raw = new Map();
  let stoneCreates = 0;
  let tick = 0;
  const setAsHeadCalls = [];

  const store = {
    async findByMessage(senderId, messageId) {
      return deliveries
        .filter(row => row.sender_id === senderId && row.message_id === messageId)
        .sort((a, b) => a.recipient_id.localeCompare(b.recipient_id));
    },
    async insertDeliveries(rows) {
      for (const row of rows) {
        const exists = deliveries.some(existing =>
          existing.sender_id === row.sender_id &&
          existing.message_id === row.message_id &&
          existing.recipient_id === row.recipient_id
        );
        if (!exists) deliveries.push({ ...row });
      }
      return this.findByMessage(rows[0].sender_id, rows[0].message_id);
    },
    async listInbox(recipientId, options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
      return deliveries
        .filter(row => row.recipient_id === recipientId)
        .filter(row => !options.status || row.status === options.status)
        .filter(row => !options.thread_id || row.thread_id === options.thread_id)
        .filter(row => !options.since || String(row.created_at) >= String(options.since))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit)
        .map(row => ({ ...row, stone_json: stones.get(row.stone_hash).stone_json }));
    },
    async getDelivery(recipientId, selector) {
      return deliveries.find(row =>
        row.recipient_id === recipientId &&
        (selector.message_id ? row.message_id === selector.message_id : row.stone_hash === selector.stone_hash)
      ) || null;
    },
    async markRead(id, readAt) {
      const row = deliveries.find(item => item.id === id);
      if (!row) return null;
      if (row.status === "queued" || row.status === "delivered") row.status = "read";
      row.delivered_at ||= readAt;
      row.read_at ||= readAt;
      return { ...row };
    },
    async getStoneRecord(stoneHash) {
      return stones.get(stoneHash) || null;
    }
  };

  const service = createCorrespondenceService({
    store,
    async createStone(body) {
      stoneCreates += 1;
      setAsHeadCalls.push(body.set_as_head);
      assert.equal(body.set_as_head, false, "worker session correspondence must not set HEAD");
      const stoneHash = `stone-${stoneCreates}`;
      const rawKey = `raw/${stoneHash}.txt`;
      const stone = {
        border: {
          hash: stoneHash,
          title: body.title,
          author: body.author,
          path: body.path,
          chain: body.chain || null
        },
        metadata: body.metadata,
        layers: {
          lod5: `${body.title}: compact correspondence message`,
          lod1: { raw_key: rawKey }
        }
      };
      stones.set(stoneHash, { hash: stoneHash, raw_key: rawKey, stone_json: JSON.stringify(stone) });
      raw.set(rawKey, body.content);
      return { ok: true, stone_hash: stoneHash, stone, input: body };
    },
    async readRaw(rawKey) {
      return raw.get(rawKey) ?? null;
    },
    now() {
      tick += 1;
      return `2026-09-07T06:${String(tick).padStart(2, "0")}:00.000Z`;
    },
    randomUUID() {
      return `uuid-${stoneCreates + 1}`;
    },
    async hash(value) {
      return `hash:${value}`;
    }
  });

  return {
    service,
    deliveries,
    stones,
    get stoneCreates() { return stoneCreates; },
    get setAsHeadCalls() { return setAsHeadCalls; }
  };
}

function compactDelegationResult({ answer = "Grounded answer.", turns = 2 } = {}) {
  return {
    ok: true,
    schema: SUBAGENT_RESULT_SCHEMA,
    package_id: `sha256:${"1".repeat(64)}`,
    profile_id: null,
    chain: "cairnstone-conversation",
    actor_id: "grok-bot:cairnstone-v6",
    task_fingerprint: `sha256:${"2".repeat(64)}`,
    answer,
    citations: [
      { stone_hash: HASH_A, path: "conversation/decisions.md", authority: "PATH_HEAD" }
    ],
    expand_hints: [{ stone_hash: HASH_A, ref_id: "ref-1", line_start: 1, context_lines: 4 }],
    tool_receipts: [],
    diagnostics: {
      answer_bytes: Buffer.byteLength(answer, "utf8"),
      turns,
      stop_reason: "final_answer",
      context_package_returned: false,
      server_carried_context_package: true
    },
    policy: {
      delegation_mode: "brokered_read_loop",
      tools_exposed_to_model: 0,
      tools_executed: 0,
      execution_authority: false,
      mutation_authority: false,
      accepted_state_mutation: false,
      parent_should_keep: ["answer", "citations"],
      expand_via: "expand_hints"
    }
  };
}

function makeRunner(options = {}) {
  const h = makeCorrespondenceHarness();
  const delegateCalls = [];
  const headWriteAttempts = [];

  const deps = {
    getInboxFromBody: (body) => h.service.getInbox(body),
    readMessageFromBody: (body) => h.service.readMessage(body),
    sendMessageFromBody: (body) => h.service.sendMessage(body),
    delegateFromBody: async (body) => {
      delegateCalls.push(body);
      if (typeof options.delegate === "function") return options.delegate(body, { headWriteAttempts });
      // Simulate deny path: mutation intents never become HEAD writes.
      if (options.forceDeny) {
        return {
          ok: false,
          error: "tool_authorization_required",
          detail: { decision: "require_authorization", tool_id: "cairnstone_set_head" },
          diagnostics: { stop_reason: "require_authorization" },
          policy: {
            mutation_authority: false,
            execution_authority: false,
            accepted_state_mutation: false
          }
        };
      }
      return compactDelegationResult(options.compact || {});
    },
    // Explicitly unavailable — worker must never call these.
    setHeadFromBody: async () => {
      headWriteAttempts.push("set_head");
      throw new Error("set_head must not be called by worker session");
    },
    setPathHeadFromBody: async () => {
      headWriteAttempts.push("set_path_head");
      throw new Error("set_path_head must not be called by worker session");
    }
  };

  return { h, deps, delegateCalls, headWriteAttempts };
}

test("worker-session tool schema stays closed", () => {
  assert.equal(RUN_TASK_REQUEST_TOOL_DEFINITION.name, "cairnstone_run_task_request");
  assert.equal(RUN_TASK_REQUEST_TOOL_DEFINITION.inputSchema.additionalProperties, false);
  assert.deepEqual(RUN_TASK_REQUEST_TOOL_DEFINITION.inputSchema.required, ["worker_actor_id", "route"]);
});

test("build/parse task_request round-trip", () => {
  const content = buildTaskRequestContent({
    task: "Summarize dual-inbox decision",
    chain: "cairnstone-conversation",
    max_turns: 4,
    compact_result: true,
    profile_id: null
  });
  const parsed = parseTaskRequest(content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.request.schema, TASK_REQUEST_SCHEMA);
  assert.equal(parsed.request.task, "Summarize dual-inbox decision");
  assert.equal(parsed.request.chain, "cairnstone-conversation");
  assert.equal(parsed.request.max_turns, 4);
  assert.equal(parsed.request.compact_result, true);
});

test("parseTaskRequest accepts plain text when chain fallback provided", () => {
  const parsed = parseTaskRequest("Plain task body", { chain: "cairnstone-v6-project-memory", max_turns: 2 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.request.schema, "plain_text");
  assert.equal(parsed.request.chain, "cairnstone-v6-project-memory");
  assert.equal(parsed.request.max_turns, 2);
});

test("selectTaskRequestCandidates filters by intent and own recipient only", () => {
  const inbox = {
    ok: true,
    recipient_id: "grok-bot:cairnstone-v6",
    messages: [
      {
        message_id: "msg:other-intent",
        recipient_id: "grok-bot:cairnstone-v6",
        intent: "handoff",
        created_at: "2026-09-07T06:01:00.000Z"
      },
      {
        message_id: "msg:task-new",
        recipient_id: "grok-bot:cairnstone-v6",
        intent: "task_request",
        created_at: "2026-09-07T06:03:00.000Z"
      },
      {
        message_id: "msg:task-old",
        recipient_id: "grok-bot:cairnstone-v6",
        intent: "task_request",
        created_at: "2026-09-07T06:02:00.000Z"
      },
      {
        message_id: "msg:foreign",
        recipient_id: "chatgpt:cairnstone-v6",
        intent: "task_request",
        created_at: "2026-09-07T06:00:00.000Z"
      }
    ]
  };
  const selected = selectTaskRequestCandidates(inbox, "grok-bot:cairnstone-v6");
  assert.equal(selected.ok, true);
  assert.equal(selected.total, 2);
  assert.equal(selected.candidates[0].message_id, "msg:task-old");
  assert.equal(selected.candidates[1].message_id, "msg:task-new");
});

test("selectTaskRequestCandidates denies foreign inbox recipient_id", () => {
  const selected = selectTaskRequestCandidates({
    ok: true,
    recipient_id: "chatgpt:cairnstone-v6",
    messages: []
  }, "grok-bot:cairnstone-v6");
  assert.equal(selected.ok, false);
  assert.equal(selected.error, "foreign_inbox_denied");
});

test("pickup by thread_id + since produces compact task_result without HEAD writes", async () => {
  const { h, deps, delegateCalls, headWriteAttempts } = makeRunner();
  const parent = "chatgpt:cairnstone-v6";
  const worker = "grok-bot:cairnstone-v6";
  const threadId = "worker-thread-alpha";

  await h.service.sendMessage({
    from: parent,
    to: [worker],
    intent: "message",
    thread_id: threadId,
    message_id: "msg:noise",
    content: "not a task",
    subject: "noise"
  });

  const older = await h.service.sendMessage({
    from: parent,
    to: [worker],
    intent: "task_request",
    thread_id: "other-thread",
    message_id: "msg:other-thread",
    content: buildTaskRequestContent({
      task: "Wrong thread task",
      chain: "cairnstone-conversation"
    }),
    subject: "other thread"
  });
  assert.equal(older.ok, true);

  const request = await h.service.sendMessage({
    from: parent,
    to: [worker],
    intent: "task_request",
    thread_id: threadId,
    message_id: "msg:task-req-1",
    content: buildTaskRequestContent({
      task: "Summarize dual-inbox AC1 decision",
      chain: "cairnstone-conversation",
      max_turns: 4
    }),
    subject: "dual-inbox"
  });
  assert.equal(request.ok, true);
  assert.equal(request.chain_head_written, false);

  const since = h.deliveries.find(row => row.message_id === "msg:task-req-1").created_at;
  const out = await runTaskRequestFromBody({
    worker_actor_id: worker,
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    thread_id: threadId,
    since
  }, {}, deps);

  assert.equal(out.ok, true);
  assert.equal(out.schema, WORKER_SESSION_RESULT_SCHEMA);
  assert.equal(out.picked_up, true);
  assert.equal(out.status, "ok");
  assert.equal(out.request.message_id, "msg:task-req-1");
  assert.equal(out.request.thread_id, threadId);
  assert.equal(out.task_result.intent, "task_result");
  assert.equal(out.task_result.chain_head_written, false);
  assert.equal(out.policy.mutation_authority, false);
  assert.equal(out.policy.accepted_state_mutation, false);
  assert.equal(out.policy.set_head_allowed, false);
  assert.equal(out.answer, "Grounded answer.");
  assert.equal(out.citations[0].stone_hash, HASH_A);

  assert.equal(delegateCalls.length, 1);
  assert.equal(delegateCalls[0].actor_id, worker);
  assert.equal(delegateCalls[0].max_turns, 4);
  assert.equal(delegateCalls[0].compact_result, true);
  assert.equal(delegateCalls[0].chain, "cairnstone-conversation");

  const parentInbox = await h.service.getInbox({ recipient_id: parent, thread_id: threadId });
  assert.equal(parentInbox.ok, true);
  assert.equal(parentInbox.total, 1);
  assert.equal(parentInbox.messages[0].intent, "task_result");

  const resultRead = await h.service.readMessage({
    recipient_id: parent,
    message_id: parentInbox.messages[0].message_id
  });
  const body = JSON.parse(resultRead.content);
  assert.equal(body.schema, TASK_RESULT_SCHEMA);
  assert.equal(body.status, "ok");
  assert.equal(body.compact_result_schema, SUBAGENT_RESULT_SCHEMA);
  assert.equal(body.result.schema, SUBAGENT_RESULT_SCHEMA);
  assert.equal(body.policy.accepted_state_mutation, false);

  assert.equal(headWriteAttempts.length, 0);
  assert.ok(h.setAsHeadCalls.every(v => v === false));
});

test("message_id pickup ignores other threads and returns idle when empty", async () => {
  const { h, deps } = makeRunner();
  const worker = "grok-bot:cairnstone-v6";
  const parent = "chatgpt:cairnstone-v6";

  await h.service.sendMessage({
    from: parent,
    to: [worker],
    intent: "task_request",
    thread_id: "thread-z",
    message_id: "msg:exact",
    content: buildTaskRequestContent({
      task: "Exact message task",
      chain: "cairnstone-v6-project-memory"
    })
  });

  const exact = await runTaskRequestFromBody({
    worker_actor_id: worker,
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    message_id: "msg:exact"
  }, {}, deps);
  assert.equal(exact.ok, true);
  assert.equal(exact.request.message_id, "msg:exact");

  const idle = await runTaskRequestFromBody({
    worker_actor_id: worker,
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    thread_id: "no-such-thread",
    since: "2099-01-01T00:00:00.000Z"
  }, {}, deps);
  assert.equal(idle.ok, true);
  assert.equal(idle.status, "idle");
  assert.equal(idle.picked_up, false);
});

test("deny/require_authorization path stays closed — still emits task_result, never HEAD", async () => {
  const { h, deps, headWriteAttempts } = makeRunner({ forceDeny: true });
  const worker = "grok-bot:cairnstone-v6";
  const parent = "claude:cairnstone-v6";

  await h.service.sendMessage({
    from: parent,
    to: [worker],
    intent: "task_request",
    thread_id: "deny-thread",
    message_id: "msg:deny-task",
    content: buildTaskRequestContent({
      task: "Attempt something that would need set_head",
      chain: "cairnstone-v6-project-memory",
      max_turns: 4
    })
  });

  const out = await runTaskRequestFromBody({
    worker_actor_id: worker,
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    message_id: "msg:deny-task"
  }, {}, deps);

  assert.equal(out.ok, true);
  assert.equal(out.status, "failed");
  assert.equal(out.picked_up, true);
  assert.equal(out.task_result.chain_head_written, false);
  assert.equal(out.policy.mutation_authority, false);
  assert.equal(out.delegation.error, "tool_authorization_required");
  assert.equal(headWriteAttempts.length, 0);

  const parentInbox = await h.service.getInbox({ recipient_id: parent, thread_id: "deny-thread" });
  assert.equal(parentInbox.total, 1);
  const read = await h.service.readMessage({
    recipient_id: parent,
    message_id: parentInbox.messages[0].message_id
  });
  const body = JSON.parse(read.content);
  assert.equal(body.status, "failed");
  assert.equal(body.error, "tool_authorization_required");
  assert.equal(body.policy.mutation_authority, false);
});

test("buildTaskResultContent embeds subagent compact schema", () => {
  const content = buildTaskResultContent({
    request_message_id: "msg:1",
    thread_id: "t1",
    worker_actor_id: "grok-bot:cairnstone-v6",
    status: "ok",
    subagent_result: compactDelegationResult({ answer: "Hi" })
  });
  const body = JSON.parse(content);
  assert.equal(body.schema, TASK_RESULT_SCHEMA);
  assert.equal(body.compact_result_schema, SUBAGENT_RESULT_SCHEMA);
  assert.equal(body.answer, "Hi");
  assert.equal(body.result.citations[0].stone_hash, HASH_A);
});

test("oversized compact answer still fail-closes through worker reply path", async () => {
  const huge = "x".repeat(SUBAGENT_RESULT_MAX_ANSWER_BYTES + 8);
  const { h, deps } = makeRunner({
    delegate: async () => ({
      ok: false,
      error: "subagent_answer_exceeds_cap",
      detail: { max_answer_bytes: SUBAGENT_RESULT_MAX_ANSWER_BYTES, answer_bytes: Buffer.byteLength(huge, "utf8") },
      policy: { mutation_authority: false, accepted_state_mutation: false }
    })
  });
  const worker = "grok-bot:cairnstone-v6";
  await h.service.sendMessage({
    from: "chatgpt:cairnstone-v6",
    to: [worker],
    intent: "task_request",
    message_id: "msg:oversized",
    thread_id: "cap-thread",
    content: buildTaskRequestContent({
      task: "Produce an oversized answer",
      chain: "cairnstone-conversation"
    })
  });

  const out = await runTaskRequestFromBody({
    worker_actor_id: worker,
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    message_id: "msg:oversized"
  }, {}, deps);

  assert.equal(out.ok, true);
  assert.equal(out.status, "failed");
  assert.equal(out.delegation.error, "subagent_answer_exceeds_cap");
  assert.equal(out.policy.set_head_allowed, false);
});

test("worker refuses to process non-task_request when message_id is forced", async () => {
  const { h, deps } = makeRunner();
  const worker = "grok-bot:cairnstone-v6";
  await h.service.sendMessage({
    from: "chatgpt:cairnstone-v6",
    to: [worker],
    intent: "handoff",
    message_id: "msg:handoff-only",
    content: "not a task request"
  });
  const out = await runTaskRequestFromBody({
    worker_actor_id: worker,
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    message_id: "msg:handoff-only"
  }, {}, deps);
  assert.equal(out.ok, false);
  assert.equal(out.error, "not_a_task_request");
});
