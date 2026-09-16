import test from "node:test";
import assert from "node:assert/strict";
import {
  listExecutorProfiles,
  getExecutorProfile,
  executorHealth,
  routeExecutor,
  inferRequiredCapabilities,
  SEED_EXECUTOR_PROFILES,
  EXECUTOR_PROFILE_SCHEMA,
  EXECUTOR_ROUTE_RECEIPT_SCHEMA,
  EXECUTOR_BROKER_TOOL_IDS,
  EXECUTOR_SELECTION_RANK,
  EXECUTOR_MCP_TOOL_DEFINITIONS
} from "../src/executor-profile.js";
import {
  DETERMINISTIC_MCP_ALLOWLIST,
  COPILOT_ADAPTER_CONTRACT,
  CURSOR_ADAPTER_CONTRACT,
  AFO_ADAPTER_CONTRACT,
  invokeExecutorAdapter,
  getAdapterContract
} from "../src/executor-adapters.js";
import {
  proposeTaskRun,
  dispatchTaskRun,
  cancelTaskRun,
  taskRunStatus,
  getTaskRun,
  TASK_RUN_SCHEMA,
  TASK_RUN_BROKER_TOOL_IDS,
  TASK_RUN_MAX_DELEGATION_DEPTH,
  TASK_RUN_MAX_FANOUT,
  TASK_RUN_MCP_TOOL_DEFINITIONS
} from "../src/task-run.js";
import {
  DEFAULT_TOOL_BROKER_REGISTRY,
  toolRegistryFromBody
} from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { mcpToolsForProfile } from "../src/index.js";

const ACTOR = "console:jared";
const ASSIGNEE = "claude:cairnstone-v6";
const OBJECT_REF = "msg:v7710d-smoke";
const REPO_REF = "repo:nothinginfinity/cairnstone-v6@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function assertAuthorityClosed(result, { dispatched = false } = {}) {
  assert.equal(result.accepted_state_authority, false);
  assert.equal(result.chain_heads_mutated, false);
  assert.equal(result.path_heads_mutated, false);
  assert.equal(result.grants_no_capability, true);
  if ("dispatched" in result) assert.equal(result.dispatched, dispatched);
}

