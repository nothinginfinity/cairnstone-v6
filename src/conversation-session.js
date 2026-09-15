// V7.7.10a — Durable Conversation Session contract + persistence
//
// Operational state only. Distinct from Code Session (do not overload).
// NEVER moves chain_heads / path_heads. accepted_state_authority always false.
// Conversation history is NEVER bulk-promoted into project memory.
//
// Lean forward-compatible hooks only:
//   - opaque access_grant_ids[]
//   - typed object_ref / attachment_ref placeholders (resolvers = 10b)
//   - task_run_ids[] identity only (no executor routing)
//
// Auth: actor membership in the session (created_by | selected_actors).
// No second ticket format; optional workspace_id is a binding hint only.

import { stableJson } from "./agent-bootstrap.js";

export const CONVERSATION_SESSION_SCHEMA = "cairnstone-conversation-session-v1";
export const CONVERSATION_TURN_SCHEMA = "cairnstone-conversation-turn-v1";

export const CONVERSATION_SESSION_STATUSES = Object.freeze([
  "active",
  "paused",
  "closed",
  "superseded"
]);

export const CONVERSATION_INTENT_MODES = Object.freeze([
  "read",
  "compare",
  "propose-action"
]);

export const CONVERSATION_TURN_ROLES = Object.freeze([
  "user",
  "assistant",
  "system",
  "tool",
  "operational"
]);

const STATUS_SET = new Set(CONVERSATION_SESSION_STATUSES);
const INTENT_SET = new Set(CONVERSATION_INTENT_MODES);
const ROLE_SET = new Set(CONVERSATION_TURN_ROLES);

export const CONVERSATION_SESSION_BROKER_TOOL_IDS = Object.freeze({
  create: "cairnstone_conversation_session_create",
  get: "cairnstone_conversation_session_get",
  list: "cairnstone_conversation_session_list",
  update: "cairnstone_conversation_session_update",
  append_turn: "cairnstone_conversation_session_append_turn"
});

export const CONVERSATION_SESSION_MUTATION_TOOL_IDS = Object.freeze([
  CONVERSATION_SESSION_BROKER_TOOL_IDS.create,
  CONVERSATION_SESSION_BROKER_TOOL_IDS.update,
  CONVERSATION_SESSION_BROKER_TOOL_IDS.append_turn
]);

export const CONVERSATION_SESSION_READ_TOOL_IDS = Object.freeze([
  CONVERSATION_SESSION_BROKER_TOOL_IDS.get,
  CONVERSATION_SESSION_BROKER_TOOL_IDS.list
]);

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const CONVERSATION_ID_RE = /^cvs:[a-z0-9][a-z0-9._-]{0,127}$/i;
const TURN_ID_RE = /^turn:[a-z0-9][a-z0-9._-]{0,127}$/i;
const MESSAGE_ID_RE = /^cmsg:[a-z0-9][a-z0-9._-]{0,127}$/i;
const CODE_SESSION_ID_RE = /^cs:[a-z0-9][a-z0-9._-]{0,127}$/i;
const WORKSPACE_ID_RE = /^ws:[a-z0-9][a-z0-9._-]{0,127}$/i;
const SECRET_KEY_RE = /^(workspace_capability|mailbox_capability|capability|api[_-]?key|secret|bearer|token|password|credential|private[_-]?key|authorization)$/i;
const REDACTED_SECRET = "[REDACTED]";

const MAX_MESSAGE_LOG = 500;
const MAX_ATTACHMENT_SET = 100;
const MAX_SELECTED_ACTORS = 64;
const MAX_RESPONSE_IDS = 100;
const MAX_TOOL_RECEIPTS = 200;
const MAX_ACCESS_GRANT_IDS = 100;
const MAX_TASK_RUN_IDS = 100;
const MAX_OBJECT_REFS = 100;
const MAX_LIST = 100;
const DEFAULT_LIST = 20;
const MAX_CONTENT_PREVIEW = 512;
const MAX_REF_LEN = 256;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function actorId(value, field) {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!ACTOR_ID_RE.test(text)) throw new Error(`Invalid actor id for ${field}`);
  return text;
}

function conversationId(value, field = "conversation_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!CONVERSATION_ID_RE.test(text)) throw new Error(`Invalid conversation id for ${field}`);
  return text;
}

function turnId(value, field = "turn_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!TURN_ID_RE.test(text)) throw new Error(`Invalid turn id for ${field}`);
  return text;
}

function messageId(value, field = "message_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!MESSAGE_ID_RE.test(text)) throw new Error(`Invalid message id for ${field}`);
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

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    synthetic_global_head: false,
    grants_no_capability: true,
    project_memory_promoted: false,
    conversation_history_is_not_project_memory: true
  };
}

export function scrubSecretsDeep(value, depth = 0) {
  if (depth > 12) return REDACTED_SECRET;
  if (Array.isArray(value)) return value.map(item => scrubSecretsDeep(item, depth + 1));
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = REDACTED_SECRET;
      continue;
    }
    out[key] = scrubSecretsDeep(entry, depth + 1);
  }
  return out;
}

function requireActorField(body, field) {
  try {
    return { ok: true, value: actorId(body?.[field], field) };
  } catch (error) {
    return { ok: false, error: `invalid_${field}`, detail: String(error.message || error) };
  }
}

function conversationEnvBindings(env) {
  if (!env?.CAIRNSTONE_DB) {
    return { ok: false, error: "missing_d1_binding", detail: "CAIRNSTONE_DB required" };
  }
  return { ok: true, db: env.CAIRNSTONE_DB };
}

function normalizeStringList(input, {
  field,
  max,
  idPattern = null,
  allowEmpty = true
} = {}) {
  const list = Array.isArray(input) ? input : [];
  if (!allowEmpty && !list.length) {
    return { ok: false, error: `${field}_required` };
  }
  if (list.length > max) {
    return { ok: false, error: `${field}_too_large`, max };
  }
  const out = [];
  for (const item of list) {
    if (!isNonEmptyString(item)) {
      return { ok: false, error: `invalid_${field}_entry` };
    }
    const text = String(item).trim().slice(0, MAX_REF_LEN);
    if (idPattern && !idPattern.test(text)) {
      return { ok: false, error: `invalid_${field}_entry`, value: text };
    }
    out.push(text);
  }
  return { ok: true, [field]: [...new Set(out)] };
}

