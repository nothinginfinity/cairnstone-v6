// V7.7.10d — cairnstone-task-run-v1 dispatchable async Task Runs
//
// Extends 10b proposal stub with human-commit dispatch, capability-aware
// executor selection, bounded subdelegation, and async status. Propose still
// never dispatches. Dispatch requires human_commit + committed_by.
// NEVER moves chain_heads / path_heads. accepted_state_authority false.
// Child Task Runs cannot widen parent capability/attachment ceilings.

import { parseObjectRef } from "./attachment-refs.js";
import {
  routeExecutor,
  EXECUTOR_ROUTE_RECEIPT_SCHEMA
} from "./executor-profile.js";
import { invokeExecutorAdapter } from "./executor-adapters.js";

export const TASK_RUN_SCHEMA = "cairnstone-task-run-v1";

export const TASK_RUN_STATUSES = Object.freeze([
  "proposed",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

export const TASK_RUN_DISPATCH_STATES = Object.freeze([
  "not_dispatched",
  "dispatched",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

/** Hard subdelegation limits (fabric plan §6). */
export const TASK_RUN_MAX_DELEGATION_DEPTH = 2;
export const TASK_RUN_MAX_FANOUT = 3;

export const TASK_RUN_BROKER_TOOL_IDS = Object.freeze({
  propose: "cairnstone_task_run_propose",
  get: "cairnstone_task_run_get",
  list: "cairnstone_task_run_list",
  dispatch: "cairnstone_task_run_dispatch",
  cancel: "cairnstone_task_run_cancel",
  status: "cairnstone_task_run_status"
});

export const TASK_RUN_MUTATION_TOOL_IDS = Object.freeze([
  TASK_RUN_BROKER_TOOL_IDS.propose,
  TASK_RUN_BROKER_TOOL_IDS.dispatch,
  TASK_RUN_BROKER_TOOL_IDS.cancel
]);

export const TASK_RUN_READ_TOOL_IDS = Object.freeze([
  TASK_RUN_BROKER_TOOL_IDS.get,
  TASK_RUN_BROKER_TOOL_IDS.list,
  TASK_RUN_BROKER_TOOL_IDS.status
]);

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const TASK_RUN_ID_RE = /^tr:[a-z0-9][a-z0-9._-]{0,127}$/i;
const CONVERSATION_ID_RE = /^cvs:[a-z0-9][a-z0-9._-]{0,127}$/i;
const TURN_ID_RE = /^turn:[a-z0-9][a-z0-9._-]{0,127}$/i;
const MAX_REFS = 100;
const MAX_LIST = 100;
const DEFAULT_LIST = 20;
const MAX_NOTE = 2000;
const MAX_REF_LEN = 256;
const MAX_CAPS = 64;

const TASK_RUN_SELECT_COLS = `task_run_id, schema, status, conversation_id, parent_turn_id, requested_by,
            assignee_actor_id, requested_intent, intent_mode, attachment_refs_json,
            object_refs_json, note, dispatch_state, selected_executor_id,
            executor_route_reason, required_capabilities_json, policy_preset,
            budget_envelope_json, parent_task_run_id, child_task_run_ids_json,
            delegation_depth, route_receipt_id, route_receipt_json, adapter_job_id,
            receipt_refs_json, artifact_refs_json, pr_refs_json, test_refs_json,
            result_summary, failure_reason, human_committed_by, human_committed_at,
            started_at, completed_at, created_at, updated_at, cancelled_at,
            accepted_state_authority`;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actorId(value, field) {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!ACTOR_ID_RE.test(text)) throw new Error(`Invalid actor id for ${field}`);
  return text;
}

function taskRunId(value, field = "task_run_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!TASK_RUN_ID_RE.test(text)) throw new Error(`Invalid task_run id for ${field}`);
  return text;
}

function parseJsonField(text, fallback) {
  if (text === undefined || text === null || text === "") return fallback;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function authorityClosedFields(extra = {}) {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true,
    access_granted_by_assign: false,
    ...extra
  };
}

function envDb(env) {
  if (!env?.CAIRNSTONE_DB) {
    return { ok: false, error: "missing_d1_binding", detail: "CAIRNSTONE_DB required" };
  }
  return { ok: true, db: env.CAIRNSTONE_DB };
}

function requireActorField(body, field) {
  try {
    return { ok: true, value: actorId(body?.[field], field) };
  } catch (error) {
    return { ok: false, error: `invalid_${field}`, detail: String(error.message || error) };
  }
}

function normalizeRefList(input, field) {
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_REFS) {
    return { ok: false, error: `${field}_too_large`, max: MAX_REFS };
  }
  const out = [];
  for (const item of list) {
    const raw = typeof item === "string"
      ? item
      : (item && typeof item === "object" ? (item.object_ref || item.ref || item.attachment_ref) : null);
    if (!isNonEmptyString(raw)) {
      return { ok: false, error: `invalid_${field}_entry` };
    }
    const parsed = parseObjectRef(String(raw).trim().slice(0, MAX_REF_LEN));
    if (!parsed.ok) {
      return { ok: false, error: `invalid_${field}_entry`, detail: parsed };
    }
    out.push(parsed.canonical_ref || parsed.object_ref);
  }
  return { ok: true, [field]: [...new Set(out)] };
}

function normalizeCapabilityList(input) {
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_CAPS) return { ok: false, error: "required_capabilities_too_large", max: MAX_CAPS };
  const out = [];
  for (const item of list) {
    if (!isNonEmptyString(item)) return { ok: false, error: "invalid_required_capabilities_entry" };
    out.push(String(item).trim().slice(0, 128));
  }
  return { ok: true, required_capabilities: [...new Set(out)] };
}

function refsSubset(childRefs, parentRefs) {
  const parent = new Set(parentRefs || []);
  for (const ref of childRefs || []) {
    if (!parent.has(ref)) return false;
  }
  return true;
}

function capsSubset(childCaps, parentCaps) {
  // Empty parent ceiling means child may only use empty or must fail if child adds any.
  // If parent has caps, child caps must be ⊆ parent.
  const parent = new Set(parentCaps || []);
  if (parent.size === 0) {
    return (childCaps || []).length === 0;
  }
  for (const cap of childCaps || []) {
    if (!parent.has(cap)) return false;
  }
  return true;
}

function rowToTaskRun(row) {
  const attachmentRefs = parseJsonField(row.attachment_refs_json, []);
  const objectRefs = parseJsonField(row.object_refs_json, []);
  const childIds = parseJsonField(row.child_task_run_ids_json, []);
  const requiredCapabilities = parseJsonField(row.required_capabilities_json, []);
  const budgetEnvelope = parseJsonField(row.budget_envelope_json, null);
  const routeReceipt = parseJsonField(row.route_receipt_json, null);
  const receiptRefs = parseJsonField(row.receipt_refs_json, []);
  const artifactRefs = parseJsonField(row.artifact_refs_json, []);
  const prRefs = parseJsonField(row.pr_refs_json, []);
  const testRefs = parseJsonField(row.test_refs_json, []);
  const dispatchState = row.dispatch_state || "not_dispatched";
  const dispatched = dispatchState !== "not_dispatched";
  const executorInvoked = Boolean(row.selected_executor_id && dispatched);

  return {
    schema: TASK_RUN_SCHEMA,
    task_run_id: row.task_run_id,
    status: row.status,
    conversation_id: row.conversation_id || null,
    parent_turn_id: row.parent_turn_id || null,
    requested_by: row.requested_by,
    assignee_actor_id: row.assignee_actor_id || null,
    requested_intent: row.requested_intent || "ask-to-work",
    intent_mode: row.intent_mode || "propose-action",
    attachment_refs: attachmentRefs,
    object_refs: objectRefs,
    note: row.note || null,
    dispatch_state: dispatchState,
    selected_executor_id: row.selected_executor_id || null,
    executor_route_reason: row.executor_route_reason || null,
    required_capabilities: requiredCapabilities,
    policy_preset: row.policy_preset || null,
    budget_envelope: budgetEnvelope,
    parent_task_run_id: row.parent_task_run_id || null,
    child_task_run_ids: childIds,
    delegation_depth: Number(row.delegation_depth || 0),
    route_receipt_id: row.route_receipt_id || null,
    route_receipt: routeReceipt,
    adapter_job_id: row.adapter_job_id || null,
    receipt_refs: receiptRefs,
    artifact_refs: artifactRefs,
    pr_refs: prRefs,
    test_refs: testRefs,
    result_summary: row.result_summary || null,
    failure_reason: row.failure_reason || null,
    human_committed_by: row.human_committed_by || null,
    human_committed_at: row.human_committed_at || null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    cancelled_at: row.cancelled_at || null,
    proposal: {
      kind: "assign_ask_to_work",
      dispatchable: row.status === "proposed" && dispatchState === "not_dispatched",
      requires_human_dispatch: true,
      owned_by_slices: ["V7.7.10d", "V7.7.10e"],
      note: dispatched
        ? "Task Run dispatched under human_commit; completion ≠ accepted state."
        : "Proposal only until cairnstone_task_run_dispatch with human_commit. Access is separate (cairnstone-access-grant-v1)."
    },
    ...authorityClosedFields({
      dispatched,
      executor_invoked: executorInvoked
    })
  };
}

async function selectTaskRun(db, id) {
  return db.prepare(
    `SELECT ${TASK_RUN_SELECT_COLS} FROM task_runs WHERE task_run_id = ?`
  ).bind(id).first();
}

function actorMayInspect(taskRun, actorIdValue) {
  return taskRun.requested_by === actorIdValue
    || taskRun.assignee_actor_id === actorIdValue
    || taskRun.human_committed_by === actorIdValue;
}

function actorMayDispatch(taskRun, committedBy) {
  return taskRun.requested_by === committedBy
    || taskRun.assignee_actor_id === committedBy;
}

async function persistRouteReceipt(db, routeReceipt, taskRunId = null) {
  if (!routeReceipt?.route_receipt_id) return;
  await db.prepare(
    `INSERT OR REPLACE INTO executor_route_receipts (
       route_receipt_id, schema, task_run_id, actor_id, selected_executor_id,
       selection_reason, policy_preset, receipt_json, created_at, accepted_state_authority
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    routeReceipt.route_receipt_id,
    EXECUTOR_ROUTE_RECEIPT_SCHEMA,
    taskRunId,
    routeReceipt.actor_id || null,
    routeReceipt.selected_executor_id || null,
    routeReceipt.selection_reason || null,
    routeReceipt.policy_preset || null,
    JSON.stringify(routeReceipt),
    routeReceipt.created_at || new Date().toISOString()
  ).run();
}

export async function proposeTaskRun(db, {
  task_run_id,
  requested_by,
  assignee_actor_id = null,
  conversation_id = null,
  parent_turn_id = null,
  attachment_refs = [],
  object_refs = [],
  note = null,
  requested_intent = "ask-to-work",
  parent_task_run_id = null,
  required_capabilities = [],
  policy_preset = null,
  budget_envelope = null,
  now = null
} = {}) {
  let requester;
  let id;
  try {
    requester = actorId(requested_by, "requested_by");
    id = task_run_id ? taskRunId(task_run_id) : `tr:${crypto.randomUUID()}`;
  } catch (error) {
    return { ok: false, error: "invalid_task_run_propose", detail: String(error.message || error) };
  }

  let assignee = null;
  if (assignee_actor_id !== undefined && assignee_actor_id !== null && assignee_actor_id !== "") {
    try { assignee = actorId(assignee_actor_id, "assignee_actor_id"); }
    catch (error) {
      return { ok: false, error: "invalid_assignee_actor_id", detail: String(error.message || error) };
    }
  }

  let conversationId = null;
  if (conversation_id) {
    if (!CONVERSATION_ID_RE.test(String(conversation_id).trim())) {
      return { ok: false, error: "invalid_conversation_id" };
    }
    conversationId = String(conversation_id).trim();
  }

  let parentTurnId = null;
  if (parent_turn_id) {
    if (!TURN_ID_RE.test(String(parent_turn_id).trim())) {
      return { ok: false, error: "invalid_parent_turn_id" };
    }
    parentTurnId = String(parent_turn_id).trim();
  }

  const attachmentsNorm = normalizeRefList(attachment_refs, "attachment_refs");
  if (!attachmentsNorm.ok) return attachmentsNorm;
  const objectsNorm = normalizeRefList(
    object_refs.length ? object_refs : attachment_refs,
    "object_refs"
  );
  if (!objectsNorm.ok) return objectsNorm;

  if (!attachmentsNorm.attachment_refs.length && !objectsNorm.object_refs.length) {
    return { ok: false, error: "attachment_refs_required", detail: "Assign proposals must reference canonical object refs" };
  }

  const capsNorm = normalizeCapabilityList(required_capabilities);
  if (!capsNorm.ok) return capsNorm;

  let noteText = null;
  if (note !== undefined && note !== null && note !== "") {
    if (!isNonEmptyString(note)) return { ok: false, error: "invalid_note" };
    noteText = String(note).trim().slice(0, MAX_NOTE);
  }

  const intent = isNonEmptyString(requested_intent)
    ? String(requested_intent).trim().slice(0, 64)
    : "ask-to-work";

  let parentId = null;
  let delegationDepth = 0;
  if (parent_task_run_id) {
    try { parentId = taskRunId(parent_task_run_id, "parent_task_run_id"); }
    catch (error) {
      return { ok: false, error: "invalid_parent_task_run_id", detail: String(error.message || error) };
    }
    const parentRow = await selectTaskRun(db, parentId);
    if (!parentRow) return { ok: false, error: "parent_task_run_not_found", parent_task_run_id: parentId };
    const parent = rowToTaskRun(parentRow);

    const parentActive = ["dispatched", "running"].includes(parent.dispatch_state)
      || ["queued", "running"].includes(parent.status);
    if (!parentActive) {
      return {
        ok: false,
        error: "parent_task_run_not_dispatchable_for_subdelegation",
        detail: "Child propose requires parent dispatch_state in dispatched|running (or status queued|running)",
        parent_dispatch_state: parent.dispatch_state,
        parent_status: parent.status
      };
    }

    delegationDepth = (parent.delegation_depth || 0) + 1;
    if (delegationDepth > TASK_RUN_MAX_DELEGATION_DEPTH) {
      return {
        ok: false,
        error: "delegation_depth_exceeded",
        max: TASK_RUN_MAX_DELEGATION_DEPTH,
        attempted: delegationDepth
      };
    }

    if ((parent.child_task_run_ids || []).length >= TASK_RUN_MAX_FANOUT) {
      return {
        ok: false,
        error: "delegation_fanout_exceeded",
        max: TASK_RUN_MAX_FANOUT,
        parent_task_run_id: parentId
      };
    }

    const childAttachments = attachmentsNorm.attachment_refs.length
      ? attachmentsNorm.attachment_refs
      : objectsNorm.object_refs;
    if (!refsSubset(childAttachments, parent.attachment_refs.length ? parent.attachment_refs : parent.object_refs)) {
      return {
        ok: false,
        error: "child_attachment_ceiling_violation",
        detail: "Child attachment_refs must be ⊆ parent attachment_refs"
      };
    }
    if (!refsSubset(objectsNorm.object_refs, parent.object_refs.length ? parent.object_refs : parent.attachment_refs)) {
      return {
        ok: false,
        error: "child_object_ref_ceiling_violation",
        detail: "Child object_refs must be ⊆ parent object_refs"
      };
    }
    if (!capsSubset(capsNorm.required_capabilities, parent.required_capabilities)) {
      return {
        ok: false,
        error: "child_capability_ceiling_violation",
        detail: "Child required_capabilities must be ⊆ parent required_capabilities"
      };
    }
  }

  const createdAt = now || new Date().toISOString();
  const budgetJson = budget_envelope && isObject(budget_envelope)
    ? JSON.stringify(budget_envelope)
    : null;
  const policy = policy_preset ? String(policy_preset).trim().slice(0, 32) : null;

  try {
    await db.prepare(
      `INSERT INTO task_runs (
         task_run_id, schema, status, conversation_id, parent_turn_id, requested_by,
         assignee_actor_id, requested_intent, intent_mode, attachment_refs_json,
         object_refs_json, note, dispatch_state, selected_executor_id,
         executor_route_reason, required_capabilities_json, policy_preset,
         budget_envelope_json, parent_task_run_id, child_task_run_ids_json,
         delegation_depth, route_receipt_id, route_receipt_json, adapter_job_id,
         receipt_refs_json, artifact_refs_json, pr_refs_json, test_refs_json,
         result_summary, failure_reason, human_committed_by, human_committed_at,
         started_at, completed_at, created_at, updated_at, cancelled_at,
         accepted_state_authority
       ) VALUES (
         ?, ?, 'proposed', ?, ?, ?, ?, ?, 'propose-action', ?, ?, ?,
         'not_dispatched', NULL, NULL, ?, ?, ?, ?, '[]', ?, NULL, NULL, NULL,
         '[]', '[]', '[]', '[]', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, 0
       )`
    ).bind(
      id,
      TASK_RUN_SCHEMA,
      conversationId,
      parentTurnId,
      requester,
      assignee,
      intent,
      JSON.stringify(attachmentsNorm.attachment_refs.length
        ? attachmentsNorm.attachment_refs
        : objectsNorm.object_refs),
      JSON.stringify(objectsNorm.object_refs),
      noteText,
      JSON.stringify(capsNorm.required_capabilities),
      policy,
      budgetJson,
      parentId,
      delegationDepth,
      createdAt,
      createdAt
    ).run();
  } catch (error) {
    const message = String(error.message || error);
    if (/unique/i.test(message)) {
      return { ok: false, error: "task_run_already_exists", task_run_id: id };
    }
    // Fallback for pre-migration schema (10b columns only) — keep propose working in unit mocks.
    if (/no such column/i.test(message)) {
      try {
        await db.prepare(
          `INSERT INTO task_runs (
             task_run_id, schema, status, conversation_id, parent_turn_id, requested_by,
             assignee_actor_id, requested_intent, intent_mode, attachment_refs_json,
             object_refs_json, note, dispatch_state, selected_executor_id,
             created_at, updated_at, cancelled_at, accepted_state_authority
           ) VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, 'propose-action', ?, ?, ?, 'not_dispatched', NULL, ?, ?, NULL, 0)`
        ).bind(
          id,
          TASK_RUN_SCHEMA,
          conversationId,
          parentTurnId,
          requester,
          assignee,
          intent,
          JSON.stringify(attachmentsNorm.attachment_refs.length
            ? attachmentsNorm.attachment_refs
            : objectsNorm.object_refs),
          JSON.stringify(objectsNorm.object_refs),
          noteText,
          createdAt,
          createdAt
        ).run();
      } catch (legacyError) {
        const legacyMessage = String(legacyError.message || legacyError);
        if (/unique/i.test(legacyMessage)) {
          return { ok: false, error: "task_run_already_exists", task_run_id: id };
        }
        return { ok: false, error: "task_run_propose_failed", detail: legacyMessage };
      }
    } else {
      return { ok: false, error: "task_run_propose_failed", detail: message };
    }
  }

  if (parentId) {
    const parentRow = await selectTaskRun(db, parentId);
    if (parentRow) {
      const children = parseJsonField(parentRow.child_task_run_ids_json, []);
      children.push(id);
      try {
        await db.prepare(
          `UPDATE task_runs SET child_task_run_ids_json = ?, updated_at = ? WHERE task_run_id = ?`
        ).bind(JSON.stringify(children), createdAt, parentId).run();
      } catch {
        // ignore if legacy schema lacks column
      }
    }
  }

  const row = await selectTaskRun(db, id);
  return {
    ok: true,
    task_run: rowToTaskRun(row),
    ...authorityClosedFields({ dispatched: false, executor_invoked: false })
  };
}

export async function getTaskRun(db, task_run_id, actor_id) {
  let id;
  let actor;
  try {
    id = taskRunId(task_run_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_task_run_get", detail: String(error.message || error) };
  }
  const row = await selectTaskRun(db, id);
  if (!row) return { ok: false, error: "task_run_not_found", task_run_id: id };
  const taskRun = rowToTaskRun(row);
  if (!actorMayInspect(taskRun, actor)) {
    return { ok: false, error: "task_run_actor_forbidden", task_run_id: id, ...authorityClosedFields() };
  }
  return { ok: true, task_run: taskRun, ...authorityClosedFields({
    dispatched: taskRun.dispatched,
    executor_invoked: taskRun.executor_invoked
  }) };
}

export async function listTaskRuns(db, {
  actor_id,
  status = null,
  conversation_id = null,
  assignee_actor_id = null,
  parent_task_run_id = null,
  limit = DEFAULT_LIST
} = {}) {
  let actor;
  try {
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_actor_id", detail: String(error.message || error) };
  }

  const lim = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_LIST, limit)) : DEFAULT_LIST;
  if (status && !TASK_RUN_STATUSES.includes(status)) {
    return { ok: false, error: "invalid_status", allowed: [...TASK_RUN_STATUSES] };
  }

  let conversationId = null;
  if (conversation_id) {
    if (!CONVERSATION_ID_RE.test(String(conversation_id).trim())) {
      return { ok: false, error: "invalid_conversation_id" };
    }
    conversationId = String(conversation_id).trim();
  }

  let assignee = null;
  if (assignee_actor_id) {
    try { assignee = actorId(assignee_actor_id, "assignee_actor_id"); }
    catch (error) {
      return { ok: false, error: "invalid_assignee_actor_id", detail: String(error.message || error) };
    }
  }

  let parentId = null;
  if (parent_task_run_id) {
    try { parentId = taskRunId(parent_task_run_id, "parent_task_run_id"); }
    catch (error) {
      return { ok: false, error: "invalid_parent_task_run_id", detail: String(error.message || error) };
    }
  }

  const rows = await db.prepare(
    `SELECT ${TASK_RUN_SELECT_COLS}
       FROM task_runs
      WHERE (requested_by = ? OR assignee_actor_id = ? OR human_committed_by = ?)
        AND (? IS NULL OR status = ?)
        AND (? IS NULL OR conversation_id = ?)
        AND (? IS NULL OR assignee_actor_id = ?)
        AND (? IS NULL OR parent_task_run_id = ?)
      ORDER BY created_at DESC
      LIMIT ?`
  ).bind(
    actor,
    actor,
    actor,
    status,
    status,
    conversationId,
    conversationId,
    assignee,
    assignee,
    parentId,
    parentId,
    lim
  ).all();

  const taskRuns = (rows?.results || []).map(rowToTaskRun);
  return {
    ok: true,
    schema: TASK_RUN_SCHEMA,
    total: taskRuns.length,
    task_runs: taskRuns,
    ...authorityClosedFields()
  };
}

/**
 * Human-commit dispatch. Fail closed without human_commit + committed_by.
 */
export async function dispatchTaskRun(db, {
  task_run_id,
  human_commit,
  committed_by,
  preferred_executor = null,
  policy_preset = null,
  budget_envelope = null,
  required_capabilities = null,
  route_receipt = null,
  allowlisted_tool_id = null,
  allowlisted_tool_args = null,
  base_commit_sha = null,
  env = null,
  invokeAllowlistedRead = null,
  now = null
} = {}) {
  if (human_commit !== true) {
    return {
      ok: false,
      error: "human_commit_required",
      detail: "Dispatch requires explicit human_commit:true; model/intent/propose never auto-dispatch",
      ...authorityClosedFields({ dispatched: false, executor_invoked: false })
    };
  }

  let id;
  let committer;
  try {
    id = taskRunId(task_run_id);
    committer = actorId(committed_by, "committed_by");
  } catch (error) {
    return { ok: false, error: "invalid_task_run_dispatch", detail: String(error.message || error) };
  }

  const row = await selectTaskRun(db, id);
  if (!row) return { ok: false, error: "task_run_not_found", task_run_id: id };
  const taskRun = rowToTaskRun(row);

  if (!actorMayDispatch(taskRun, committer)) {
    return {
      ok: false,
      error: "dispatch_actor_forbidden",
      detail: "committed_by must match requested_by or assignee_actor_id",
      ...authorityClosedFields()
    };
  }

  if (taskRun.status !== "proposed" || taskRun.dispatch_state !== "not_dispatched") {
    return {
      ok: false,
      error: "task_run_not_dispatchable",
      status: taskRun.status,
      dispatch_state: taskRun.dispatch_state,
      ...authorityClosedFields({ dispatched: taskRun.dispatched, executor_invoked: taskRun.executor_invoked })
    };
  }

  const createdAt = now || new Date().toISOString();
  const policy = policy_preset || taskRun.policy_preset || "balanced";
  const budget = budget_envelope || taskRun.budget_envelope || null;
  const caps = Array.isArray(required_capabilities)
    ? required_capabilities
    : (taskRun.required_capabilities || []);

  let route = null;
  if (route_receipt && isObject(route_receipt) && route_receipt.selected_executor_id) {
    route = {
      ok: true,
      route_receipt: {
        ...route_receipt,
        authorization_state: "requires_human_commit",
        accepted_state_authority: false
      },
      selected_executor: { executor_id: route_receipt.selected_executor_id }
    };
  } else {
    route = routeExecutor({
      required_capabilities: caps,
      attachment_refs: taskRun.attachment_refs,
      object_refs: taskRun.object_refs,
      work_hints: taskRun.note ? [taskRun.note] : [],
      policy_preset: policy,
      preferred_executor: preferred_executor || taskRun.selected_executor_id || null,
      budget_envelope: budget,
      parent_task_run_id: taskRun.parent_task_run_id,
      actor_id: committer
    });
  }

  if (!route.ok) {
    return {
      ok: false,
      error: "executor_route_failed",
      detail: route,
      ...authorityClosedFields({ dispatched: false, executor_invoked: false })
    };
  }

  const selectedExecutorId = route.route_receipt.selected_executor_id;
  const selectionReason = route.route_receipt.selection_reason;

  try {
    await persistRouteReceipt(db, route.route_receipt, id);
  } catch {
    // receipt table may be absent in unit mocks — non-fatal for dispatch path
  }

  const adapterResult = await invokeExecutorAdapter({
    executor_id: selectedExecutorId,
    task_run: taskRun,
    route_receipt: route.route_receipt,
    env,
    invokeAllowlistedRead,
    allowlisted_tool_id: allowlisted_tool_id || "cairnstone_executor_list",
    allowlisted_tool_args: allowlisted_tool_args || {},
    base_commit_sha,
    now: createdAt
  });

  if (!adapterResult.ok && selectedExecutorId === "exec:deterministic-mcp") {
    return {
      ok: false,
      error: "adapter_invocation_failed",
      detail: adapterResult,
      route_receipt: route.route_receipt,
      ...authorityClosedFields({ dispatched: false, executor_invoked: false })
    };
  }

  const nextStatus = adapterResult.task_status || "queued";
  const nextDispatch = adapterResult.dispatch_state || "dispatched";
  const receiptRefs = adapterResult.receipt?.receipt_id ? [adapterResult.receipt.receipt_id] : [];
  const completedAt = ["completed", "failed", "cancelled"].includes(nextStatus) ? createdAt : null;
  const startedAt = createdAt;

  try {
    await db.prepare(
      `UPDATE task_runs SET
         status = ?,
         dispatch_state = ?,
         selected_executor_id = ?,
         executor_route_reason = ?,
         required_capabilities_json = ?,
         policy_preset = ?,
         budget_envelope_json = ?,
         route_receipt_id = ?,
         route_receipt_json = ?,
         adapter_job_id = ?,
         receipt_refs_json = ?,
         result_summary = ?,
         failure_reason = ?,
         human_committed_by = ?,
         human_committed_at = ?,
         started_at = ?,
         completed_at = ?,
         updated_at = ?
       WHERE task_run_id = ?`
    ).bind(
      nextStatus,
      nextDispatch,
      selectedExecutorId,
      selectionReason,
      JSON.stringify(route.route_receipt.required_capabilities || caps),
      policy,
      budget ? JSON.stringify(budget) : null,
      route.route_receipt.route_receipt_id,
      JSON.stringify(route.route_receipt),
      adapterResult.job?.job_id || null,
      JSON.stringify(receiptRefs),
      adapterResult.receipt?.result_summary || null,
      adapterResult.receipt?.failure_reason || null,
      committer,
      createdAt,
      startedAt,
      completedAt,
      createdAt,
      id
    ).run();
  } catch (error) {
    return {
      ok: false,
      error: "task_run_dispatch_persist_failed",
      detail: String(error.message || error),
      ...authorityClosedFields()
    };
  }

  const fresh = await selectTaskRun(db, id);
  return {
    ok: true,
    task_run: rowToTaskRun(fresh),
    route_receipt: route.route_receipt,
    adapter_job: adapterResult.job || null,
    adapter_receipt: adapterResult.receipt || null,
    ...authorityClosedFields({
      dispatched: true,
      executor_invoked: true
    })
  };
}

export async function cancelTaskRun(db, {
  task_run_id,
  actor_id,
  reason = null,
  now = null
} = {}) {
  let id;
  let actor;
  try {
    id = taskRunId(task_run_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_task_run_cancel", detail: String(error.message || error) };
  }

  const row = await selectTaskRun(db, id);
  if (!row) return { ok: false, error: "task_run_not_found", task_run_id: id };
  const taskRun = rowToTaskRun(row);
  if (!actorMayInspect(taskRun, actor)) {
    return { ok: false, error: "task_run_actor_forbidden", ...authorityClosedFields() };
  }

  if (["completed", "failed", "cancelled"].includes(taskRun.status)) {
    return {
      ok: false,
      error: "task_run_already_terminal",
      status: taskRun.status,
      ...authorityClosedFields({ dispatched: taskRun.dispatched, executor_invoked: taskRun.executor_invoked })
    };
  }

  const cancelledAt = now || new Date().toISOString();
  const failureReason = reason ? String(reason).trim().slice(0, MAX_NOTE) : "cancelled_by_actor";

  await db.prepare(
    `UPDATE task_runs SET
       status = 'cancelled',
       dispatch_state = CASE
         WHEN dispatch_state = 'not_dispatched' THEN 'not_dispatched'
         ELSE 'cancelled'
       END,
       failure_reason = ?,
       cancelled_at = ?,
       completed_at = ?,
       updated_at = ?
     WHERE task_run_id = ?`
  ).bind(failureReason, cancelledAt, cancelledAt, cancelledAt, id).run();

  const fresh = await selectTaskRun(db, id);
  return {
    ok: true,
    task_run: rowToTaskRun(fresh),
    ...authorityClosedFields({
      dispatched: fresh.dispatch_state !== "not_dispatched",
      executor_invoked: Boolean(fresh.selected_executor_id)
    })
  };
}

export async function taskRunStatus(db, task_run_id, actor_id) {
  const got = await getTaskRun(db, task_run_id, actor_id);
  if (!got.ok) return got;
  const tr = got.task_run;
  return {
    ok: true,
    schema: TASK_RUN_SCHEMA,
    task_run_id: tr.task_run_id,
    status: tr.status,
    dispatch_state: tr.dispatch_state,
    selected_executor_id: tr.selected_executor_id,
    adapter_job_id: tr.adapter_job_id,
    result_summary: tr.result_summary,
    failure_reason: tr.failure_reason,
    started_at: tr.started_at,
    completed_at: tr.completed_at,
    parent_task_run_id: tr.parent_task_run_id,
    child_task_run_ids: tr.child_task_run_ids,
    progress: {
      proposed: tr.status === "proposed",
      queued: tr.status === "queued",
      running: tr.status === "running",
      terminal: ["completed", "failed", "cancelled"].includes(tr.status)
    },
    ...authorityClosedFields({
      dispatched: tr.dispatched,
      executor_invoked: tr.executor_invoked
    })
  };
}

export async function proposeTaskRunFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;

  const requestedBy = body.requested_by
    ? requireActorField(body, "requested_by")
    : requireActorField(body, "actor_id");
  if (!requestedBy.ok) return requestedBy;

  return proposeTaskRun(bindings.db, {
    task_run_id: body.task_run_id,
    requested_by: requestedBy.value,
    assignee_actor_id: body.assignee_actor_id || body.principal_actor_id || null,
    conversation_id: body.conversation_id || null,
    parent_turn_id: body.parent_turn_id || null,
    attachment_refs: body.attachment_refs || body.attachment_set || [],
    object_refs: body.object_refs || [],
    note: body.note || null,
    requested_intent: body.requested_intent || "ask-to-work",
    parent_task_run_id: body.parent_task_run_id || null,
    required_capabilities: body.required_capabilities || [],
    policy_preset: body.policy_preset || null,
    budget_envelope: body.budget_envelope || null
  });
}

export async function getTaskRunFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;
  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.task_run_id)) return { ok: false, error: "task_run_id_required" };
  return getTaskRun(bindings.db, body.task_run_id, actor.value);
}

export async function listTaskRunsFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;
  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  return listTaskRuns(bindings.db, {
    actor_id: actor.value,
    status: body.status || null,
    conversation_id: body.conversation_id || null,
    assignee_actor_id: body.assignee_actor_id || null,
    parent_task_run_id: body.parent_task_run_id || null,
    limit: body.limit
  });
}

export async function dispatchTaskRunFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;

  const committedBy = body.committed_by
    ? requireActorField(body, "committed_by")
    : (body.actor_id ? requireActorField(body, "actor_id") : { ok: false, error: "committed_by_required" });
  if (!committedBy.ok) return committedBy;
  if (!isNonEmptyString(body.task_run_id)) return { ok: false, error: "task_run_id_required" };

  return dispatchTaskRun(bindings.db, {
    task_run_id: body.task_run_id,
    human_commit: body.human_commit === true,
    committed_by: committedBy.value,
    preferred_executor: body.preferred_executor || body.executor_id || null,
    policy_preset: body.policy_preset || null,
    budget_envelope: body.budget_envelope || null,
    required_capabilities: body.required_capabilities || null,
    route_receipt: body.route_receipt || null,
    allowlisted_tool_id: body.allowlisted_tool_id || null,
    allowlisted_tool_args: body.allowlisted_tool_args || null,
    base_commit_sha: body.base_commit_sha || null,
    env,
    invokeAllowlistedRead: null
  });
}

export async function cancelTaskRunFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;
  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.task_run_id)) return { ok: false, error: "task_run_id_required" };
  return cancelTaskRun(bindings.db, {
    task_run_id: body.task_run_id,
    actor_id: actor.value,
    reason: body.reason || null
  });
}

export async function taskRunStatusFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;
  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.task_run_id)) return { ok: false, error: "task_run_id_required" };
  return taskRunStatus(bindings.db, body.task_run_id, actor.value);
}

export const TASK_RUN_PROPOSE_TOOL_DEFINITION = Object.freeze({
  name: TASK_RUN_BROKER_TOOL_IDS.propose,
  description: "V7.7.10b/d: create a cairnstone-task-run-v1 Assign/Ask-to-work PROPOSAL. status=proposed, dispatch_state=not_dispatched. Does NOT grant access, does NOT dispatch. Optional parent_task_run_id for bounded subdelegation (ceilings enforced).",
  inputSchema: {
    type: "object",
    required: ["attachment_refs"],
    properties: {
      task_run_id: { type: "string", description: "tr:…" },
      requested_by: { type: "string" },
      actor_id: { type: "string", description: "alias for requested_by" },
      assignee_actor_id: { type: "string" },
      principal_actor_id: { type: "string", description: "alias for assignee_actor_id" },
      conversation_id: { type: "string" },
      parent_turn_id: { type: "string" },
      parent_task_run_id: { type: "string" },
      attachment_refs: { type: "array", maxItems: MAX_REFS, items: { type: "string" } },
      object_refs: { type: "array", maxItems: MAX_REFS, items: { type: "string" } },
      note: { type: "string", maxLength: MAX_NOTE },
      requested_intent: { type: "string" },
      required_capabilities: { type: "array", maxItems: MAX_CAPS, items: { type: "string" } },
      policy_preset: { type: "string" },
      budget_envelope: { type: "object" }
    },
    additionalProperties: false
  }
});

export const TASK_RUN_GET_TOOL_DEFINITION = Object.freeze({
  name: TASK_RUN_BROKER_TOOL_IDS.get,
  description: "V7.7.10b/d: get one Task Run by task_run_id. Visible to requester, assignee, or human committer.",
  inputSchema: {
    type: "object",
    required: ["task_run_id", "actor_id"],
    properties: {
      task_run_id: { type: "string" },
      actor_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const TASK_RUN_LIST_TOOL_DEFINITION = Object.freeze({
  name: TASK_RUN_BROKER_TOOL_IDS.list,
  description: "V7.7.10b/d: list Task Runs visible to an actor. Newest-first, bounded. Optional parent_task_run_id filter.",
  inputSchema: {
    type: "object",
    required: ["actor_id"],
    properties: {
      actor_id: { type: "string" },
      status: { type: "string", enum: [...TASK_RUN_STATUSES] },
      conversation_id: { type: "string" },
      assignee_actor_id: { type: "string" },
      parent_task_run_id: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: MAX_LIST }
    },
    additionalProperties: false
  }
});

export const TASK_RUN_DISPATCH_TOOL_DEFINITION = Object.freeze({
  name: TASK_RUN_BROKER_TOOL_IDS.dispatch,
  description: "V7.7.10d: human-commit dispatch of a proposed Task Run. Requires human_commit:true + committed_by. Runs executor_route, records selection, invokes adapter (deterministic allowlisted read or coding/AFO stub). NEVER auto-dispatch from model/intent/propose. accepted_state_authority=false.",
  inputSchema: {
    type: "object",
    required: ["task_run_id", "human_commit", "committed_by"],
    properties: {
      task_run_id: { type: "string" },
      human_commit: { type: "boolean" },
      committed_by: { type: "string" },
      actor_id: { type: "string", description: "alias for committed_by when committed_by omitted" },
      preferred_executor: { type: "string" },
      executor_id: { type: "string" },
      policy_preset: { type: "string" },
      budget_envelope: { type: "object" },
      required_capabilities: { type: "array", items: { type: "string" } },
      route_receipt: { type: "object" },
      allowlisted_tool_id: { type: "string" },
      allowlisted_tool_args: { type: "object" },
      base_commit_sha: { type: "string" }
    },
    additionalProperties: false
  }
});

export const TASK_RUN_CANCEL_TOOL_DEFINITION = Object.freeze({
  name: TASK_RUN_BROKER_TOOL_IDS.cancel,
  description: "V7.7.10d: cancel a non-terminal Task Run. Never moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["task_run_id", "actor_id"],
    properties: {
      task_run_id: { type: "string" },
      actor_id: { type: "string" },
      reason: { type: "string" }
    },
    additionalProperties: false
  }
});

export const TASK_RUN_STATUS_TOOL_DEFINITION = Object.freeze({
  name: TASK_RUN_BROKER_TOOL_IDS.status,
  description: "V7.7.10d: async Task Run status/progress snapshot. Operational only.",
  inputSchema: {
    type: "object",
    required: ["task_run_id", "actor_id"],
    properties: {
      task_run_id: { type: "string" },
      actor_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const TASK_RUN_MCP_TOOL_DEFINITIONS = Object.freeze([
  TASK_RUN_PROPOSE_TOOL_DEFINITION,
  TASK_RUN_GET_TOOL_DEFINITION,
  TASK_RUN_LIST_TOOL_DEFINITION,
  TASK_RUN_DISPATCH_TOOL_DEFINITION,
  TASK_RUN_CANCEL_TOOL_DEFINITION,
  TASK_RUN_STATUS_TOOL_DEFINITION
]);
