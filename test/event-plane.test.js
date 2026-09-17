import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_SCHEMA,
  TREE_SCHEMA,
  EVENT_TYPES,
  eventFromTaskRun,
  projectAgentTree,
  listEventsFromTaskRuns,
  subscribeHonesty
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

test("event plane MCP tools are exposed on mcpTools()", () => {
  const names = new Set(mcpToolsForProfile(false).map(t => t.name));
  assert.equal(names.has("cairnstone_event_list"), true);
  assert.equal(names.has("cairnstone_agent_tree"), true);
});