export function normalizeSelectedActors(input, createdBy = null) {
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_SELECTED_ACTORS) {
    return { ok: false, error: "selected_actors_too_large", max: MAX_SELECTED_ACTORS };
  }
  const actors = [];
  for (const item of list) {
    if (isNonEmptyString(item)) {
      try {
        actors.push(actorId(item, "selected_actors"));
      } catch (error) {
        return { ok: false, error: "invalid_selected_actor", detail: String(error.message || error) };
      }
      continue;
    }
    if (!isObject(item) || !isNonEmptyString(item.actor_id)) {
      return { ok: false, error: "invalid_selected_actor" };
    }
    try {
      actors.push(actorId(item.actor_id, "selected_actors"));
    } catch (error) {
      return { ok: false, error: "invalid_selected_actor", detail: String(error.message || error) };
    }
  }
  if (createdBy && !actors.includes(createdBy)) actors.push(createdBy);
  actors.sort((a, b) => a.localeCompare(b));
  return { ok: true, selected_actors: [...new Set(actors)] };
}

/**
 * Opaque typed attachment / object_ref placeholders for 10b resolvers.
 * Does NOT resolve, grant access, or imply capability.
 */
export function normalizeAttachmentSet(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, attachment_set: [] };
  }
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_ATTACHMENT_SET) {
    return { ok: false, error: "attachment_set_too_large", max: MAX_ATTACHMENT_SET };
  }
  const out = [];
  for (const item of list) {
    if (isNonEmptyString(item)) {
      out.push({
        object_ref: String(item).trim().slice(0, MAX_REF_LEN),
        attachment_ref: null,
        kind: null,
        unresolved: true,
        accepted_state_authority: false
      });
      continue;
    }
    if (!isObject(item)) return { ok: false, error: "invalid_attachment_set_entry" };
    const objectRef = isNonEmptyString(item.object_ref)
      ? String(item.object_ref).trim().slice(0, MAX_REF_LEN)
      : (isNonEmptyString(item.ref) ? String(item.ref).trim().slice(0, MAX_REF_LEN) : null);
    const attachmentRef = isNonEmptyString(item.attachment_ref)
      ? String(item.attachment_ref).trim().slice(0, MAX_REF_LEN)
      : null;
    if (!objectRef && !attachmentRef) {
      return { ok: false, error: "invalid_attachment_set_entry", detail: "object_ref_or_attachment_ref_required" };
    }
    out.push({
      attachment_id: isNonEmptyString(item.attachment_id)
        ? String(item.attachment_id).trim().slice(0, 128)
        : null,
      object_ref: objectRef,
      attachment_ref: attachmentRef,
      kind: isNonEmptyString(item.kind) ? String(item.kind).trim().slice(0, 64) : null,
      unresolved: item.unresolved === false ? false : true,
      accepted_state_authority: false
    });
  }
  return { ok: true, attachment_set: out };
}

export function normalizeActiveScope(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, active_scope: null };
  }
  if (typeof input === "string") {
    const chain = input.trim();
    if (!chain) return { ok: true, active_scope: null };
    return {
      ok: true,
      active_scope: {
        schema: "cairnstone-scope-v1",
        mode: "single_chain",
        chains: [chain],
        accepted_state_authority: false
      }
    };
  }
  if (!isObject(input)) return { ok: false, error: "invalid_active_scope" };
  return {
    ok: true,
    active_scope: {
      ...scrubSecretsDeep(input),
      accepted_state_authority: false
    }
  };
}

export function normalizeRoutingEnvelope(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, routing_envelope: null };
  }
  if (!isObject(input)) return { ok: false, error: "invalid_routing_envelope" };
  return {
    ok: true,
    routing_envelope: {
      ...scrubSecretsDeep(input),
      accepted_state_authority: false,
      creates_no_authority: true
    }
  };
}

export function normalizeToolReceipts(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, tool_receipts: [] };
  }
  const list = Array.isArray(input) ? input : [];
  if (list.length > MAX_TOOL_RECEIPTS) {
    return { ok: false, error: "tool_receipts_too_large", max: MAX_TOOL_RECEIPTS };
  }
  const out = [];
  for (const item of list) {
    if (isNonEmptyString(item)) {
      out.push({ ref: String(item).trim().slice(0, MAX_REF_LEN), kind: "tool_receipt" });
      continue;
    }
    if (!isObject(item)) return { ok: false, error: "invalid_tool_receipt" };
    const ref = isNonEmptyString(item.ref)
      ? String(item.ref).trim().slice(0, MAX_REF_LEN)
      : (isNonEmptyString(item.receipt_id) ? String(item.receipt_id).trim().slice(0, MAX_REF_LEN) : null);
    if (!ref) return { ok: false, error: "invalid_tool_receipt" };
    out.push(scrubSecretsDeep({
      ref,
      kind: isNonEmptyString(item.kind) ? String(item.kind).trim().slice(0, 64) : "tool_receipt",
      status: isNonEmptyString(item.status) ? String(item.status).trim().slice(0, 64) : null,
      tool_id: isNonEmptyString(item.tool_id) ? String(item.tool_id).trim().slice(0, 128) : null
    }));
  }
  return { ok: true, tool_receipts: out };
}

function normalizeOpaqueIdList(input, field, max) {
  return normalizeStringList(input, { field, max, allowEmpty: true });
}

function actorMayAccessSession(session, actor) {
  if (!session || !actor) return false;
  if (session.created_by === actor) return true;
  const selected = Array.isArray(session.selected_actors) ? session.selected_actors : [];
  return selected.includes(actor);
}

export function rowToConversationTurnRecord(row) {
  if (!row) return null;
  return {
    schema: CONVERSATION_TURN_SCHEMA,
    turn_id: row.turn_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    seq: Number(row.seq) || 0,
    role: row.role,
    turn_type: row.turn_type || "message",
    content_ref: row.content_ref || null,
    content_preview: row.content_preview || null,
    response_ids: parseJsonField(row.response_ids_json, []),
    context_pack_id: row.context_pack_id || null,
    tool_receipt_refs: parseJsonField(row.tool_receipt_refs_json, []),
    attachment_refs: parseJsonField(row.attachment_refs_json, []),
    access_grant_ids: parseJsonField(row.access_grant_ids_json, []),
    object_refs: parseJsonField(row.object_refs_json, []),
    task_run_ids: parseJsonField(row.task_run_ids_json, []),
    routing_envelope: parseJsonField(row.routing_envelope_json, null),
    intent_mode: row.intent_mode || null,
    actor_id: row.actor_id,
    created_at: row.created_at,
    ...authorityClosedFields()
  };
}

