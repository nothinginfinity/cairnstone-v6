import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_SCHEMA,
  TREE_SCHEMA,
  EVENT_TYPES,
  JOURNAL_QUERY_SCHEMA,
  eventFromTaskRun,
  projectAgentTree,
  listEventsFromTaskRuns,
  subscribeHonesty,
  agentTreeFromBody,
  journalRowVisible,
  projectJournalEvent,
  queryJournalEvents,
  queryJournalFromBody,
  encodeJournalCursor,
  listEventPlaneFromBody
} from "../src/event-plane.js";
import worker, { handleMcpRpc, mcpToolsForProfile } from "../src/index.js";

test("proposed run maps to task_run.proposed with authority closed flags", () => {
  const event = eventFromTaskRun({
    task_run_id: "tr:proposed",
    status: "proposed",
    dispatch_state: "not_dispatched",
    created_at: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(event.schema, EVENT_SCHEMA);
  assert.equal(event.event_type, EVENT_TYPES.proposed);
  assert.equal(event.accepted_state_authority, false);
  assert.equal(event.chain_heads_mutated, false);
  assert.equal(event.path_heads_mutated, false);
});

test("dispatched/running map to operational dispatch or status events with no accepted authority", () => {
  const dispatched = eventFromTaskRun({
    task_run_id: "tr:queued",
    status: "queued",
    dispatch_state: "dispatched"
  });
  assert.equal(dispatched.event_type, EVENT_TYPES.dispatched);
  assert.equal(dispatched.accepted_state_authority, false);

  const running = eventFromTaskRun({
    task_run_id: "tr:running",
    status: "running",
    dispatch_state: "running"
  });
  assert.equal(running.event_type, EVENT_TYPES.status);
  assert.equal(running.accepted_state_authority, false);
});

test("projectAgentTree keeps parent/child hierarchy with depth cap and no head mutation flags", () => {
  const tree = projectAgentTree([
    { task_run_id: "tr:root", parent_task_run_id: null, status: "running", dispatch_state: "running" },
    { task_run_id: "tr:child", parent_task_run_id: "tr:root", status: "queued", dispatch_state: "dispatched" },
    { task_run_id: "tr:grandchild", parent_task_run_id: "tr:child", status: "queued", dispatch_state: "dispatched" },
    { task_run_id: "tr:too-deep", parent_task_run_id: "tr:grandchild", status: "queued", dispatch_state: "dispatched" }
  ]);

  assert.equal(tree.ok, true);
  assert.equal(tree.schema, TREE_SCHEMA);
  assert.equal(tree.accepted_state_authority, false);
  assert.equal(tree.chain_heads_mutated, false);
  assert.equal(tree.path_heads_mutated, false);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].task_run_id, "tr:root");
  assert.equal(tree.roots[0].parent_task_run_id, null);
  assert.equal(tree.roots[0].depth, 0);
  assert.equal(tree.roots[0].children[0].task_run_id, "tr:child");
  assert.equal(tree.roots[0].children[0].depth, 1);
  assert.equal(tree.roots[0].children[0].children[0].task_run_id, "tr:grandchild");
  assert.equal(tree.roots[0].children[0].children[0].depth, 2);
  assert.equal(tree.roots[0].children[0].children[0].children.length, 0);
});

test("subscribeHonesty reports upgrade_unavailable and DO/WS residual scope", () => {
  const result = subscribeHonesty();
  assert.equal(result.ok, false);
  assert.equal(result.error, "upgrade_unavailable");
  assert.match(result.detail, /DO\/WS/i);
  assert.equal(result.accepted_state_authority, false);
});

test("listEventsFromTaskRuns returns ok true and empty events for empty input", () => {
  const listed = listEventsFromTaskRuns([]);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.events, []);
});