function makeDb() {
  const db = {
    taskRuns: new Map(),
    routeReceipts: new Map()
  };
  return {
    prepare(sql) {
      const args = [];
      return {
        bind(...bound) {
          args.push(...bound);
          return this;
        },
        async run() {
          if (sql.includes("INSERT INTO task_runs")) {
            const [
              taskRunId, schema, conversationId, parentTurnId, requestedBy,
              assignee, intent, attachmentRefsJson, objectRefsJson, note,
              capsJson, policy, budgetJson, parentId, delegationDepth,
              createdAt, updatedAt
            ] = args;
            if (db.taskRuns.has(taskRunId)) {
              throw new Error("UNIQUE constraint failed: task_runs.task_run_id");
            }
            db.taskRuns.set(taskRunId, {
              task_run_id: taskRunId,
              schema,
              status: "proposed",
              conversation_id: conversationId,
              parent_turn_id: parentTurnId,
              requested_by: requestedBy,
              assignee_actor_id: assignee,
              requested_intent: intent,
              intent_mode: "propose-action",
              attachment_refs_json: attachmentRefsJson,
              object_refs_json: objectRefsJson,
              note,
              dispatch_state: "not_dispatched",
              selected_executor_id: null,
              executor_route_reason: null,
              required_capabilities_json: capsJson || "[]",
              policy_preset: policy || null,
              budget_envelope_json: budgetJson || null,
              parent_task_run_id: parentId || null,
              child_task_run_ids_json: "[]",
              delegation_depth: delegationDepth || 0,
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
              created_at: createdAt,
              updated_at: updatedAt,
              cancelled_at: null,
              accepted_state_authority: 0
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("INSERT OR REPLACE INTO executor_route_receipts") || sql.includes("INSERT INTO executor_route_receipts")) {
            const [routeReceiptId, schema, taskRunId, actorId, selectedExecutorId, selectionReason, policyPreset, receiptJson, createdAt] = args;
            db.routeReceipts.set(routeReceiptId, {
              route_receipt_id: routeReceiptId,
              schema,
              task_run_id: taskRunId,
              actor_id: actorId,
              selected_executor_id: selectedExecutorId,
              selection_reason: selectionReason,
              policy_preset: policyPreset,
              receipt_json: receiptJson,
              created_at: createdAt,
              accepted_state_authority: 0
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE task_runs SET child_task_run_ids_json")) {
            const [childrenJson, updatedAt, taskRunId] = args;
            const row = db.taskRuns.get(taskRunId);
            if (row) {
              db.taskRuns.set(taskRunId, { ...row, child_task_run_ids_json: childrenJson, updated_at: updatedAt });
            }
            return { success: true, meta: { changes: row ? 1 : 0 } };
          }
          if (sql.includes("UPDATE task_runs SET") && sql.includes("human_committed_by")) {
            const [
              status, dispatchState, selectedExecutorId, executorRouteReason,
              capsJson, policy, budgetJson, routeReceiptId, routeReceiptJson,
              adapterJobId, receiptRefsJson, resultSummary, failureReason,
              humanCommittedBy, humanCommittedAt, startedAt, completedAt, updatedAt,
              taskRunId
            ] = args;
            const row = db.taskRuns.get(taskRunId);
            if (!row) return { success: true, meta: { changes: 0 } };
            db.taskRuns.set(taskRunId, {
              ...row,
              status,
              dispatch_state: dispatchState,
              selected_executor_id: selectedExecutorId,
              executor_route_reason: executorRouteReason,
              required_capabilities_json: capsJson,
              policy_preset: policy,
              budget_envelope_json: budgetJson,
              route_receipt_id: routeReceiptId,
              route_receipt_json: routeReceiptJson,
              adapter_job_id: adapterJobId,
              receipt_refs_json: receiptRefsJson,
              result_summary: resultSummary,
              failure_reason: failureReason,
              human_committed_by: humanCommittedBy,
              human_committed_at: humanCommittedAt,
              started_at: startedAt,
              completed_at: completedAt,
              updated_at: updatedAt
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE task_runs SET") && sql.includes("status = 'cancelled'")) {
            const [failureReason, cancelledAt, completedAt, updatedAt, taskRunId] = args;
            const row = db.taskRuns.get(taskRunId);
            if (!row) return { success: true, meta: { changes: 0 } };
            const dispatchState = row.dispatch_state === "not_dispatched" ? "not_dispatched" : "cancelled";
            db.taskRuns.set(taskRunId, {
              ...row,
              status: "cancelled",
              dispatch_state: dispatchState,
              failure_reason: failureReason,
              cancelled_at: cancelledAt,
              completed_at: completedAt,
              updated_at: updatedAt
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes("FROM task_runs WHERE task_run_id")) {
            return db.taskRuns.get(args[0]) || null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        }
      };
    },
    _raw: db
  };
}

test("executor registry: seed profiles discoverable", () => {
  const listed = listExecutorProfiles();
  assert.equal(listed.ok, true);
  assert.equal(listed.schema, EXECUTOR_PROFILE_SCHEMA);
  assert.equal(listed.total, 5);
  assert.equal(SEED_EXECUTOR_PROFILES.length, 5);
  const ids = listed.executors.map(e => e.executor_id).sort();
  assert.deepEqual(ids, [
    "exec:afo-specialist",
    "exec:cairnstone-delegate",
    "exec:cursor-cloud",
    "exec:deterministic-mcp",
    "exec:github-copilot"
  ]);
  assertAuthorityClosed(listed);
  const got = getExecutorProfile("exec:deterministic-mcp");
  assert.equal(got.ok, true);
  assert.equal(got.executor.selection_rank, EXECUTOR_SELECTION_RANK.deterministic);
  const health = executorHealth();
  assert.equal(health.ok, true);
  assert.equal(health.total, 5);
});

test("executor_route: selection order — deterministic when fully deterministic", () => {
  const route = routeExecutor({
    required_capabilities: ["stone.read", "repo.read"],
    attachment_refs: [OBJECT_REF],
    policy_preset: "balanced",
    actor_id: ACTOR
  });
  assert.equal(route.ok, true);
  assert.equal(route.route_receipt.schema, EXECUTOR_ROUTE_RECEIPT_SCHEMA);
  assert.equal(route.route_receipt.selected_executor_id, "exec:deterministic-mcp");
  assert.equal(route.route_receipt.selection_reason, "fully_deterministic");
  assert.equal(route.route_receipt.authorization_state, "requires_human_commit");
  assert.equal(route.route_receipt.dispatched, false);
  assertAuthorityClosed(route);
});

test("executor_route: coding agent when repo.edit/pr required", () => {
  const route = routeExecutor({
    required_capabilities: ["repo.read", "repo.edit", "repo.pr"],
    attachment_refs: [REPO_REF],
    work_hints: ["implement fix and open pr"],
    policy_preset: "balanced",
    actor_id: ACTOR
  });
  assert.equal(route.ok, true);
  assert.ok(["exec:github-copilot", "exec:cursor-cloud"].includes(route.route_receipt.selected_executor_id));
  assert.match(route.route_receipt.selection_reason, /coding_agent/);
  assert.equal(route.dispatched, false);
});

test("executor_route: narrow specialist before inexpensive model when capability fit", () => {
  const route = routeExecutor({
    required_capabilities: ["github.api", "d1.inspect"],
    policy_preset: "balanced",
    actor_id: ACTOR
  });
  assert.equal(route.ok, true);
  assert.equal(route.route_receipt.selected_executor_id, "exec:afo-specialist");
  assert.equal(route.route_receipt.selection_reason, "narrow_specialist_capability_fit");
});

test("executor_route: never dispatches; manual requires preferred", () => {
  const manual = routeExecutor({
    required_capabilities: ["stone.read"],
    policy_preset: "manual"
  });
  assert.equal(manual.ok, false);
  assert.equal(manual.error, "manual_policy_requires_preferred_executor");

  const preferred = routeExecutor({
    required_capabilities: ["repo.read", "repo.edit", "repo.pr"],
    policy_preset: "manual",
    preferred_executor: "exec:cursor-cloud"
  });
  assert.equal(preferred.ok, true);
  assert.equal(preferred.route_receipt.selected_executor_id, "exec:cursor-cloud");
  assert.equal(preferred.route_receipt.selection_reason, "preferred_executor");
  assert.equal(preferred.executor_invoked, false);
});

test("inferRequiredCapabilities from refs and work hints", () => {
  const caps = inferRequiredCapabilities({
    attachment_refs: [REPO_REF],
    work_hints: ["open a PR and run tests"]
  });
  assert.ok(caps.includes("repo.read"));
  assert.ok(caps.includes("repo.edit"));
  assert.ok(caps.includes("repo.pr"));
  assert.ok(caps.includes("repo.test"));
});

test("adapter contracts: Copilot/Cursor/AFO stubs present", () => {
  assert.equal(COPILOT_ADAPTER_CONTRACT.live_path, false);
  assert.equal(CURSOR_ADAPTER_CONTRACT.live_path, false);
  assert.equal(AFO_ADAPTER_CONTRACT.live_path, false);
  assert.ok(DETERMINISTIC_MCP_ALLOWLIST.includes("cairnstone_executor_list"));
  const contract = getAdapterContract("exec:github-copilot");
  assert.equal(contract.ok, true);
  assert.equal(contract.adapter_live, false);
});

test("propose never auto-dispatches", async () => {
  const db = makeDb();
  const proposed = await proposeTaskRun(db, {
    task_run_id: "tr:propose-only",
    requested_by: ACTOR,
    assignee_actor_id: ASSIGNEE,
    attachment_refs: [OBJECT_REF],
    note: "please work on this"
  });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.task_run.schema, TASK_RUN_SCHEMA);
  assert.equal(proposed.task_run.status, "proposed");
  assert.equal(proposed.task_run.dispatch_state, "not_dispatched");
  assert.equal(proposed.task_run.dispatched, false);
  assert.equal(proposed.task_run.executor_invoked, false);
  assert.equal(proposed.task_run.proposal.dispatchable, true);
  assertAuthorityClosed(proposed, { dispatched: false });
});

test("dispatch without human_commit fails closed", async () => {
  const db = makeDb();
  await proposeTaskRun(db, {
    task_run_id: "tr:need-commit",
    requested_by: ACTOR,
    attachment_refs: [OBJECT_REF]
  });
  const denied = await dispatchTaskRun(db, {
    task_run_id: "tr:need-commit",
    human_commit: false,
    committed_by: ACTOR
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "human_commit_required");
  const still = await getTaskRun(db, "tr:need-commit", ACTOR);
  assert.equal(still.task_run.dispatch_state, "not_dispatched");
});

test("dispatch with human_commit → deterministic adapter receipt", async () => {
  const db = makeDb();
  await proposeTaskRun(db, {
    task_run_id: "tr:dispatch-det",
    requested_by: ACTOR,
    attachment_refs: [OBJECT_REF],
    required_capabilities: ["stone.read"]
  });
  const dispatched = await dispatchTaskRun(db, {
    task_run_id: "tr:dispatch-det",
    human_commit: true,
    committed_by: ACTOR,
    preferred_executor: "exec:deterministic-mcp"
  });
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.task_run.selected_executor_id, "exec:deterministic-mcp");
  assert.equal(dispatched.task_run.human_committed_by, ACTOR);
  assert.ok(dispatched.task_run.human_committed_at);
  assert.equal(dispatched.adapter_receipt.adapter_live, true);
  assert.equal(dispatched.adapter_receipt.dry_run, false);
  assert.equal(dispatched.task_run.status, "completed");
  assert.equal(dispatched.task_run.dispatch_state, "completed");
  assert.equal(dispatched.accepted_state_authority, false);
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.route_receipt.authorization_state, "requires_human_commit");
});

test("dispatch coding agent records dry-run stub job", async () => {
  const db = makeDb();
  await proposeTaskRun(db, {
    task_run_id: "tr:dispatch-copilot",
    requested_by: ACTOR,
    attachment_refs: [REPO_REF],
    required_capabilities: ["repo.read", "repo.edit", "repo.pr"],
    note: "open a PR"
  });
  const dispatched = await dispatchTaskRun(db, {
    task_run_id: "tr:dispatch-copilot",
    human_commit: true,
    committed_by: ACTOR,
    preferred_executor: "exec:github-copilot"
  });
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.task_run.selected_executor_id, "exec:github-copilot");
  assert.equal(dispatched.adapter_receipt.adapter_live, false);
  assert.equal(dispatched.adapter_receipt.dry_run, true);
  assert.equal(dispatched.task_run.status, "queued");
  assert.equal(dispatched.task_run.dispatch_state, "dispatched");
  const status = await taskRunStatus(db, "tr:dispatch-copilot", ACTOR);
  assert.equal(status.ok, true);
  assert.equal(status.status, "queued");
  assert.equal(status.progress.queued, true);
});

test("child ceiling: cannot widen parent attachments or capabilities", async () => {
  const db = makeDb();
  await proposeTaskRun(db, {
    task_run_id: "tr:parent-1",
    requested_by: ACTOR,
    attachment_refs: [OBJECT_REF],
    required_capabilities: ["stone.read"]
  });
  // Parent must be dispatched/running before child propose
  await dispatchTaskRun(db, {
    task_run_id: "tr:parent-1",
    human_commit: true,
    committed_by: ACTOR,
    preferred_executor: "exec:deterministic-mcp"
  });
  // Re-mark parent as running for subdelegation (deterministic completes immediately)
  const parentRow = db._raw.taskRuns.get("tr:parent-1");
  db._raw.taskRuns.set("tr:parent-1", {
    ...parentRow,
    status: "running",
    dispatch_state: "running",
    completed_at: null
  });

  const widenRefs = await proposeTaskRun(db, {
    task_run_id: "tr:child-widen-ref",
    requested_by: ACTOR,
    parent_task_run_id: "tr:parent-1",
    attachment_refs: [REPO_REF],
    required_capabilities: ["stone.read"]
  });
  assert.equal(widenRefs.ok, false);
  assert.equal(widenRefs.error, "child_attachment_ceiling_violation");

  const widenCaps = await proposeTaskRun(db, {
    task_run_id: "tr:child-widen-cap",
    requested_by: ACTOR,
    parent_task_run_id: "tr:parent-1",
    attachment_refs: [OBJECT_REF],
    required_capabilities: ["stone.read", "repo.edit"]
  });
  assert.equal(widenCaps.ok, false);
  assert.equal(widenCaps.error, "child_capability_ceiling_violation");

  const okChild = await proposeTaskRun(db, {
    task_run_id: "tr:child-ok",
    requested_by: ACTOR,
    parent_task_run_id: "tr:parent-1",
    attachment_refs: [OBJECT_REF],
    required_capabilities: ["stone.read"]
  });
  assert.equal(okChild.ok, true);
  assert.equal(okChild.task_run.parent_task_run_id, "tr:parent-1");
  assert.equal(okChild.task_run.delegation_depth, 1);
  assert.equal(okChild.task_run.dispatch_state, "not_dispatched");
});

test("child propose rejected when parent not dispatched", async () => {
  const db = makeDb();
  await proposeTaskRun(db, {
    task_run_id: "tr:parent-proposed",
    requested_by: ACTOR,
    attachment_refs: [OBJECT_REF],
    required_capabilities: ["stone.read"]
  });
  const child = await proposeTaskRun(db, {
    task_run_id: "tr:child-early",
    requested_by: ACTOR,
    parent_task_run_id: "tr:parent-proposed",
    attachment_refs: [OBJECT_REF]
  });
  assert.equal(child.ok, false);
  assert.equal(child.error, "parent_task_run_not_dispatchable_for_subdelegation");
});

test("delegation depth and fan-out limits documented", () => {
  assert.equal(TASK_RUN_MAX_DELEGATION_DEPTH, 2);
  assert.equal(TASK_RUN_MAX_FANOUT, 3);
});

test("cancel proposed task run", async () => {
  const db = makeDb();
  await proposeTaskRun(db, {
    task_run_id: "tr:cancel-me",
    requested_by: ACTOR,
    attachment_refs: [OBJECT_REF]
  });
  const cancelled = await cancelTaskRun(db, {
    task_run_id: "tr:cancel-me",
    actor_id: ACTOR,
    reason: "operator cancelled"
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.task_run.status, "cancelled");
  assert.equal(cancelled.task_run.dispatch_state, "not_dispatched");
});

test("invokeExecutorAdapter dry-run for cursor", async () => {
  const result = await invokeExecutorAdapter({
    executor_id: "exec:cursor-cloud",
    task_run: { task_run_id: "tr:x" },
    route_receipt: { route_receipt_id: "errcpt:x" }
  });
  assert.equal(result.ok, true);
  assert.equal(result.receipt.dry_run, true);
  assert.equal(result.receipt.adapter_live, false);
  assert.equal(result.dispatch_state, "dispatched");
});

test("broker registry: 10d tools + risk classes; not automatic-read", () => {
  const registry = toolRegistryFromBody({});
  assert.equal(registry.total, 94);
  assert.equal(DEFAULT_TOOL_BROKER_REGISTRY.length, 94);

  const byId = Object.fromEntries(DEFAULT_TOOL_BROKER_REGISTRY.map(e => [e.tool_id, e]));
  assert.equal(byId[EXECUTOR_BROKER_TOOL_IDS.route].risk_class, "read");
  assert.equal(byId[EXECUTOR_BROKER_TOOL_IDS.list].risk_class, "read");
  assert.equal(byId[EXECUTOR_BROKER_TOOL_IDS.get].authorization, "scoped_grant");
  assert.equal(byId[TASK_RUN_BROKER_TOOL_IDS.dispatch].risk_class, "mutation");
  assert.equal(byId[TASK_RUN_BROKER_TOOL_IDS.dispatch].authorization, "human_confirmation");
  assert.equal(byId[TASK_RUN_BROKER_TOOL_IDS.cancel].risk_class, "mutation");
  assert.equal(byId[TASK_RUN_BROKER_TOOL_IDS.status].risk_class, "read");

  const automatic = new Set(listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY));
  assert.equal(automatic.has(EXECUTOR_BROKER_TOOL_IDS.route), false);
  assert.equal(automatic.has(TASK_RUN_BROKER_TOOL_IDS.dispatch), false);

  // Model router remains distinct from executor router (separate MCP handlers).
  const mcpNames = new Set(mcpToolsForProfile(false).map(t => t.name));
  for (const def of [...EXECUTOR_MCP_TOOL_DEFINITIONS, ...TASK_RUN_MCP_TOOL_DEFINITIONS]) {
    assert.ok(mcpNames.has(def.name), `missing MCP tool ${def.name}`);
  }
  assert.ok(mcpNames.has("cairnstone_model_route"));
  assert.ok(mcpNames.has("cairnstone_executor_route"));
  assert.notEqual(
    byId.cairnstone_executor_route.handler,
    "cairnstone_model_route"
  );
  assert.equal(byId.cairnstone_executor_route.handler, "cairnstone_executor_route");
});