export function rowToConversationSessionRecord(row) {
  if (!row) return null;
  return {
    schema: CONVERSATION_SESSION_SCHEMA,
    conversation_id: row.conversation_id,
    status: row.status,
    message_log: parseJsonField(row.message_log_json, []),
    attachment_set: parseJsonField(row.attachment_set_json, []),
    active_scope: parseJsonField(row.active_scope_json, null),
    selected_actors: parseJsonField(row.selected_actors_json, []),
    selected_repo: row.selected_repo || null,
    selected_chain: row.selected_chain || null,
    code_session_id: row.code_session_id || null,
    last_response_ids: parseJsonField(row.last_response_ids_json, []),
    routing_envelope: parseJsonField(row.routing_envelope_json, null),
    tool_receipts: parseJsonField(row.tool_receipts_json, []),
    intent_mode: row.intent_mode || "read",
    access_grant_ids: parseJsonField(row.access_grant_ids_json, []),
    task_run_ids: parseJsonField(row.task_run_ids_json, []),
    workspace_id: row.workspace_id || null,
    session_revision: Number(row.session_revision) || 1,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...authorityClosedFields()
  };
}

export async function getConversationSession(db, conversation_id) {
  let id;
  try { id = conversationId(conversation_id); }
  catch { return null; }
  const row = await db.prepare(
    `SELECT conversation_id, status, message_log_json, attachment_set_json, active_scope_json,
            selected_actors_json, selected_repo, selected_chain, code_session_id,
            last_response_ids_json, routing_envelope_json, tool_receipts_json, intent_mode,
            access_grant_ids_json, task_run_ids_json, workspace_id, session_revision,
            created_by, created_at, updated_at, accepted_state_authority
     FROM conversation_sessions WHERE conversation_id = ?`
  ).bind(id).first();
  return rowToConversationSessionRecord(row);
}

export async function listConversationTurns(db, conversation_id, { limit = MAX_MESSAGE_LOG } = {}) {
  let id;
  try { id = conversationId(conversation_id); }
  catch { return []; }
  const capped = Math.min(Math.max(Number(limit) || MAX_MESSAGE_LOG, 1), MAX_MESSAGE_LOG);
  const result = await db.prepare(
    `SELECT turn_id, conversation_id, message_id, seq, role, turn_type, content_ref,
            content_preview, response_ids_json, context_pack_id, tool_receipt_refs_json,
            attachment_refs_json, access_grant_ids_json, object_refs_json, task_run_ids_json,
            routing_envelope_json, intent_mode, actor_id, created_at
     FROM conversation_turns
     WHERE conversation_id = ?
     ORDER BY seq ASC
     LIMIT ?`
  ).bind(id, capped).all();
  const rows = result?.results || [];
  return rows.map(rowToConversationTurnRecord);
}

function turnStubFromRecord(turn) {
  return {
    turn_id: turn.turn_id,
    message_id: turn.message_id,
    seq: turn.seq,
    role: turn.role,
    turn_type: turn.turn_type,
    content_ref: turn.content_ref,
    content_preview: turn.content_preview,
    response_ids: turn.response_ids,
    context_pack_id: turn.context_pack_id,
    tool_receipt_refs: turn.tool_receipt_refs,
    attachment_refs: turn.attachment_refs,
    access_grant_ids: turn.access_grant_ids,
    object_refs: turn.object_refs,
    task_run_ids: turn.task_run_ids,
    intent_mode: turn.intent_mode,
    actor_id: turn.actor_id,
    created_at: turn.created_at
  };
}

