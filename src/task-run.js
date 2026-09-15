// V7.7.10b — cairnstone-task-run-v1 proposal stub (Assign / Ask to work)
//
// Creates a NON-DISPATCHING proposal referencing the same canonical
// attachment_refs / object_refs. Does NOT grant access by itself.
// Does NOT call executor registry / coding-agent dispatch (10d/10e).
// status=proposed, dispatch_state=not_dispatched always at create.
// NEVER moves chain_heads / path_heads. accepted_state_authority false.

import { parseObjectRef } from "./attachment-refs.js";

export const TASK_RUN_SCHEMA = "cairnstone-task-run-v1";

export const TASK_RUN_STATUSES = Object.freeze(["proposed", "cancelled"]);

export const TASK_RUN_BROKER_TOOL_IDS = Object.freeze({
  propose: "cairnstone_task_run_propose",
  get: "cairnstone_task_run_get",
  list: "cairnstone_task_run_list"
});

export const TASK_RUN_MUTATION_TOOL_IDS = Object.freeze([
  TASK_RUN_BROKER_TOOL_IDS.propose
]);

export const TASK_RUN_READ_TOOL_IDS = Object.freeze([
  TASK_RUN_BROKER_TOOL_IDS.get,
  TASK_RUN_BROKER_TOOL_IDS.list
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true,
    dispatched: false,
    executor_invoked: false,
    access_granted_by_assign: false
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

function rowToTaskRun(row) {
  const attachmentRefs = typeof row.attachment_refs_json === "string"
    ? JSON.parse(row.attachment_refs_json)
    : (row.attachment_refs_json || []);
  const objectRefs = typeof row.object_refs_json === "string"
    ? JSON.parse(row.object_refs_json)
    : (row.object_refs_json || []);
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
    dispatch_state: row.dispatch_state || "not_dispatched",
    selected_executor_id: row.selected_executor_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    cancelled_at: row.cancelled_at || null,
    proposal: {
      kind: "assign_ask_to_work",
      dispatchable: false,
      requires_human_dispatch: true,
      owned_by_slices: ["V7.7.10d", "V7.7.10e"],
      note: "Proposal only — not dispatched. Access is separate (cairnstone-access-grant-v1)."
    },
    ...authorityClosedFields()
  };
}

async function selectTaskRun(db, id) {
  return db.prepare(
    `SELECT task_run_id, schema, status, conversation_id, parent_turn_id, requested_by,
            assignee_actor_id, requested_intent, intent_mode, attachment_refs_json,
            object_refs_json, note, dispatch_state, selected_executor_id,
            created_at, updated_at, cancelled_at, accepted_state_authority
       FROM task_runs WHERE task_run_id = ?`
  ).bind(id).first();
}

function actorMayInspect(taskRun, actorIdValue) {
  return taskRun.requested_by === actorIdValue
    || taskRun.assignee_actor_id === actorIdValue;
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

  let noteText = null;
  if (note !== undefined && note !== null && note !== "") {
    if (!isNonEmptyString(note)) return { ok: false, error: "invalid_note" };
    noteText = String(note).trim().slice(0, MAX_NOTE);
  }

  const intent = isNonEmptyString(requested_intent)
    ? String(requested_intent).trim().slice(0, 64)
    : "ask-to-work";

  const createdAt = now || new Date().toISOString();

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
  } catch (error) {
    const message = String(error.message || error);
    if (/unique/i.test(message)) {
      return { ok: false, error: "task_run_already_exists", task_run_id: id };
    }
    return { ok: false, error: "task_run_propose_failed", detail: message };
  }

  const row = await selectTaskRun(db, id);
  return {
    ok: true,
    task_run: rowToTaskRun(row),
    ...authorityClosedFields()
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
  return { ok: true, task_run: taskRun, ...authorityClosedFields() };
}

export async function listTaskRuns(db, {
  actor_id,
  status = null,
  conversation_id = null,
  assignee_actor_id = null,
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

  const rows = await db.prepare(
    `SELECT task_run_id, schema, status, conversation_id, parent_turn_id, requested_by,
            assignee_actor_id, requested_intent, intent_mode, attachment_refs_json,
            object_refs_json, note, dispatch_state, selected_executor_id,
            created_at, updated_at, cancelled_at, accepted_state_authority
       FROM task_runs
      WHERE (requested_by = ? OR assignee_actor_id = ?)
        AND (? IS NULL OR status = ?)
        AND (? IS NULL OR conversation_id = ?)
        AND (? IS NULL OR assignee_actor_id = ?)
      ORDER BY created_at DESC
      LIMIT ?`
  ).bind(
    actor,
    actor,
    status,
    status,
    conversationId,
    conversationId,
    assignee,
    assignee,
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
    requested_intent: body.requested_intent || "ask-to-work"
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
    limit: body.limit
  });
}

export const TASK_RUN_PROPOSE_TOOL_DEFINITION = Object.freeze({
  name: TASK_RUN_BROKER_TOOL_IDS.propose,
  description: "V7.7.10b: create a cairnstone-task-run-v1 Assign/Ask-to-work PROPOSAL over the same canonical attachment_refs. status=proposed, dispatch_state=not_dispatched. Does NOT grant access, does NOT dispatch executors (10d/10e). Never moves HEADs.",
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
      attachment_refs: { type: "array", maxItems: MAX_REFS, items: { type: "string" } },
      object_refs: { type: "array", maxItems: MAX_REFS, items: { type: "string" } },
      note: { type: "string", maxLength: MAX_NOTE },
      requested_intent: { type: "string" }
    },
    additionalProperties: false
  }
});

export const TASK_RUN_GET_TOOL_DEFINITION = Object.freeze({
  name: TASK_RUN_BROKER_TOOL_IDS.get,
  description: "V7.7.10b: get one Task Run proposal by task_run_id. Visible to requester or assignee. Never dispatched by this tool.",
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
  description: "V7.7.10b: list Task Run proposals visible to an actor (requester or assignee). Newest-first, bounded.",
  inputSchema: {
    type: "object",
    required: ["actor_id"],
    properties: {
      actor_id: { type: "string" },
      status: { type: "string", enum: [...TASK_RUN_STATUSES] },
      conversation_id: { type: "string" },
      assignee_actor_id: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: MAX_LIST }
    },
    additionalProperties: false
  }
});

export const TASK_RUN_MCP_TOOL_DEFINITIONS = Object.freeze([
  TASK_RUN_PROPOSE_TOOL_DEFINITION,
  TASK_RUN_GET_TOOL_DEFINITION,
  TASK_RUN_LIST_TOOL_DEFINITION
]);