test("listEventsFromTaskRuns applies since filter and limit clamp", () => {
  const listed = listEventsFromTaskRuns([
    { task_run_id: "tr:old", status: "proposed", dispatch_state: "not_dispatched", updated_at: "2026-01-01T00:00:00.000Z" },
    { task_run_id: "tr:new", status: "running", dispatch_state: "running", updated_at: "2026-01-03T00:00:00.000Z" },
    { task_run_id: "tr:mid", status: "queued", dispatch_state: "dispatched", updated_at: "2026-01-02T00:00:00.000Z" }
  ], { since: "2026-01-01T12:00:00.000Z", limit: 1 });
  assert.equal(listed.events.length, 1);
  assert.equal(listed.events[0].task_run_id, "tr:new");
});

function makeTaskRunRow(overrides = {}) {
  return {
    task_run_id: overrides.task_run_id,
    schema: "cairnstone-task-run-v1",
    status: overrides.status || "queued",
    conversation_id: null,
    parent_turn_id: null,
    requested_by: overrides.requested_by || "console:jared",
    assignee_actor_id: overrides.assignee_actor_id || null,
    requested_intent: "ask-to-work",
    intent_mode: "propose-action",
    attachment_refs_json: "[]",
    object_refs_json: "[]",
    note: null,
    dispatch_state: overrides.dispatch_state || "dispatched",
    selected_executor_id: null,
    executor_route_reason: null,
    required_capabilities_json: "[]",
    policy_preset: null,
    budget_envelope_json: null,
    parent_task_run_id: overrides.parent_task_run_id || null,
    child_task_run_ids_json: "[]",
    delegation_depth: 0,
    route_receipt_id: null,
    route_receipt_json: null,
    adapter_job_id: null,
    receipt_refs_json: "[]",
    artifact_refs_json: "[]",
    pr_refs_json: "[]",
    test_refs_json: "[]",
    result_summary: null,
    failure_reason: null,
    human_committed_by: null,
    human_committed_at: null,
    started_at: null,
    completed_at: null,
    created_at: overrides.created_at || "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at || "2026-01-01T00:00:00.000Z",
    cancelled_at: null,
    accepted_state_authority: 0
  };
}

function makeDb(rows = []) {
  const byId = new Map(rows.map(row => [row.task_run_id, row]));
  return {
    prepare(sql) {
      const args = [];
      return {
        bind(...bound) {
          args.push(...bound);
          return this;
        },
        async first() {
          if (!sql.includes("WHERE task_run_id = ?")) return null;
          return byId.get(args[0]) || null;
        },
        async all() {
          if (!sql.includes("FROM task_runs")) return { results: [] };
          const [actorA, actorB, actorC, statusA, statusB, _convA, _convB, _assigneeA, _assigneeB, parentA, parentB, limit] = args;
          const filtered = rows.filter((row) => {
            const actorMatch = row.requested_by === actorA || row.assignee_actor_id === actorB || row.human_committed_by === actorC;
            if (!actorMatch) return false;
            if (statusA !== null && row.status !== statusB) return false;
            if (parentA !== null && row.parent_task_run_id !== parentB) return false;
            return true;
          });
          return { results: filtered.slice(0, limit) };
        }
      };
    }
  };
}

test("agentTreeFromBody root_task_run_id loads descendants through capped depth", async () => {
  const db = makeDb([
    makeTaskRunRow({ task_run_id: "tr:root", requested_by: "console:jared", parent_task_run_id: null }),
    makeTaskRunRow({ task_run_id: "tr:child", requested_by: "console:jared", parent_task_run_id: "tr:root" }),
    makeTaskRunRow({ task_run_id: "tr:grandchild", requested_by: "console:jared", parent_task_run_id: "tr:child" }),
    makeTaskRunRow({ task_run_id: "tr:too-deep", requested_by: "console:jared", parent_task_run_id: "tr:grandchild" })
  ]);
  const result = await agentTreeFromBody({
    actor_id: "console:jared",
    root_task_run_id: "tr:root"
  }, { CAIRNSTONE_DB: db });

  assert.equal(result.ok, true);
  assert.equal(result.roots.length, 1);
  assert.equal(result.roots[0].task_run_id, "tr:root");
  assert.equal(result.roots[0].children[0].task_run_id, "tr:child");
  assert.equal(result.roots[0].children[0].children[0].task_run_id, "tr:grandchild");
  assert.equal(result.roots[0].children[0].children[0].children.length, 0);
});