export async function createConversationSession(db, {
  conversation_id,
  created_by,
  status = "active",
  attachment_set = [],
  active_scope = null,
  selected_actors = [],
  selected_repo = null,
  selected_chain = null,
  code_session_id = null,
  last_response_ids = [],
  routing_envelope = null,
  tool_receipts = [],
  intent_mode = "read",
  access_grant_ids = [],
  task_run_ids = [],
  workspace_id = null,
  message_log = []
} = {}) {
  let sessionId;
  let creator;
  try {
    sessionId = conversationId(conversation_id);
    creator = actorId(created_by, "created_by");
  } catch (error) {
    return { ok: false, error: "invalid_conversation_session_create", detail: String(error.message || error) };
  }

  if (!STATUS_SET.has(status)) {
    return { ok: false, error: "invalid_conversation_session_status", allowed: [...CONVERSATION_SESSION_STATUSES] };
  }
  if (!INTENT_SET.has(intent_mode)) {
    return { ok: false, error: "invalid_intent_mode", allowed: [...CONVERSATION_INTENT_MODES] };
  }

  const actorsNorm = normalizeSelectedActors(selected_actors, creator);
  if (!actorsNorm.ok) return actorsNorm;
  const attachmentsNorm = normalizeAttachmentSet(attachment_set);
  if (!attachmentsNorm.ok) return attachmentsNorm;
  const scopeNorm = normalizeActiveScope(active_scope);
  if (!scopeNorm.ok) return scopeNorm;
  const routingNorm = normalizeRoutingEnvelope(routing_envelope);
  if (!routingNorm.ok) return routingNorm;
  const receiptsNorm = normalizeToolReceipts(tool_receipts);
  if (!receiptsNorm.ok) return receiptsNorm;
  const responseNorm = normalizeOpaqueIdList(last_response_ids, "last_response_ids", MAX_RESPONSE_IDS);
  if (!responseNorm.ok) return responseNorm;
  const grantsNorm = normalizeOpaqueIdList(access_grant_ids, "access_grant_ids", MAX_ACCESS_GRANT_IDS);
  if (!grantsNorm.ok) return grantsNorm;
  const taskRunsNorm = normalizeOpaqueIdList(task_run_ids, "task_run_ids", MAX_TASK_RUN_IDS);
  if (!taskRunsNorm.ok) return taskRunsNorm;

  if (code_session_id !== undefined && code_session_id !== null && code_session_id !== "") {
    if (!isNonEmptyString(code_session_id) || !CODE_SESSION_ID_RE.test(String(code_session_id).trim())) {
      return { ok: false, error: "invalid_code_session_id" };
    }
  }
  if (workspace_id !== undefined && workspace_id !== null && workspace_id !== "") {
    if (!isNonEmptyString(workspace_id) || !WORKSPACE_ID_RE.test(String(workspace_id).trim())) {
      return { ok: false, error: "invalid_workspace_id" };
    }
  }
  if (message_log !== undefined && message_log !== null && !Array.isArray(message_log)) {
    return { ok: false, error: "invalid_message_log" };
  }
  if (Array.isArray(message_log) && message_log.length > 0) {
    return { ok: false, error: "message_log_must_start_empty", detail: "use_append_turn" };
  }

  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO conversation_sessions (
        conversation_id, status, message_log_json, attachment_set_json, active_scope_json,
        selected_actors_json, selected_repo, selected_chain, code_session_id,
        last_response_ids_json, routing_envelope_json, tool_receipts_json, intent_mode,
        access_grant_ids_json, task_run_ids_json, workspace_id, session_revision,
        created_by, created_at, updated_at, accepted_state_authority
      ) VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0)`
    ).bind(
      sessionId,
      status,
      stableJson(attachmentsNorm.attachment_set),
      scopeNorm.active_scope == null ? null : stableJson(scopeNorm.active_scope),
      stableJson(actorsNorm.selected_actors),
      isNonEmptyString(selected_repo) ? String(selected_repo).trim().slice(0, 256) : null,
      isNonEmptyString(selected_chain) ? String(selected_chain).trim().slice(0, 256) : null,
      isNonEmptyString(code_session_id) ? String(code_session_id).trim() : null,
      stableJson(responseNorm.last_response_ids),
      routingNorm.routing_envelope == null ? null : stableJson(routingNorm.routing_envelope),
      stableJson(receiptsNorm.tool_receipts),
      intent_mode,
      stableJson(grantsNorm.access_grant_ids),
      stableJson(taskRunsNorm.task_run_ids),
      isNonEmptyString(workspace_id) ? String(workspace_id).trim() : null,
      creator,
      now,
      now
    ).run();
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      return { ok: false, error: "conversation_session_already_exists", conversation_id: sessionId };
    }
    throw error;
  }

  const record = await getConversationSession(db, sessionId);
  return {
    ok: true,
    ...record,
    ...authorityClosedFields()
  };
}

export async function updateConversationSession(db, {
  conversation_id,
  actor_id,
  base_revision,
  status = undefined,
  attachment_set = undefined,
  active_scope = undefined,
  selected_actors = undefined,
  selected_repo = undefined,
  selected_chain = undefined,
  code_session_id = undefined,
  last_response_ids = undefined,
  routing_envelope = undefined,
  tool_receipts = undefined,
  intent_mode = undefined,
  access_grant_ids = undefined,
  task_run_ids = undefined,
  workspace_id = undefined
} = {}) {
  let sessionId;
  let actor;
  try {
    sessionId = conversationId(conversation_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_conversation_session_update", detail: String(error.message || error) };
  }
  if (!Number.isInteger(base_revision) || base_revision < 1) {
    return { ok: false, error: "conversation_session_base_revision_required" };
  }

  const current = await getConversationSession(db, sessionId);
  if (!current) return { ok: false, error: "conversation_session_not_found", conversation_id: sessionId };
  if (!actorMayAccessSession(current, actor)) {
    return {
      ok: false,
      error: "conversation_session_actor_not_member",
      conversation_id: sessionId,
      ...authorityClosedFields()
    };
  }
  if (current.session_revision !== base_revision) {
    return {
      ok: false,
      error: "conversation_session_conflict",
      conversation_id: sessionId,
      expected_session_revision: current.session_revision,
      provided_base_revision: base_revision,
      ...authorityClosedFields()
    };
  }

  let nextStatus = current.status;
  if (status !== undefined) {
    if (!STATUS_SET.has(status)) {
      return { ok: false, error: "invalid_conversation_session_status", allowed: [...CONVERSATION_SESSION_STATUSES] };
    }
    nextStatus = status;
  }

  let nextIntent = current.intent_mode;
  if (intent_mode !== undefined) {
    if (!INTENT_SET.has(intent_mode)) {
      return { ok: false, error: "invalid_intent_mode", allowed: [...CONVERSATION_INTENT_MODES] };
    }
    nextIntent = intent_mode;
  }

  let nextAttachments = current.attachment_set;
  if (attachment_set !== undefined) {
    const norm = normalizeAttachmentSet(attachment_set);
    if (!norm.ok) return norm;
    nextAttachments = norm.attachment_set;
  }

  let nextScope = current.active_scope;
  if (active_scope !== undefined) {
    const norm = normalizeActiveScope(active_scope);
    if (!norm.ok) return norm;
    nextScope = norm.active_scope;
  }

  let nextActors = current.selected_actors;
  if (selected_actors !== undefined) {
    const norm = normalizeSelectedActors(selected_actors, current.created_by);
    if (!norm.ok) return norm;
    nextActors = norm.selected_actors;
  }

  let nextRouting = current.routing_envelope;
  if (routing_envelope !== undefined) {
    const norm = normalizeRoutingEnvelope(routing_envelope);
    if (!norm.ok) return norm;
    nextRouting = norm.routing_envelope;
  }

  let nextReceipts = current.tool_receipts;
  if (tool_receipts !== undefined) {
    const norm = normalizeToolReceipts(tool_receipts);
    if (!norm.ok) return norm;
    nextReceipts = norm.tool_receipts;
  }

  let nextResponses = current.last_response_ids;
  if (last_response_ids !== undefined) {
    const norm = normalizeOpaqueIdList(last_response_ids, "last_response_ids", MAX_RESPONSE_IDS);
    if (!norm.ok) return norm;
    nextResponses = norm.last_response_ids;
  }

  let nextGrants = current.access_grant_ids;
  if (access_grant_ids !== undefined) {
    const norm = normalizeOpaqueIdList(access_grant_ids, "access_grant_ids", MAX_ACCESS_GRANT_IDS);
    if (!norm.ok) return norm;
    nextGrants = norm.access_grant_ids;
  }

  let nextTaskRuns = current.task_run_ids;
  if (task_run_ids !== undefined) {
    const norm = normalizeOpaqueIdList(task_run_ids, "task_run_ids", MAX_TASK_RUN_IDS);
    if (!norm.ok) return norm;
    nextTaskRuns = norm.task_run_ids;
  }

  let nextRepo = current.selected_repo;
  if (selected_repo !== undefined) {
    nextRepo = isNonEmptyString(selected_repo) ? String(selected_repo).trim().slice(0, 256) : null;
  }

  let nextChain = current.selected_chain;
  if (selected_chain !== undefined) {
    nextChain = isNonEmptyString(selected_chain) ? String(selected_chain).trim().slice(0, 256) : null;
  }

  let nextCodeSession = current.code_session_id;
  if (code_session_id !== undefined) {
    if (code_session_id === null || code_session_id === "") {
      nextCodeSession = null;
    } else if (!CODE_SESSION_ID_RE.test(String(code_session_id).trim())) {
      return { ok: false, error: "invalid_code_session_id" };
    } else {
      nextCodeSession = String(code_session_id).trim();
    }
  }

  let nextWorkspace = current.workspace_id;
  if (workspace_id !== undefined) {
    if (workspace_id === null || workspace_id === "") {
      nextWorkspace = null;
    } else if (!WORKSPACE_ID_RE.test(String(workspace_id).trim())) {
      return { ok: false, error: "invalid_workspace_id" };
    } else {
      nextWorkspace = String(workspace_id).trim();
    }
  }

  const now = new Date().toISOString();
  const nextRevision = current.session_revision + 1;
  const result = await db.prepare(
    `UPDATE conversation_sessions
     SET status = ?, attachment_set_json = ?, active_scope_json = ?, selected_actors_json = ?,
         selected_repo = ?, selected_chain = ?, code_session_id = ?, last_response_ids_json = ?,
         routing_envelope_json = ?, tool_receipts_json = ?, intent_mode = ?,
         access_grant_ids_json = ?, task_run_ids_json = ?, workspace_id = ?,
         session_revision = ?, updated_at = ?
     WHERE conversation_id = ? AND session_revision = ?`
  ).bind(
    nextStatus,
    stableJson(nextAttachments),
    nextScope == null ? null : stableJson(nextScope),
    stableJson(nextActors),
    nextRepo,
    nextChain,
    nextCodeSession,
    stableJson(nextResponses),
    nextRouting == null ? null : stableJson(nextRouting),
    stableJson(nextReceipts),
    nextIntent,
    stableJson(nextGrants),
    stableJson(nextTaskRuns),
    nextWorkspace,
    nextRevision,
    now,
    sessionId,
    current.session_revision
  ).run();

  if (!result?.meta?.changes) {
    const raced = await getConversationSession(db, sessionId);
    return {
      ok: false,
      error: "conversation_session_conflict",
      conversation_id: sessionId,
      expected_session_revision: raced?.session_revision || null,
      provided_base_revision: base_revision,
      ...authorityClosedFields()
    };
  }

  const record = await getConversationSession(db, sessionId);
  return {
    ok: true,
    ...record,
    ...authorityClosedFields()
  };
}

export async function appendConversationTurn(db, {
  conversation_id,
  actor_id,
  base_revision,
  turn_id,
  message_id,
  role,
  turn_type = "message",
  content_ref = null,
  content_preview = null,
  response_ids = [],
  context_pack_id = null,
  tool_receipt_refs = [],
  attachment_refs = [],
  access_grant_ids = [],
  object_refs = [],
  task_run_ids = [],
  routing_envelope = null,
  intent_mode = null
} = {}) {
  let sessionId;
  let actor;
  let turn;
  let msg;
  try {
    sessionId = conversationId(conversation_id);
    actor = actorId(actor_id, "actor_id");
    turn = turnId(turn_id);
    msg = messageId(message_id);
  } catch (error) {
    return { ok: false, error: "invalid_conversation_turn_append", detail: String(error.message || error) };
  }
  if (!Number.isInteger(base_revision) || base_revision < 1) {
    return { ok: false, error: "conversation_session_base_revision_required" };
  }
  if (!ROLE_SET.has(role)) {
    return { ok: false, error: "invalid_turn_role", allowed: [...CONVERSATION_TURN_ROLES] };
  }
  if (intent_mode !== null && intent_mode !== undefined && intent_mode !== "" && !INTENT_SET.has(intent_mode)) {
    return { ok: false, error: "invalid_intent_mode", allowed: [...CONVERSATION_INTENT_MODES] };
  }

  const current = await getConversationSession(db, sessionId);
  if (!current) return { ok: false, error: "conversation_session_not_found", conversation_id: sessionId };
  if (!actorMayAccessSession(current, actor)) {
    return {
      ok: false,
      error: "conversation_session_actor_not_member",
      conversation_id: sessionId,
      ...authorityClosedFields()
    };
  }
  if (current.status === "closed" || current.status === "superseded") {
    return {
      ok: false,
      error: "conversation_session_not_appendable",
      status: current.status,
      ...authorityClosedFields()
    };
  }
  if (current.session_revision !== base_revision) {
    return {
      ok: false,
      error: "conversation_session_conflict",
      conversation_id: sessionId,
      expected_session_revision: current.session_revision,
      provided_base_revision: base_revision,
      ...authorityClosedFields()
    };
  }

  const responseNorm = normalizeOpaqueIdList(response_ids, "response_ids", MAX_RESPONSE_IDS);
  if (!responseNorm.ok) return responseNorm;
  const receiptNorm = normalizeOpaqueIdList(tool_receipt_refs, "tool_receipt_refs", MAX_TOOL_RECEIPTS);
  if (!receiptNorm.ok) return receiptNorm;
  const attachNorm = normalizeOpaqueIdList(attachment_refs, "attachment_refs", MAX_ATTACHMENT_SET);
  if (!attachNorm.ok) return attachNorm;
  const grantNorm = normalizeOpaqueIdList(access_grant_ids, "access_grant_ids", MAX_ACCESS_GRANT_IDS);
  if (!grantNorm.ok) return grantNorm;
  const objectNorm = normalizeOpaqueIdList(object_refs, "object_refs", MAX_OBJECT_REFS);
  if (!objectNorm.ok) return objectNorm;
  const taskNorm = normalizeOpaqueIdList(task_run_ids, "task_run_ids", MAX_TASK_RUN_IDS);
  if (!taskNorm.ok) return taskNorm;
  const routingNorm = normalizeRoutingEnvelope(routing_envelope);
  if (!routingNorm.ok) return routingNorm;

  const seq = (Array.isArray(current.message_log) ? current.message_log.length : 0) + 1;
  if (seq > MAX_MESSAGE_LOG) {
    return { ok: false, error: "conversation_message_log_full", max: MAX_MESSAGE_LOG };
  }

  const now = new Date().toISOString();
  const preview = isNonEmptyString(content_preview)
    ? String(content_preview).trim().slice(0, MAX_CONTENT_PREVIEW)
    : null;
  const contentRef = isNonEmptyString(content_ref)
    ? String(content_ref).trim().slice(0, MAX_REF_LEN)
    : null;
  const contextPackId = isNonEmptyString(context_pack_id)
    ? String(context_pack_id).trim().slice(0, 128)
    : null;
  const turnIntent = INTENT_SET.has(intent_mode) ? intent_mode : current.intent_mode;

  try {
    await db.prepare(
      `INSERT INTO conversation_turns (
        turn_id, conversation_id, message_id, seq, role, turn_type, content_ref,
        content_preview, response_ids_json, context_pack_id, tool_receipt_refs_json,
        attachment_refs_json, access_grant_ids_json, object_refs_json, task_run_ids_json,
        routing_envelope_json, intent_mode, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      turn,
      sessionId,
      msg,
      seq,
      role,
      isNonEmptyString(turn_type) ? String(turn_type).trim().slice(0, 64) : "message",
      contentRef,
      preview,
      stableJson(responseNorm.response_ids),
      contextPackId,
      stableJson(receiptNorm.tool_receipt_refs),
      stableJson(attachNorm.attachment_refs),
      stableJson(grantNorm.access_grant_ids),
      stableJson(objectNorm.object_refs),
      stableJson(taskNorm.task_run_ids),
      routingNorm.routing_envelope == null ? null : stableJson(routingNorm.routing_envelope),
      turnIntent,
      actor,
      now
    ).run();
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      return {
        ok: false,
        error: "conversation_turn_already_exists",
        turn_id: turn,
        message_id: msg,
        ...authorityClosedFields()
      };
    }
    throw error;
  }

  const turnRecord = {
    schema: CONVERSATION_TURN_SCHEMA,
    turn_id: turn,
    conversation_id: sessionId,
    message_id: msg,
    seq,
    role,
    turn_type: isNonEmptyString(turn_type) ? String(turn_type).trim().slice(0, 64) : "message",
    content_ref: contentRef,
    content_preview: preview,
    response_ids: responseNorm.response_ids,
    context_pack_id: contextPackId,
    tool_receipt_refs: receiptNorm.tool_receipt_refs,
    attachment_refs: attachNorm.attachment_refs,
    access_grant_ids: grantNorm.access_grant_ids,
    object_refs: objectNorm.object_refs,
    task_run_ids: taskNorm.task_run_ids,
    routing_envelope: routingNorm.routing_envelope,
    intent_mode: turnIntent,
    actor_id: actor,
    created_at: now,
    ...authorityClosedFields()
  };

  const nextLog = [...(current.message_log || []), turnStubFromRecord(turnRecord)].slice(-MAX_MESSAGE_LOG);
  const nextResponses = [...new Set([
    ...(current.last_response_ids || []),
    ...(turnRecord.response_ids || [])
  ])].slice(-MAX_RESPONSE_IDS);
  const nextGrants = [...new Set([
    ...(current.access_grant_ids || []),
    ...(turnRecord.access_grant_ids || [])
  ])].slice(-MAX_ACCESS_GRANT_IDS);
  const nextTaskRuns = [...new Set([
    ...(current.task_run_ids || []),
    ...(turnRecord.task_run_ids || [])
  ])].slice(-MAX_TASK_RUN_IDS);
  const nextReceipts = [
    ...(current.tool_receipts || []),
    ...(turnRecord.tool_receipt_refs || []).map(ref => ({ ref, kind: "tool_receipt" }))
  ].slice(-MAX_TOOL_RECEIPTS);
  const nextRouting = routingNorm.routing_envelope || current.routing_envelope;
  const nextRevision = current.session_revision + 1;

  const result = await db.prepare(
    `UPDATE conversation_sessions
     SET message_log_json = ?, last_response_ids_json = ?, tool_receipts_json = ?,
         routing_envelope_json = ?, access_grant_ids_json = ?, task_run_ids_json = ?,
         intent_mode = ?, session_revision = ?, updated_at = ?, status = CASE
           WHEN status = 'paused' THEN 'active'
           ELSE status
         END
     WHERE conversation_id = ? AND session_revision = ?`
  ).bind(
    stableJson(nextLog),
    stableJson(nextResponses),
    stableJson(nextReceipts),
    nextRouting == null ? null : stableJson(nextRouting),
    stableJson(nextGrants),
    stableJson(nextTaskRuns),
    turnIntent,
    nextRevision,
    now,
    sessionId,
    current.session_revision
  ).run();

  if (!result?.meta?.changes) {
    const raced = await getConversationSession(db, sessionId);
    return {
      ok: false,
      error: "conversation_session_conflict",
      conversation_id: sessionId,
      expected_session_revision: raced?.session_revision || null,
      provided_base_revision: base_revision,
      detail: "turn_inserted_session_cas_failed",
      ...authorityClosedFields()
    };
  }

  const session = await getConversationSession(db, sessionId);
  return {
    ok: true,
    turn: turnRecord,
    conversation_session: session,
    ...authorityClosedFields()
  };
}

