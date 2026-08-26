import { sha256Text, stableJson } from "./agent-bootstrap.js";

export const TOOL_AUTHORIZATION_DECISION_SCHEMA = "cairnstone-tool-authorization-decision-v1";
export const TOOL_AUTHORIZED_EXECUTION_RECEIPT_SCHEMA = "cairnstone-tool-authorized-execution-receipt-v1";
export const TOOL_AUTHORIZATION_GRANT_CHAIN = "cairnstone-v7-tool-authorization-grants";
export const TOOL_AUTHORIZED_EXECUTION_CHAIN = "cairnstone-v7-tool-authorized-executions";

const DEFAULT_AUTHORIZATION_TTL_SECONDS = 900;
const MIN_AUTHORIZATION_TTL_SECONDS = 60;
const MAX_AUTHORIZATION_TTL_SECONDS = 3600;
const FORBIDDEN_REPLACEMENT_FIELDS = Object.freeze([
  "arguments", "tool_id", "tool_intent", "context_package", "target", "replacement_arguments"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function changesOf(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function replacementField(body) {
  for (const key of FORBIDDEN_REPLACEMENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body || {}, key)) return key;
  }
  return null;
}

async function argumentDigest(args) {
  return "sha256:" + await sha256Text(stableJson(isObject(args) ? args : {}));
}

function parseRequestJson(row) {
  try {
    const parsed = JSON.parse(row.request_json);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowToAuthorization(row) {
  if (!row) return null;
  const request = parseRequestJson(row);
  return {
    authorization_request_id: row.authorization_request_id,
    request_stone_hash: row.request_stone_hash,
    argument_digest: row.argument_digest,
    required_authorization: row.required_authorization,
    status: row.status,
    decision: row.decision || null,
    authorization_subject: row.authorization_subject || null,
    authorization_method: row.authorization_method || null,
    grant_stone_hash: row.grant_stone_hash || null,
    denial_stone_hash: row.denial_stone_hash || null,
    issued_at: row.issued_at || null,
    expires_at: row.expires_at || null,
    consumption_id: row.consumption_id || null,
    consumed_at: row.consumed_at || null,
    guard: request?.guard || null,
    tool_id: request?.tool_id || request?.target?.tool_id || null,
    package_id: request?.package_id || null,
    request_ir_id: request?.request_ir_id || null,
    decision_id: request?.decision_id || null,
    model: request?.model || null,
    turn_id: request?.turn_id || null,
    justification: request?.justification || null,
    target: request?.target || null,
    request,
    execution_receipt_stone_hash: row.execution_receipt_stone_hash || null,
    execution_result_json: row.execution_result_json || null,
    error_type: row.error_type || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function dbLoad(env, authorizationRequestId) {
  const row = await env.CAIRNSTONE_DB.prepare(
    "SELECT * FROM tool_authorizations WHERE authorization_request_id = ?"
  ).bind(authorizationRequestId).first();
  return rowToAuthorization(row);
}

async function dbTransition(env, authorizationRequestId, fromStatus, toStatus, fields = {}) {
  const keys = Object.keys(fields);
  const assignments = ["status = ?", ...keys.map(key => `${key} = ?`), "updated_at = ?"];
  const now = new Date().toISOString();
  const values = [toStatus, ...keys.map(key => fields[key]), now, authorizationRequestId, fromStatus];
  const result = await env.CAIRNSTONE_DB.prepare(
    `UPDATE tool_authorizations SET ${assignments.join(", ")} WHERE authorization_request_id = ? AND status = ?`
  ).bind(...values).run();
  return { ok: true, changed: changesOf(result) === 1, changes: changesOf(result), updated_at: now };
}

async function dbUpdate(env, authorizationRequestId, fields = {}) {
  const keys = Object.keys(fields);
  if (!keys.length) return { ok: true, changed: false };
  const now = new Date().toISOString();
  const assignments = [...keys.map(key => `${key} = ?`), "updated_at = ?"];
  const values = [...keys.map(key => fields[key]), now, authorizationRequestId];
  const result = await env.CAIRNSTONE_DB.prepare(
    `UPDATE tool_authorizations SET ${assignments.join(", ")} WHERE authorization_request_id = ?`
  ).bind(...values).run();
  return { ok: true, changed: changesOf(result) === 1, changes: changesOf(result), updated_at: now };
}

function lifecycle(deps, env) {
  return {
    load: typeof deps.loadAuthorization === "function" ? deps.loadAuthorization : id => dbLoad(env, id),
    transition: typeof deps.transitionAuthorization === "function"
      ? deps.transitionAuthorization
      : (id, from, to, fields) => dbTransition(env, id, from, to, fields),
    update: typeof deps.updateAuthorization === "function"
      ? deps.updateAuthorization
      : (id, fields) => dbUpdate(env, id, fields)
  };
}

export async function persistPendingAuthorizationRecord(record, env, deps = {}) {
  if (typeof deps.persistPending === "function") return deps.persistPending(record);
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "authorization_lifecycle_db_unavailable" };

  const createdAt = record.created_at || new Date().toISOString();
  const guard = record.guard || null;
  const result = await env.CAIRNSTONE_DB.prepare(
    `INSERT OR IGNORE INTO tool_authorizations (
      authorization_request_id,request_stone_hash,request_json,argument_digest,
      required_authorization,status,guard_type,guard_expected,created_at,updated_at
    ) VALUES (?,?,?,?,?,'pending',?,?,?,?)`
  ).bind(
    record.authorization_request_id,
    record.request_stone_hash,
    record.request_json,
    record.argument_digest,
    record.required_authorization,
    guard?.type || null,
    guard && Object.prototype.hasOwnProperty.call(guard, "expected_value") ? guard.expected_value : null,
    createdAt,
    createdAt
  ).run();

  const current = await dbLoad(env, record.authorization_request_id);
  if (!current) return { ok: false, error: "authorization_lifecycle_persist_failed" };
  if (
    current.request_stone_hash !== record.request_stone_hash ||
    current.argument_digest !== record.argument_digest ||
    current.request?.authorization_request_id !== record.authorization_request_id
  ) {
    return { ok: false, error: "authorization_lifecycle_idempotency_conflict" };
  }
  return { ok: true, idempotent_replay: changesOf(result) === 0, authorization: current };
}

export async function listToolAuthorizationsFromBody(body, env, deps = {}) {
  if (typeof deps.listAuthorizations === "function") return deps.listAuthorizations(body);
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "authorization_lifecycle_db_unavailable" };
  const status = typeof body?.status === "string" && body.status.trim() ? body.status.trim() : null;
  const decision = typeof body?.decision === "string" && body.decision.trim() ? body.decision.trim() : null;
  const limit = clampInt(body?.limit, 1, 200, 50);
  let result;
  if (status && decision) {
    result = await env.CAIRNSTONE_DB.prepare(
      "SELECT * FROM tool_authorizations WHERE status = ? AND decision = ? ORDER BY COALESCE(issued_at, created_at) DESC, created_at DESC LIMIT ?"
    ).bind(status, decision, limit).all();
  } else if (decision) {
    result = await env.CAIRNSTONE_DB.prepare(
      "SELECT * FROM tool_authorizations WHERE decision = ? ORDER BY COALESCE(issued_at, created_at) DESC, created_at DESC LIMIT ?"
    ).bind(decision, limit).all();
  } else if (status) {
    result = await env.CAIRNSTONE_DB.prepare(
      "SELECT * FROM tool_authorizations WHERE status = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(status, limit).all();
  } else {
    result = await env.CAIRNSTONE_DB.prepare("SELECT * FROM tool_authorizations ORDER BY created_at DESC LIMIT ?").bind(limit).all();
  }
  return { ok: true, total: result.results?.length || 0, authorizations: (result.results || []).map(rowToAuthorization) };
}

export async function getToolAuthorizationFromBody(body, env, deps = {}) {
  const id = typeof body?.authorization_request_id === "string" ? body.authorization_request_id.trim() : "";
  if (!id) return { ok: false, error: "missing_authorization_request_id" };
  const store = lifecycle(deps, env);
  const authorization = await store.load(id);
  if (!authorization) return { ok: false, error: "authorization_not_found", authorization_request_id: id };
  return { ok: true, authorization };
}

export const TOOL_AUTHORIZATION_STATUS_SCHEMA = "cairnstone-tool-authorization-status-v1";

export async function getToolAuthorizationStatusFromBody(body, env, deps = {}) {
  const result = await getToolAuthorizationFromBody(body, env, deps);
  if (!result.ok) return result;
  const authorization = result.authorization;
  let execution = null;
  try {
    execution = authorization.execution_result_json ? JSON.parse(authorization.execution_result_json) : null;
  } catch {
    execution = null;
  }
  const consumed = Boolean(authorization.consumption_id);
  const terminal = ["executed", "guard_failed", "execution_failed", "denied", "expired", "authorization_failed"].includes(authorization.status);
  const replaySafe = consumed || terminal;
  const replayBehavior = authorization.status === "executed" && execution
    ? "idempotent_replay_returns_existing_result"
    : replaySafe
      ? "non_executable_or_already_claimed"
      : "not_yet_consumed";
  const guard = execution?.guard || null;
  return {
    ok: true,
    schema: TOOL_AUTHORIZATION_STATUS_SCHEMA,
    authorization_request_id: authorization.authorization_request_id,
    request_stone_hash: authorization.request_stone_hash,
    tool_id: authorization.tool_id,
    argument_digest: authorization.argument_digest,
    required_authorization: authorization.required_authorization,
    status: authorization.status,
    decision: authorization.decision || null,
    consumed,
    consumption_id: authorization.consumption_id || null,
    consumed_at: authorization.consumed_at || null,
    terminal,
    grant_stone_hash: authorization.grant_stone_hash || null,
    denial_stone_hash: authorization.denial_stone_hash || null,
    execution_receipt_stone_hash: authorization.execution_receipt_stone_hash || null,
    outcome: {
      executed: execution?.executed === true,
      mutation_performed: execution?.mutation_performed === true,
      error: execution?.error || authorization.error_type || null,
      guard: guard ? {
        type: guard.type || null,
        expected_value: Object.prototype.hasOwnProperty.call(guard, "expected_value") ? guard.expected_value : null,
        observed_value: Object.prototype.hasOwnProperty.call(guard, "observed_value") ? guard.observed_value : null,
        matched: guard.matched === true
      } : null
    },
    replay: { safe_no_second_mutation: replaySafe, behavior: replayBehavior },
    policy: {
      read_only: true,
      operator_authorization_required: false,
      execution_authority: false,
      mutation_authority: false,
      arguments_exposed: false,
      operator_credentials_exposed: false
    }
  };
}

export const TOOL_AUTHORIZATION_STATUS_TOOL_DEFINITION = {
  name: "cairnstone_tool_authorization_status",
  description: "V7.3.3 read-only lifecycle inspection for one authorization request. Reports whether the one-time authorization has been consumed and its terminal execution/guard outcome without exposing target arguments, operator credentials, approval capability, or mutation authority.",
  inputSchema: {
    type: "object",
    required: ["authorization_request_id"],
    properties: { authorization_request_id: { type: "string" } },
    additionalProperties: false
  }
};

export const TOOL_AUTHORIZATION_LIST_SCHEMA = "cairnstone-tool-authorization-list-v1";
const AUTHORIZATION_LIST_DEFAULT_LIMIT = 20;
const AUTHORIZATION_LIST_MAX_LIMIT = 50;
const AUTHORIZATION_LIST_FETCH_LIMIT = 200;
export const AUTHORIZATION_LIST_ALLOWED_STATUS = Object.freeze([
  "pending", "deciding", "authorized", "denied", "expired", "authorization_failed",
  "consuming", "executed", "guard_failed", "execution_failed"
]);
export const AUTHORIZATION_LIST_ALLOWED_DECISION = Object.freeze(["approved", "denied"]);
const AUTHORIZATION_LIST_TERMINAL_STATUSES = ["executed", "guard_failed", "execution_failed", "denied", "expired", "authorization_failed"];

function compactAuthorizationListEntry(authorization) {
  let execution = null;
  try {
    execution = authorization.execution_result_json ? JSON.parse(authorization.execution_result_json) : null;
  } catch {
    execution = null;
  }
  const consumed = Boolean(authorization.consumption_id);
  const terminal = AUTHORIZATION_LIST_TERMINAL_STATUSES.includes(authorization.status);
  const guard = execution?.guard || null;
  return {
    authorization_request_id: authorization.authorization_request_id,
    tool_id: authorization.tool_id,
    status: authorization.status,
    decision: authorization.decision || null,
    created_at: authorization.created_at,
    decided_at: authorization.issued_at || null,
    consumed,
    consumed_at: authorization.consumed_at || null,
    terminal,
    request_stone_hash: authorization.request_stone_hash,
    grant_stone_hash: authorization.grant_stone_hash || null,
    denial_stone_hash: authorization.denial_stone_hash || null,
    execution_receipt_stone_hash: authorization.execution_receipt_stone_hash || null,
    guard: guard ? { type: guard.type || null, matched: guard.matched === true } : null,
    outcome: execution
      ? {
          executed: execution.executed === true,
          mutation_performed: execution.mutation_performed === true,
          error: execution.error || authorization.error_type || null
        }
      : (authorization.error_type ? { executed: false, mutation_performed: false, error: authorization.error_type } : null)
  };
}

// V7.4.0: bounded, read-only discovery of recent authorization lifecycle
// records. cairnstone_tool_authorization_status can verify one already-known
// request id; this primitive answers "what are my most recent approvals"
// from a fresh context, which status alone cannot. Built directly on top of
// listToolAuthorizationsFromBody (already used by the operator-only REST
// GET /v1/tool-authorizations route) but returns only an explicit
// allowlisted projection of safe fields -- it never spreads the underlying
// authorization/request/target object, so stored mutation arguments,
// justification text, model identity, and any other non-listed field can
// never leak through this MCP-facing surface even if the underlying row
// shape changes later.
export async function listToolAuthorizationsCompactFromBody(body, env, deps = {}) {
  const status = typeof body?.status === "string" && body.status.trim() ? body.status.trim() : null;
  if (status && !AUTHORIZATION_LIST_ALLOWED_STATUS.includes(status)) {
    return { ok: false, error: "invalid_status_filter", allowed: AUTHORIZATION_LIST_ALLOWED_STATUS };
  }
  const decision = typeof body?.decision === "string" && body.decision.trim() ? body.decision.trim() : null;
  if (decision && !AUTHORIZATION_LIST_ALLOWED_DECISION.includes(decision)) {
    return { ok: false, error: "invalid_decision_filter", allowed: AUTHORIZATION_LIST_ALLOWED_DECISION };
  }
  const limit = clampInt(body?.limit, 1, AUTHORIZATION_LIST_MAX_LIMIT, AUTHORIZATION_LIST_DEFAULT_LIMIT);

  const raw = await listToolAuthorizationsFromBody({ status, decision, limit: AUTHORIZATION_LIST_FETCH_LIMIT }, env, deps);
  if (!raw.ok) return raw;

  let authorizations = Array.isArray(raw.authorizations) ? raw.authorizations : [];
  if (decision) {
    authorizations = authorizations
      .filter(entry => entry.decision === decision)
      .sort((a, b) => {
        const aTime = Date.parse(a.issued_at || a.created_at || "") || 0;
        const bTime = Date.parse(b.issued_at || b.created_at || "") || 0;
        if (aTime !== bTime) return bTime - aTime;
        return (Date.parse(b.created_at || "") || 0) - (Date.parse(a.created_at || "") || 0);
      });
  }
  const truncatedByFetchLimit = raw.total === AUTHORIZATION_LIST_FETCH_LIMIT;
  authorizations = authorizations.slice(0, limit);

  return {
    ok: true,
    schema: TOOL_AUTHORIZATION_LIST_SCHEMA,
    total: authorizations.length,
    filters: { status, decision, limit },
    authorizations: authorizations.map(compactAuthorizationListEntry),
    truncated: truncatedByFetchLimit,
    policy: {
      read_only: true,
      operator_authorization_required: false,
      execution_authority: false,
      mutation_authority: false,
      arguments_exposed: false,
      operator_credentials_exposed: false
    }
  };
}

export const TOOL_AUTHORIZATION_LIST_TOOL_DEFINITION = {
  name: "cairnstone_tool_authorization_list",
  description: "V7.4.0 read-only bounded discovery of recent tool authorization lifecycle records, most recent first. Answers 'what are my most recent approvals/pending authorizations' from a fresh context, which cairnstone_tool_authorization_status alone cannot since it requires an already-known id. Returns only compact non-secret metadata per record: request id, tool id, status, decision, created/decided/consumed timestamps, consumed/terminal flags, receipt/grant/denial Stone identities, and a compact guard/outcome summary. Never exposes stored target mutation arguments, justification text, operator credentials, or any execution/mutation authority. Use cairnstone_tool_authorization_status afterward for full lifecycle detail on one selected id.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: [...AUTHORIZATION_LIST_ALLOWED_STATUS] },
      decision: { type: "string", enum: [...AUTHORIZATION_LIST_ALLOWED_DECISION] },
      limit: { type: "number", minimum: 1, maximum: AUTHORIZATION_LIST_MAX_LIMIT }
    },
    additionalProperties: false
  }
};

async function createEvidenceStone(deps, body) {
  if (typeof deps.createStone !== "function") return { ok: false, error: "authorization_evidence_persistence_unavailable" };
  const created = await deps.createStone(body);
  if (!created || created.ok !== true || typeof created.stone_hash !== "string") {
    return { ok: false, error: "authorization_evidence_persist_failed" };
  }
  return { ok: true, stone_hash: created.stone_hash };
}

async function linkEvidence(deps, fromHash, toHash, note) {
  if (!fromHash || !toHash || typeof deps.linkStones !== "function") return;
  try {
    await deps.linkStones({ from_hash: fromHash, to_hash: toHash, edge_type: "references", note });
  } catch {
    // Evidence is still immutable and addressable even if a non-authoritative
    // graph-link write fails; callers surface the hashes directly.
  }
}

export async function authorizeToolRequestFromBody(body, env, deps = {}) {
  if (!isObject(body)) return { ok: false, error: "invalid_tool_authorization_decision" };
  const forbidden = replacementField(body);
  if (forbidden) return { ok: false, error: "authorization_argument_substitution_not_accepted", field: forbidden };

  const id = typeof body.authorization_request_id === "string" ? body.authorization_request_id.trim() : "";
  const decision = body.decision === "approve" ? "approved" : body.decision === "deny" ? "denied" : null;
  const subject = typeof body.authorization_subject === "string" ? body.authorization_subject.trim() : "";
  const method = typeof body.authorization_method === "string" ? body.authorization_method.trim() : "";
  if (!id) return { ok: false, error: "missing_authorization_request_id" };
  if (!decision) return { ok: false, error: "invalid_authorization_decision", allowed: ["approve", "deny"] };
  if (!subject) return { ok: false, error: "missing_authorization_subject" };
  if (!method) return { ok: false, error: "missing_authorization_method" };

  const store = lifecycle(deps, env);
  let current = await store.load(id);
  if (!current) return { ok: false, error: "authorization_not_found", authorization_request_id: id };

  // Re-verify the exact immutable request identity at the human-decision
  // boundary, not only later at execution. A corrupted lifecycle envelope or
  // changed broker policy can never be converted into a grant.
  const request = current.request;
  if (!request || request.authorization_request_id !== id || !isObject(request.target) || !isObject(request.target.arguments)) {
    return { ok: false, error: "authorization_request_corrupt", authorization_request_id: id };
  }
  const recomputedDigest = await argumentDigest(request.target.arguments);
  if (recomputedDigest !== current.argument_digest || request.argument_digest !== current.argument_digest) {
    return { ok: false, error: "authorization_argument_digest_mismatch", authorization_request_id: id };
  }
  if (request.tool_id !== current.tool_id || request.target.tool_id !== current.tool_id || request.required_authorization !== current.required_authorization) {
    return { ok: false, error: "authorization_request_identity_mismatch", authorization_request_id: id };
  }
  if (typeof deps.validateRegisteredMutation === "function") {
    const registry = await deps.validateRegisteredMutation(current.tool_id, current.required_authorization);
    if (!registry || registry.ok !== true) {
      return { ok: false, error: registry?.error || "authorized_tool_policy_changed", authorization_request_id: id };
    }
  }

  if (current.status === "executed" && decision === "approved") {
    return {
      ok: true,
      schema: TOOL_AUTHORIZATION_DECISION_SCHEMA,
      idempotent_replay: true,
      decision: "approved",
      authorization: current,
      execution: current.execution_result_json ? JSON.parse(current.execution_result_json) : null
    };
  }
  if (current.status === "authorized" && decision === "approved") {
    return { ok: true, schema: TOOL_AUTHORIZATION_DECISION_SCHEMA, idempotent_replay: true, decision: "approved", authorization: current };
  }
  if (current.status === "denied" && decision === "denied") {
    return { ok: true, schema: TOOL_AUTHORIZATION_DECISION_SCHEMA, idempotent_replay: true, decision: "denied", authorization: current };
  }
  if (current.status !== "pending") {
    return { ok: false, error: "authorization_not_pending", status: current.status, authorization_request_id: id };
  }

  const claim = await store.transition(id, "pending", "deciding", { decision, authorization_subject: subject, authorization_method: method });
  if (!claim.changed) {
    current = await store.load(id);
    return { ok: false, error: "authorization_decision_race_lost", status: current?.status || null, authorization_request_id: id };
  }

  const issuedAt = new Date().toISOString();
  const ttlSeconds = clampInt(body.ttl_seconds, MIN_AUTHORIZATION_TTL_SECONDS, MAX_AUTHORIZATION_TTL_SECONDS, DEFAULT_AUTHORIZATION_TTL_SECONDS);
  const expiresAt = decision === "approved" ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
  const decisionIdentity = {
    schema: TOOL_AUTHORIZATION_DECISION_SCHEMA,
    authorization_request_id: id,
    request_stone_hash: current.request_stone_hash,
    package_id: current.package_id,
    request_ir_id: current.request_ir_id,
    decision_id: current.decision_id,
    tool_id: current.tool_id,
    argument_digest: current.argument_digest,
    authorization_subject: subject,
    authorization_method: method,
    issued_at: issuedAt,
    expires_at: expiresAt,
    one_time: decision === "approved",
    decision
  };
  const authorizationId = "sha256:" + await sha256Text(stableJson(decisionIdentity));
  const evidence = await createEvidenceStone(deps, {
    title: decision === "approved" ? `Tool authorization grant: ${current.tool_id}` : `Tool authorization denial: ${current.tool_id}`,
    author: subject,
    content: stableJson({ ...decisionIdentity, authorization_id: authorizationId }),
    path: `tool-authorization-decisions/${authorizationId.replace("sha256:", "")}.json`,
    chain: TOOL_AUTHORIZATION_GRANT_CHAIN,
    metadata: {
      type: decision === "approved" ? "tool-authorization-grant" : "tool-authorization-denial",
      schema: TOOL_AUTHORIZATION_DECISION_SCHEMA,
      authorization_id: authorizationId,
      authorization_request_id: id,
      request_stone_hash: current.request_stone_hash,
      tool_id: current.tool_id,
      argument_digest: current.argument_digest,
      decision
    },
    set_as_head: false
  });
  if (!evidence.ok) {
    await store.update(id, { status: "authorization_failed", error_type: evidence.error });
    return { ok: false, error: evidence.error, authorization_request_id: id };
  }

  await linkEvidence(deps, evidence.stone_hash, current.request_stone_hash, "Human authorization decision binds to this exact immutable pending request.");
  const finalStatus = decision === "approved" ? "authorized" : "denied";
  await store.update(id, {
    status: finalStatus,
    issued_at: issuedAt,
    expires_at: expiresAt,
    grant_stone_hash: decision === "approved" ? evidence.stone_hash : null,
    denial_stone_hash: decision === "denied" ? evidence.stone_hash : null,
    error_type: null
  });
  current = await store.load(id);

  const result = {
    ok: true,
    schema: TOOL_AUTHORIZATION_DECISION_SCHEMA,
    idempotent_replay: false,
    authorization_id: authorizationId,
    authorization_request_id: id,
    decision,
    grant: decision === "approved" ? { stone_hash: evidence.stone_hash, chain: TOOL_AUTHORIZATION_GRANT_CHAIN } : null,
    denial: decision === "denied" ? { stone_hash: evidence.stone_hash, chain: TOOL_AUTHORIZATION_GRANT_CHAIN } : null,
    authorization: current,
    policy: { model_intent_is_execution_authority: false, human_confirmation_required: true, one_time: decision === "approved" }
  };

  if (decision === "approved" && body.execute === true) {
    result.execution = await executeAuthorizedToolFromBody({ authorization_request_id: id }, env, deps);
  }
  return result;
}

async function makeExecutionReceipt(deps, authorization, fields) {
  const completedAt = new Date().toISOString();
  const receiptBody = {
    schema: TOOL_AUTHORIZED_EXECUTION_RECEIPT_SCHEMA,
    authorization_request_id: authorization.authorization_request_id,
    request_stone_hash: authorization.request_stone_hash,
    authorization_grant_stone_hash: authorization.grant_stone_hash,
    package_id: authorization.package_id,
    request_ir_id: authorization.request_ir_id,
    model: authorization.model,
    turn_id: authorization.turn_id,
    decision_id: authorization.decision_id,
    tool_id: authorization.tool_id,
    argument_digest: authorization.argument_digest,
    consumption_id: authorization.consumption_id,
    started_at: fields.started_at,
    completed_at: completedAt,
    guard: fields.guard,
    downstream_result: fields.downstream_result || null,
    verification: fields.verification || null,
    executed: fields.executed === true,
    mutation_performed: fields.mutation_performed === true,
    replayed: false,
    error: fields.error || null
  };
  const executionId = "sha256:" + await sha256Text(stableJson(receiptBody));
  const evidence = await createEvidenceStone(deps, {
    title: `Authorized tool execution receipt: ${authorization.tool_id}`,
    author: "cairnstone-v7-tool-broker",
    content: stableJson({ ...receiptBody, execution_id: executionId }),
    path: `tool-authorized-executions/${executionId.replace("sha256:", "")}.json`,
    chain: TOOL_AUTHORIZED_EXECUTION_CHAIN,
    metadata: {
      type: "tool-authorized-execution-receipt",
      schema: TOOL_AUTHORIZED_EXECUTION_RECEIPT_SCHEMA,
      execution_id: executionId,
      authorization_request_id: authorization.authorization_request_id,
      request_stone_hash: authorization.request_stone_hash,
      authorization_grant_stone_hash: authorization.grant_stone_hash,
      tool_id: authorization.tool_id,
      argument_digest: authorization.argument_digest,
      executed: fields.executed === true,
      mutation_performed: fields.mutation_performed === true,
      error: fields.error || null
    },
    set_as_head: false
  });
  if (!evidence.ok) return evidence;
  await linkEvidence(deps, evidence.stone_hash, authorization.request_stone_hash, "Execution receipt references the exact immutable authorization request.");
  await linkEvidence(deps, evidence.stone_hash, authorization.grant_stone_hash, "Execution receipt references the human authorization grant consumed for this mutation.");
  return { ok: true, stone_hash: evidence.stone_hash, execution_id: executionId, body: { ...receiptBody, execution_id: executionId } };
}

export async function executeAuthorizedToolFromBody(body, env, deps = {}) {
  if (!isObject(body)) return { ok: false, error: "invalid_authorized_execution_request" };
  const forbidden = replacementField(body);
  if (forbidden) return { ok: false, error: "authorization_argument_substitution_not_accepted", field: forbidden };
  const id = typeof body.authorization_request_id === "string" ? body.authorization_request_id.trim() : "";
  if (!id) return { ok: false, error: "missing_authorization_request_id" };

  const store = lifecycle(deps, env);
  let authorization = await store.load(id);
  if (!authorization) return { ok: false, error: "authorization_not_found", authorization_request_id: id };

  if (authorization.status === "executed" && authorization.execution_result_json) {
    const existing = JSON.parse(authorization.execution_result_json);
    return { ...existing, replayed: true, idempotent_replay: true };
  }
  if (authorization.status !== "authorized") {
    return { ok: false, error: "authorization_not_executable", status: authorization.status, authorization_request_id: id };
  }
  if (!authorization.expires_at || Date.parse(authorization.expires_at) <= Date.now()) {
    await store.transition(id, "authorized", "expired", { error_type: "authorization_expired" });
    return { ok: false, error: "authorization_expired", authorization_request_id: id };
  }

  const request = authorization.request;
  if (!request || !isObject(request.target) || !isObject(request.target.arguments)) {
    await store.update(id, { status: "execution_failed", error_type: "authorization_request_corrupt" });
    return { ok: false, error: "authorization_request_corrupt", authorization_request_id: id };
  }
  const recomputedDigest = await argumentDigest(request.target.arguments);
  if (recomputedDigest !== authorization.argument_digest || request.argument_digest !== authorization.argument_digest) {
    await store.update(id, { status: "execution_failed", error_type: "authorization_argument_digest_mismatch" });
    return { ok: false, error: "authorization_argument_digest_mismatch", authorization_request_id: id };
  }

  if (typeof deps.validateRegisteredMutation === "function") {
    const registry = await deps.validateRegisteredMutation(request.target.tool_id, request.required_authorization);
    if (!registry || registry.ok !== true) {
      return { ok: false, error: registry?.error || "authorized_tool_policy_changed", authorization_request_id: id };
    }
  }

  if (authorization.required_authorization === "human_confirmation" && !request.guard) {
    return { ok: false, error: "authorization_guard_required", authorization_request_id: id };
  }

  const consumptionId = "sha256:" + await sha256Text(stableJson({ authorization_request_id: id, grant: authorization.grant_stone_hash, nonce: crypto.randomUUID() }));
  const startedAt = new Date().toISOString();
  const claimed = await store.transition(id, "authorized", "consuming", { consumption_id: consumptionId, consumed_at: startedAt });
  if (!claimed.changed) {
    authorization = await store.load(id);
    if (authorization?.status === "executed" && authorization.execution_result_json) {
      const existing = JSON.parse(authorization.execution_result_json);
      return { ...existing, replayed: true, idempotent_replay: true };
    }
    return { ok: false, error: "authorization_already_consumed_or_claimed", status: authorization?.status || null, authorization_request_id: id };
  }
  authorization = await store.load(id);

  let guardEvidence = null;
  if (request.guard) {
    if (typeof deps.observeGuard !== "function") {
      await store.update(id, { status: "execution_failed", error_type: "authorization_guard_observer_unavailable" });
      return { ok: false, error: "authorization_guard_observer_unavailable", authorization_request_id: id };
    }
    const observed = await deps.observeGuard(request.guard);
    const observedValue = observed?.ok === true
      ? (Object.prototype.hasOwnProperty.call(observed, "value") ? observed.value : null)
      : null;
    const matched = observed?.ok === true && observedValue === request.guard.expected_value;
    guardEvidence = { ...request.guard, observed_value: observedValue, matched };
    if (!matched) {
      const receipt = await makeExecutionReceipt(deps, authorization, {
        started_at: startedAt,
        guard: guardEvidence,
        executed: false,
        mutation_performed: false,
        error: "authorization_guard_mismatch"
      });
      const result = {
        ok: false,
        schema: TOOL_AUTHORIZED_EXECUTION_RECEIPT_SCHEMA,
        error: "authorization_guard_mismatch",
        authorization_request_id: id,
        tool_id: authorization.tool_id,
        argument_digest: authorization.argument_digest,
        guard: guardEvidence,
        executed: false,
        mutation_performed: false,
        replayed: false,
        receipt: receipt.ok ? { stone_hash: receipt.stone_hash, chain: TOOL_AUTHORIZED_EXECUTION_CHAIN } : null
      };
      await store.update(id, {
        status: "guard_failed",
        guard_type: request.guard.type,
        guard_expected: request.guard.expected_value,
        guard_observed: observedValue,
        guard_matched: 0,
        execution_receipt_stone_hash: receipt.ok ? receipt.stone_hash : null,
        execution_result_json: stableJson(result),
        error_type: "authorization_guard_mismatch"
      });
      return result;
    }
  }

  if (typeof deps.invokeTool !== "function") {
    await store.update(id, { status: "execution_failed", error_type: "tool_invocation_unavailable" });
    return { ok: false, error: "tool_invocation_unavailable", authorization_request_id: id };
  }

  let downstream;
  try {
    downstream = await deps.invokeTool(request.target.handler, request.target.arguments, env);
  } catch (error) {
    downstream = { ok: false, error: "tool_invocation_failed", diagnostic: String(error?.message || error).slice(0, 500) };
  }
  const mutationPerformed = downstream?.ok === true;
  let verification = null;
  if (mutationPerformed && typeof deps.verifyMutation === "function") {
    verification = await deps.verifyMutation(request.target.tool_id, request.target.arguments, downstream);
  }
  const verificationOk = mutationPerformed && (!verification || verification.ok === true);
  const finalError = !mutationPerformed
    ? (downstream?.error || "tool_invocation_failed")
    : verificationOk ? null : (verification?.error || "mutation_verification_failed");

  const receipt = await makeExecutionReceipt(deps, authorization, {
    started_at: startedAt,
    guard: guardEvidence,
    downstream_result: downstream,
    verification,
    executed: mutationPerformed,
    mutation_performed: mutationPerformed,
    error: finalError
  });
  const result = {
    ok: finalError === null,
    schema: TOOL_AUTHORIZED_EXECUTION_RECEIPT_SCHEMA,
    authorization_request_id: id,
    tool_id: authorization.tool_id,
    argument_digest: authorization.argument_digest,
    guard: guardEvidence,
    downstream_result: downstream,
    verification,
    executed: mutationPerformed,
    mutation_performed: mutationPerformed,
    replayed: false,
    idempotent_replay: false,
    error: finalError,
    receipt: receipt.ok ? { stone_hash: receipt.stone_hash, chain: TOOL_AUTHORIZED_EXECUTION_CHAIN } : null
  };
  await store.update(id, {
    status: finalError === null ? "executed" : "execution_failed",
    guard_type: request.guard?.type || null,
    guard_expected: request.guard?.expected_value ?? null,
    guard_observed: guardEvidence?.observed_value ?? null,
    guard_matched: guardEvidence ? (guardEvidence.matched ? 1 : 0) : null,
    execution_receipt_stone_hash: receipt.ok ? receipt.stone_hash : null,
    execution_result_json: stableJson(result),
    error_type: finalError
  });
  return result;
}