test("agentTreeFromBody root traversal is not truncated by small response limit", async () => {
  const db = makeDb([
    makeTaskRunRow({ task_run_id: "tr:root", requested_by: "console:jared", parent_task_run_id: null }),
    makeTaskRunRow({ task_run_id: "tr:child", requested_by: "console:jared", parent_task_run_id: "tr:root" }),
    makeTaskRunRow({ task_run_id: "tr:grandchild", requested_by: "console:jared", parent_task_run_id: "tr:child" })
  ]);
  const result = await agentTreeFromBody({
    actor_id: "console:jared",
    root_task_run_id: "tr:root",
    limit: 1
  }, { CAIRNSTONE_DB: db });

  assert.equal(result.ok, true);
  assert.equal(result.roots[0].children[0].task_run_id, "tr:child");
  assert.equal(result.roots[0].children[0].children[0].task_run_id, "tr:grandchild");
});

test("agentTreeFromBody returns task_run_not_found for unknown root", async () => {
  const result = await agentTreeFromBody({
    actor_id: "console:jared",
    root_task_run_id: "tr:missing"
  }, { CAIRNSTONE_DB: makeDb([]) });
  assert.equal(result.ok, false);
  assert.equal(result.error, "task_run_not_found");
});

test("event plane MCP tools are exposed on mcpTools()", () => {
  const names = new Set(mcpToolsForProfile(false).map(t => t.name));
  assert.equal(names.has("cairnstone_event_list"), true);
  assert.equal(names.has("cairnstone_agent_tree"), true);
});

function journalRow(overrides = {}) {
  return {
    event_id: overrides.event_id,
    schema: "cairnstone-semantic-event-v1",
    event_type: overrides.event_type || "ac1.delivery.transitioned",
    event_class: overrides.event_class || "semantic",
    source: overrides.source || "journal",
    occurred_at: overrides.occurred_at,
    actor_id: Object.prototype.hasOwnProperty.call(overrides, "actor_id") ? overrides.actor_id : "grok:cairnstone-v6",
    object_ref: overrides.object_ref || "delivery:1",
    subject_ref: "stone:abc",
    chain_name: overrides.chain_name || null,
    path: overrides.path || null,
    stone_hash: overrides.stone_hash || "abc",
    from_state: overrides.from_state || null,
    to_state: overrides.to_state || "delivered",
    lod_level: null,
    observed_commit_sha: null,
    content_sha256: null,
    detail_json: JSON.stringify(overrides.detail || { recipient_id: "grok:cairnstone-v6", message_id: "msg:1", sender_id: "chatgpt:cairnstone-v6" }),
    accepted_state_authority: overrides.accepted_state_authority ?? 0,
    body: "secret message body must not leak"
  };
}

test("journal query is participant-scoped and does not project payload fields", () => {
  const own = journalRow({ event_id: "evt:own", occurred_at: "2026-10-06T00:01:00.000Z" });
  const other = journalRow({
    event_id: "evt:other",
    occurred_at: "2026-10-06T00:02:00.000Z",
    actor_id: "claude:cairnstone-v6",
    detail: { recipient_id: "claude:cairnstone-v6", sender_id: "chatgpt:cairnstone-v6", message_id: "msg:other", body: "hidden" }
  });
  const senderVisible = journalRow({
    event_id: "evt:sender",
    occurred_at: "2026-10-06T00:03:00.000Z",
    actor_id: "claude:cairnstone-v6",
    detail: { recipient_id: "claude:cairnstone-v6", sender_id: "grok:cairnstone-v6", message_id: "msg:sent" }
  });
  const listed = queryJournalEvents([own, other, senderVisible], { actor_id: "grok:cairnstone-v6" });
  assert.equal(listed.ok, true);
  assert.equal(listed.schema, JOURNAL_QUERY_SCHEMA);
  assert.equal(listed.accepted_state_authority, false);
  assert.equal(listed.chain_heads_mutated, false);
  assert.equal(listed.path_heads_mutated, false);
  assert.deepEqual(listed.events.map(event => event.event_id), ["evt:sender", "evt:own"]);
  for (const event of listed.events) {
    assert.equal(event.accepted_state_authority, false);
    assert.equal("detail_json" in event, false);
    assert.equal("body" in event, false);
    assert.equal(JSON.stringify(event).includes("secret message body"), false);
    assert.equal(JSON.stringify(event).includes("hidden"), false);
  }
  assert.equal(journalRowVisible(other, { actor_id: "grok:cairnstone-v6" }), false);
});