export async function listConversationSessions(db, {
  actor_id,
  status = null,
  limit = DEFAULT_LIST
} = {}) {
  let actor;
  try {
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_actor_id", detail: String(error.message || error) };
  }
  const capped = Math.min(Math.max(Number(limit) || DEFAULT_LIST, 1), MAX_LIST);
  const result = await db.prepare(
    `SELECT conversation_id, status, message_log_json, attachment_set_json, active_scope_json,
            selected_actors_json, selected_repo, selected_chain, code_session_id,
            last_response_ids_json, routing_envelope_json, tool_receipts_json, intent_mode,
            access_grant_ids_json, task_run_ids_json, workspace_id, session_revision,
            created_by, created_at, updated_at, accepted_state_authority
     FROM conversation_sessions
     ORDER BY updated_at DESC
     LIMIT ?`
  ).bind(Math.min(capped * 20, 500)).all();

  const rows = (result?.results || [])
    .map(rowToConversationSessionRecord)
    .filter(session => actorMayAccessSession(session, actor))
    .filter(session => (status ? session.status === status : true))
    .slice(0, capped);

  return {
    ok: true,
    actor_id: actor,
    conversations: rows,
    count: rows.length,
    ...authorityClosedFields()
  };
}

export async function createConversationSessionFromBody(body = {}, env = {}) {
  const bindings = conversationEnvBindings(env);
  if (!bindings.ok) return bindings;

  const creator = requireActorField(body, "created_by");
  if (!creator.ok) return creator;
  if (!isNonEmptyString(body.conversation_id)) {
    return { ok: false, error: "conversation_id_required_for_create" };
  }

  return createConversationSession(bindings.db, {
    conversation_id: body.conversation_id,
    created_by: creator.value,
    status: body.status,
    attachment_set: body.attachment_set,
    active_scope: body.active_scope,
    selected_actors: body.selected_actors,
    selected_repo: body.selected_repo,
    selected_chain: body.selected_chain,
    code_session_id: body.code_session_id,
    last_response_ids: body.last_response_ids,
    routing_envelope: body.routing_envelope,
    tool_receipts: body.tool_receipts,
    intent_mode: body.intent_mode,
    access_grant_ids: body.access_grant_ids,
    task_run_ids: body.task_run_ids,
    workspace_id: body.workspace_id,
    message_log: body.message_log
  });
}

