import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_SCHEMA,
  TREE_SCHEMA,
  EVENT_TYPES,
  eventFromTaskRun,
  projectAgentTree,
  listEventsFromTaskRuns,
  subscribeHonesty,
  agentTreeFromBody
} from "../src/event-plane.js";
import { mcpToolsForProfile } from "../src/index.js";

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