test("journal query applies event class, source, exclusive cursor, and limit", () => {
  const rows = [
    journalRow({ event_id: "evt:c", occurred_at: "2026-10-06T00:03:00.000Z", event_class: "semantic" }),
    journalRow({ event_id: "evt:b", occurred_at: "2026-10-06T00:02:00.000Z", event_class: "semantic" }),
    journalRow({ event_id: "evt:a", occurred_at: "2026-10-06T00:01:00.000Z", event_class: "operational" })
  ];
  const first = queryJournalEvents(rows, { actor_id: "grok:cairnstone-v6", event_class: "semantic", limit: 1 });
  assert.equal(first.events[0].event_id, "evt:c");
  assert.ok(first.next_cursor);
  const second = queryJournalEvents(rows, {
    actor_id: "grok:cairnstone-v6",
    event_class: "semantic",
    after_cursor: first.next_cursor,
    limit: 10
  });
  assert.deepEqual(second.events.map(event => event.event_id), ["evt:b"]);
  assert.equal(second.next_cursor, null);
  const encoded = encodeJournalCursor(first.events[0]);
  assert.equal(encoded, first.next_cursor);
});

test("null-actor chain telemetry stays hidden unless chain scope is explicit", () => {
  const freshness = journalRow({
    event_id: "evt:fresh",
    occurred_at: "2026-10-06T00:04:00.000Z",
    event_type: "freshness.checked",
    actor_id: null,
    chain_name: "cairnstone-v6-project-memory",
    path: "src/event-plane.js",
    detail: { outcome: "in_sync" }
  });
  const hidden = queryJournalEvents([freshness], { actor_id: "grok:cairnstone-v6" });
  assert.deepEqual(hidden.events, []);
  const shown = queryJournalEvents([freshness], {
    actor_id: "grok:cairnstone-v6",
    chain_name: "cairnstone-v6-project-memory",
    include_chain_telemetry: true
  });
  assert.equal(shown.events[0].event_id, "evt:fresh");
  assert.equal(shown.events[0].content_sha256, null);
  assert.equal(projectJournalEvent(freshness).accepted_state_authority, false);
});

test("journal D1 query enforces visibility and omits other actors", async () => {
  const rows = [
    journalRow({ event_id: "evt:own", occurred_at: "2026-10-06T00:02:00.000Z" }),
    journalRow({
      event_id: "evt:other",
      occurred_at: "2026-10-06T00:03:00.000Z",
      actor_id: "claude:cairnstone-v6",
      detail: { recipient_id: "claude:cairnstone-v6", sender_id: "chatgpt:cairnstone-v6" }
    })
  ];
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM event_journal/);
      assert.match(sql, /accepted_state_authority = 0/);
      const args = [];
      return {
        bind(...bound) {
          args.push(...bound);
          return this;
        },
        async all() {
          const actorId = args[0];
          const includeChain = args[3] === 1;
          const chainName = args[4];
          const eventClass = args[5];
          const eventType = args[7];
          const filterChain = args[9];
          const objectRef = args[11];
          const stoneHash = args[13];
          const since = args[15];
          const cursorAt = args[17];
          const cursorId = args[20];
          const limit = args[21];
          const visible = rows.filter((row) => {
            const detail = JSON.parse(row.detail_json);
            const participant = row.actor_id === actorId || detail.sender_id === actorId || detail.recipient_id === actorId;
            const chainTelemetry = includeChain && row.actor_id == null && row.chain_name === chainName;
            if (!participant && !chainTelemetry) return false;
            if (eventClass && row.event_class !== eventClass) return false;
            if (eventType && row.event_type !== eventType) return false;
            if (filterChain && row.chain_name !== filterChain) return false;
            if (objectRef && row.object_ref !== objectRef) return false;
            if (stoneHash && row.stone_hash !== stoneHash) return false;
            if (since && !(row.occurred_at > since)) return false;
            if (cursorAt && !(row.occurred_at < cursorAt || (row.occurred_at === cursorAt && row.event_id < cursorId))) return false;
            return true;
          }).sort((a, b) => a.occurred_at < b.occurred_at ? 1 : -1);
          return { results: visible.slice(0, limit) };
        }
      };
    }
  };
  const authEnv = { CORE_AUTH_CONTEXT: { principal_id: "grok:cairnstone-v6" } };
  const listed = await queryJournalFromBody({ actor_id: "grok:cairnstone-v6", source: "journal" }, db, authEnv);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.events.map(event => event.event_id), ["evt:own"]);
  assert.equal(listed.events[0].accepted_state_authority, false);
  const missing = await listEventPlaneFromBody({ source: "journal" }, { CAIRNSTONE_DB: db });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "journal_auth_required");
  const spoofed = await queryJournalFromBody({ actor_id: "claude:cairnstone-v6", source: "journal" }, db, authEnv);
  assert.equal(spoofed.ok, false);
  assert.equal(spoofed.error, "actor_mismatch");
  const bad = await listEventPlaneFromBody({ actor_id: "grok:cairnstone-v6", source: "other" }, { CAIRNSTONE_DB: db });
  assert.equal(bad.error, "invalid_source");
});