export async function getConversationSessionFromBody(body = {}, env = {}) {
  const bindings = conversationEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.conversation_id)) {
    return { ok: false, error: "conversation_id_required" };
  }

  const session = await getConversationSession(bindings.db, body.conversation_id);
  if (!session) {
    return { ok: false, error: "conversation_session_not_found", conversation_id: body.conversation_id };
  }
  if (!actorMayAccessSession(session, actor.value)) {
    return {
      ok: false,
      error: "conversation_session_actor_not_member",
      conversation_id: session.conversation_id,
      ...authorityClosedFields()
    };
  }

  const includeTurns = body.include_turns !== false;
  const turns = includeTurns
    ? await listConversationTurns(bindings.db, session.conversation_id)
    : undefined;

  return {
    ok: true,
    ...session,
    ...(includeTurns ? { turns } : {}),
    resume: {
      conversation_id: session.conversation_id,
      session_revision: session.session_revision,
      status: session.status,
      message_count: Array.isArray(session.message_log) ? session.message_log.length : 0,
      intent_mode: session.intent_mode,
      currentness_basis: "session_revision+turn_id+message_id"
    },
    ...authorityClosedFields()
  };
}

export async function listConversationSessionsFromBody(body = {}, env = {}) {
  const bindings = conversationEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;

  return listConversationSessions(bindings.db, {
    actor_id: actor.value,
    status: body.status || null,
    limit: body.limit
  });
}

export async function updateConversationSessionFromBody(body = {}, env = {}) {
  const bindings = conversationEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.conversation_id)) {
    return { ok: false, error: "conversation_id_required" };
  }
  if (!Number.isInteger(body.base_revision)) {
    return { ok: false, error: "base_revision_required", detail: "integer_session_revision_required" };
  }

  return updateConversationSession(bindings.db, {
    conversation_id: body.conversation_id,
    actor_id: actor.value,
    base_revision: body.base_revision,
    status: body.status,
    attachment_set: body.attachment_set,
    active_scope: body.active_scope,
    selected_actors: body.selected_actors,
    selected_repo: body.selected_repo,
    selected_chain: body.selected_chain,
    code_session_id: body.code_session_id,
    last_response_ids: body.last_response_ids,
    routing_envelope: body.routing_envelope,
    tool_receipts: body.tool_receipts,
    intent_mode: body.intent_mode,
    access_grant_ids: body.access_grant_ids,
    task_run_ids: body.task_run_ids,
    workspace_id: body.workspace_id
  });
}

export async function appendConversationTurnFromBody(body = {}, env = {}) {
  const bindings = conversationEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.conversation_id)) {
    return { ok: false, error: "conversation_id_required" };
  }
  if (!Number.isInteger(body.base_revision)) {
    return { ok: false, error: "base_revision_required", detail: "integer_session_revision_required" };
  }
  if (!isNonEmptyString(body.turn_id)) {
    return { ok: false, error: "turn_id_required" };
  }
  if (!isNonEmptyString(body.message_id)) {
    return { ok: false, error: "message_id_required" };
  }
  if (!isNonEmptyString(body.role)) {
    return { ok: false, error: "role_required" };
  }

  return appendConversationTurn(bindings.db, {
    conversation_id: body.conversation_id,
    actor_id: actor.value,
    base_revision: body.base_revision,
    turn_id: body.turn_id,
    message_id: body.message_id,
    role: body.role,
    turn_type: body.turn_type,
    content_ref: body.content_ref,
    content_preview: body.content_preview,
    response_ids: body.response_ids,
    context_pack_id: body.context_pack_id,
    tool_receipt_refs: body.tool_receipt_refs,
    attachment_refs: body.attachment_refs,
    access_grant_ids: body.access_grant_ids,
    object_refs: body.object_refs,
    task_run_ids: body.task_run_ids,
    routing_envelope: body.routing_envelope,
    intent_mode: body.intent_mode
  });
}