function rpcText(rpc) {
  return JSON.parse(rpc.result.content[0].text);
}

test("MCP journal query uses trusted principal and denies legacy spoofing", async () => {
  const rows = [
    journalRow({ event_id: "evt:own", occurred_at: "2026-10-06T00:02:00.000Z", object_ref: "delivery:own", stone_hash: "hashown" }),
    journalRow({
      event_id: "evt:other",
      occurred_at: "2026-10-06T00:03:00.000Z",
      actor_id: "claude:cairnstone-v6",
      object_ref: "delivery:other",
      detail: { recipient_id: "claude:cairnstone-v6", sender_id: "chatgpt:cairnstone-v6", body: "hidden body" }
    })
  ];
  const db = {
    prepare(sql) {
      const args = [];
      return {
        bind(...bound) {
          args.push(...bound);
          return this;
        },
        async all() {
          if (!sql.includes("FROM event_journal")) return { results: [] };
          const actorId = args[0];
          const objectRef = args[11];
          const stoneHash = args[13];
          const visible = rows.filter((row) => {
            const detail = JSON.parse(row.detail_json);
            const participant = row.actor_id === actorId || detail.sender_id === actorId || detail.recipient_id === actorId;
            if (!participant) return false;
            if (objectRef && row.object_ref !== objectRef) return false;
            if (stoneHash && row.stone_hash !== stoneHash) return false;
            return true;
          });
          return { results: visible };
        },
        async first() { return null; }
      };
    }
  };
  const env = { CAIRNSTONE_DB: db };
  const call = (args, authContext) => handleMcpRpc({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "cairnstone_event_list", arguments: args }
  }, env, authContext ? { authContext } : {});

  const allowed = await call({ source: "journal", actor_id: "grok:cairnstone-v6" }, { principal_id: "grok:cairnstone-v6" });
  assert.equal(allowed.result.isError, false);
  const payload = rpcText(allowed);
  assert.deepEqual(payload.events.map(event => event.event_id), ["evt:own"]);
  assert.equal(JSON.stringify(payload).includes("hidden body"), false);
  assert.equal(payload.accepted_state_authority, false);

  const filtered = await call({ source: "journal", object_ref: "delivery:own", stone_hash: "hashown" }, { principal_id: "grok:cairnstone-v6" });
  assert.equal(rpcText(filtered).events[0].event_id, "evt:own");

  const spoofed = await call({ source: "journal", actor_id: "claude:cairnstone-v6", include_chain_telemetry: true, chain_name: "cairnstone-v6-project-memory" }, { principal_id: "grok:cairnstone-v6" });
  assert.equal(spoofed.result.isError, true);
  assert.equal(rpcText(spoofed).error, "caller_assertion_forbidden");

  const legacy = await call({ source: "journal", actor_id: "grok:cairnstone-v6" });
  assert.equal(legacy.result.isError, true);
  assert.equal(rpcText(legacy).error, "journal_auth_required");

  const taskRun = await call({ actor_id: "grok:cairnstone-v6" });
  assert.equal(taskRun.result.isError, false);
  assert.equal(rpcText(taskRun).schema, "cairnstone-event-v1");
});