export const CONVERSATION_SESSION_CREATE_TOOL_DEFINITION = Object.freeze({
  name: CONVERSATION_SESSION_BROKER_TOOL_IDS.create,
  description: "V7.7.10a: create cairnstone-conversation-session-v1 operational record with lean access_grant_ids/object_ref/task_run_ids hooks. Actor membership only; never moves HEADs; never accepted-state authority; never promotes conversation history to project memory.",
  inputSchema: {
    type: "object",
    required: ["conversation_id", "created_by"],
    properties: {
      conversation_id: { type: "string", description: "cvs:…" },
      created_by: { type: "string" },
      status: { type: "string", enum: [...CONVERSATION_SESSION_STATUSES] },
      attachment_set: { type: "array", maxItems: MAX_ATTACHMENT_SET },
      active_scope: { type: ["object", "string", "null"] },
      selected_actors: { type: "array", maxItems: MAX_SELECTED_ACTORS },
      selected_repo: { type: "string" },
      selected_chain: { type: "string" },
      code_session_id: { type: "string" },
      last_response_ids: { type: "array", maxItems: MAX_RESPONSE_IDS, items: { type: "string" } },
      routing_envelope: { type: "object" },
      tool_receipts: { type: "array", maxItems: MAX_TOOL_RECEIPTS },
      intent_mode: { type: "string", enum: [...CONVERSATION_INTENT_MODES] },
      access_grant_ids: { type: "array", maxItems: MAX_ACCESS_GRANT_IDS, items: { type: "string" } },
      task_run_ids: { type: "array", maxItems: MAX_TASK_RUN_IDS, items: { type: "string" } },
      workspace_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const CONVERSATION_SESSION_GET_TOOL_DEFINITION = Object.freeze({
  name: CONVERSATION_SESSION_BROKER_TOOL_IDS.get,
  description: "V7.7.10a: read/resume cairnstone-conversation-session-v1 including durable turns. Requires actor membership (created_by|selected_actors). Never accepted-state authority.",
  inputSchema: {
    type: "object",
    required: ["conversation_id", "actor_id"],
    properties: {
      conversation_id: { type: "string" },
      actor_id: { type: "string" },
      include_turns: { type: "boolean" }
    },
    additionalProperties: false
  }
});

export const CONVERSATION_SESSION_LIST_TOOL_DEFINITION = Object.freeze({
  name: CONVERSATION_SESSION_BROKER_TOOL_IDS.list,
  description: "V7.7.10a: list Conversation Sessions visible to an actor (created_by or selected_actors). Newest-first, bounded. Never moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["actor_id"],
    properties: {
      actor_id: { type: "string" },
      status: { type: "string", enum: [...CONVERSATION_SESSION_STATUSES] },
      limit: { type: "number", minimum: 1, maximum: MAX_LIST }
    },
    additionalProperties: false
  }
});

export const CONVERSATION_SESSION_UPDATE_TOOL_DEFINITION = Object.freeze({
  name: CONVERSATION_SESSION_BROKER_TOOL_IDS.update,
  description: "V7.7.10a: CAS-update Conversation Session bindings (scope/actors/repo/chain/code_session/intent/status/lean hooks). Requires base_revision + actor membership. Never moves HEADs; never grants capabilities.",
  inputSchema: {
    type: "object",
    required: ["conversation_id", "actor_id", "base_revision"],
    properties: {
      conversation_id: { type: "string" },
      actor_id: { type: "string" },
      base_revision: { type: "number", minimum: 1 },
      status: { type: "string", enum: [...CONVERSATION_SESSION_STATUSES] },
      attachment_set: { type: "array", maxItems: MAX_ATTACHMENT_SET },
      active_scope: { type: ["object", "string", "null"] },
      selected_actors: { type: "array", maxItems: MAX_SELECTED_ACTORS },
      selected_repo: { type: "string" },
      selected_chain: { type: "string" },
      code_session_id: { type: "string" },
      last_response_ids: { type: "array", maxItems: MAX_RESPONSE_IDS, items: { type: "string" } },
      routing_envelope: { type: "object" },
      tool_receipts: { type: "array", maxItems: MAX_TOOL_RECEIPTS },
      intent_mode: { type: "string", enum: [...CONVERSATION_INTENT_MODES] },
      access_grant_ids: { type: "array", maxItems: MAX_ACCESS_GRANT_IDS, items: { type: "string" } },
      task_run_ids: { type: "array", maxItems: MAX_TASK_RUN_IDS, items: { type: "string" } },
      workspace_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const CONVERSATION_SESSION_APPEND_TURN_TOOL_DEFINITION = Object.freeze({
  name: CONVERSATION_SESSION_BROKER_TOOL_IDS.append_turn,
  description: "V7.7.10a: append durable turn/message identity to a Conversation Session (CAS on session_revision). Stable turn_id + message_id; optional opaque access_grant_ids/object_refs/task_run_ids. Never moves HEADs; never promotes to project memory.",
  inputSchema: {
    type: "object",
    required: ["conversation_id", "actor_id", "base_revision", "turn_id", "message_id", "role"],
    properties: {
      conversation_id: { type: "string" },
      actor_id: { type: "string" },
      base_revision: { type: "number", minimum: 1 },
      turn_id: { type: "string", description: "turn:…" },
      message_id: { type: "string", description: "cmsg:…" },
      role: { type: "string", enum: [...CONVERSATION_TURN_ROLES] },
      turn_type: { type: "string" },
      content_ref: { type: "string" },
      content_preview: { type: "string", maxLength: MAX_CONTENT_PREVIEW },
      response_ids: { type: "array", maxItems: MAX_RESPONSE_IDS, items: { type: "string" } },
      context_pack_id: { type: "string" },
      tool_receipt_refs: { type: "array", maxItems: MAX_TOOL_RECEIPTS, items: { type: "string" } },
      attachment_refs: { type: "array", maxItems: MAX_ATTACHMENT_SET, items: { type: "string" } },
      access_grant_ids: { type: "array", maxItems: MAX_ACCESS_GRANT_IDS, items: { type: "string" } },
      object_refs: { type: "array", maxItems: MAX_OBJECT_REFS, items: { type: "string" } },
      task_run_ids: { type: "array", maxItems: MAX_TASK_RUN_IDS, items: { type: "string" } },
      routing_envelope: { type: "object" },
      intent_mode: { type: "string", enum: [...CONVERSATION_INTENT_MODES] }
    },
    additionalProperties: false
  }
});

export const CONVERSATION_SESSION_MCP_TOOL_DEFINITIONS = Object.freeze([
  CONVERSATION_SESSION_CREATE_TOOL_DEFINITION,
  CONVERSATION_SESSION_GET_TOOL_DEFINITION,
  CONVERSATION_SESSION_LIST_TOOL_DEFINITION,
  CONVERSATION_SESSION_UPDATE_TOOL_DEFINITION,
  CONVERSATION_SESSION_APPEND_TURN_TOOL_DEFINITION
]);