function namesFromList(rpc) {
  return rpc.result.tools.map(tool => tool.name);
}

test("authenticated Core advertises event list; unauthenticated Core does not", async () => {
  const authList = await handleMcpRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list"
  }, {}, { core: true, auth: true, authContext: { principal_id: "grok:cairnstone-v6" } });
  assert.equal(namesFromList(authList).includes("cairnstone_event_list"), true);

  const coreList = await handleMcpRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list"
  }, {}, { core: true });
  assert.equal(namesFromList(coreList).includes("cairnstone_event_list"), false);

  const coreHttp = await worker.fetch(new Request("https://cairnstone.test/mcp/core", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })
  }), {});
  const coreBody = await coreHttp.json();
  assert.equal(coreBody.result.tools.some(tool => tool.name === "cairnstone_event_list"), false);
});

test("authenticated Core journal call uses principal and legacy journal stays denied", async () => {
  const rows = [
    journalRow({ event_id: "evt:own", occurred_at: "2026-10-06T00:02:00.000Z" }),
    journalRow({
      event_id: "evt:other",
      occurred_at: "2026-10-06T00:03:00.000Z",
      actor_id: "claude:cairnstone-v6",
      detail: { recipient_id: "claude:cairnstone-v6", sender_id: "chatgpt:cairnstone-v6", body: "hidden body" }
    })
  ];
  const db = {
    prepare(sql) {
      const args = [];
      return {
        bind(...bound) {
          args.push(...bound);
          return this;
        },
        async all() {
          if (!sql.includes("FROM event_journal")) return { results: [] };
          const actorId = args[0];
          return { results: rows.filter((row) => row.actor_id === actorId || JSON.parse(row.detail_json).sender_id === actorId || JSON.parse(row.detail_json).recipient_id === actorId) };
        },
        async first() { return null; }
      };
    }
  };
  const allowed = await handleMcpRpc({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "cairnstone_event_list", arguments: { source: "journal" } }
  }, { CAIRNSTONE_DB: db }, { core: true, auth: true, authContext: { principal_id: "grok:cairnstone-v6" } });
  assert.equal(allowed.result.isError, false);
  const payload = rpcText(allowed);
  assert.deepEqual(payload.events.map(event => event.event_id), ["evt:own"]);
  assert.equal(JSON.stringify(payload).includes("hidden body"), false);

  const spoofed = await handleMcpRpc({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "cairnstone_event_list", arguments: { source: "journal", actor_id: "claude:cairnstone-v6" } }
  }, { CAIRNSTONE_DB: db }, { core: true, auth: true, authContext: { principal_id: "grok:cairnstone-v6" } });
  assert.equal(spoofed.result.isError, true);
  assert.equal(rpcText(spoofed).error, "caller_assertion_forbidden");

  const legacy = await worker.fetch(new Request("https://cairnstone.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "cairnstone_event_list", arguments: { source: "journal", actor_id: "grok:cairnstone-v6" } }
    })
  }), { CAIRNSTONE_DB: db });
  const legacyBody = await legacy.json();
  assert.equal(JSON.parse(legacyBody.result.content[0].text).error, "journal_auth_required");

  const taskRun = await worker.fetch(new Request("https://cairnstone.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "cairnstone_event_list", arguments: { actor_id: "grok:cairnstone-v6" } }
    })
  }), { CAIRNSTONE_DB: db });
  const taskBody = JSON.parse((await taskRun.json()).result.content[0].text);
  assert.equal(taskBody.schema, "cairnstone-event-v1");
  assert.equal(taskBody.ok, true);
});
