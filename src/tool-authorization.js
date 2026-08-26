// V7.3.3 — human-confirmed guarded mutation lifecycle.
//
// Core invariant: model intent is not execution authority. A pending V7.3.2
// request becomes executable only after a separately trusted human decision,
// and execution reloads the exact immutable request instead of accepting new
// mutation arguments.

import { sha256Text, stableJson } from "./agent-bootstrap.js";
import { DEFAULT_TOOL_BROKER_REGISTRY, validateBrokerArguments } from "./model-router.js";

export const TOOL_AUTHORIZATION_GRANT_SCHEMA = "cairnstone-tool-authorization-grant-v1";
export const TOOL_AUTHORIZED_EXECUTION_SCHEMA = "cairnstone-tool-authorized-execution-v1";
export const TOOL_AUTHORIZATION_CHAIN = "cairnstone-v7-tool-authorizations";
export const TOOL_MUTATION_RECEIPT_CHAIN = "cairnstone-v7-tool-mutation-receipts";
export const V733_ACCEPTANCE_TOOL_ID = "cairnstone_v733_acceptance_mutation";
export const V733_ACCEPTANCE_HANDLER = "v733_acceptance_mutation";

const AUTH_REQUEST_SCHEMA = "cairnstone-tool-authorization-request-v1";
const AUTH_ID_RE = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_TTL_SECONDS = 900;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const EXECUTION_SUBSTITUTION_FIELDS = Object.freeze([
  "tool_id", "arguments", "context_package", "tool_intent", "approved",
  "confirmed", "execute", "execute_now", "mutation_authority", "execution_authority"
]);

function nowIso(deps) {
  return typeof deps?.now === "function" ? deps.now() : new Date().toISOString();
}

function dbChanges(result) {
  return Number(result?.meta?.changes ?? result?.meta?.rows_written ?? 0);
}

function clampTtl(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TTL_SECONDS;
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.trunc(n)));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectSubstitution(body) {
  for (const key of EXECUTION_SUBSTITUTION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body || {}, key)) return key;
  }
  return null;
}

function requiredText(value, name, max = 300) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing_${name}`);
  const text = value.trim();
  if (text.length > max) throw new Error(`invalid_${name}`);
  return text;
}

export async function canonicalArgumentsDigest(args) {
  return "sha256:" + await sha256Text(stableJson(isPlainObject(args) ? args : {}));
}

export function validateAuthorizationRequestAgainstRegistry(request, registry = DEFAULT_TOOL_BROKER_REGISTRY) {
  if (!request || typeof request !== "object") return { ok: false, error: "authorization_request_invalid", detail: "not_an_object" };
  if (request.schema !== AUTH_REQUEST_SCHEMA) return { ok: false, error: "authorization_request_invalid", detail: "wrong_schema" };
  const toolId = request.tool_id || request.target?.tool_id;
  const args = request.target?.arguments ?? request.arguments ?? {};
  const entry = (Array.isArray(registry) ? registry : []).find(item => item?.tool_id === toolId) || null;
  if (!entry) return { ok: false, error: "authorization_policy_changed", detail: "tool_not_registered" };
  if (entry.available !== true || entry.risk_class !== "mutation") return { ok: false, error: "authorization_policy_changed", detail: "tool_not_mutation_available" };
  if (entry.authorization !== request.required_authorization) {
    return { ok: false, error: "authorization_policy_changed", detail: "authorization_class_changed", observed: entry.authorization };
  }
  const argsValidation = validateBrokerArguments(entry.input_schema, args);
  if (!argsValidation.ok) return { ok: false, error: "authorization_policy_changed", detail: "arguments_no_longer_valid", validation: argsValidation };
  return { ok: true, entry, args };
}

export function createD1AuthorizationStore(env) {
  const db = env?.CAIRNSTONE_DB;
  if (!db) throw new Error("missing_cairnstone_db");
  return {
    async get(id) {
      return await db.prepare("SELECT * FROM tool_authorizations WHERE authorization_request_id = ?").bind(id).first();
    },
    async list(status = "pending", limit = 50) {
      const result = await db.prepare("SELECT * FROM tool_authorizations WHERE status = ? ORDER BY created_at DESC LIMIT ?").bind(status, limit).all();
      return result?.results || [];
    },
    async recordPending(record) {
      const at = record.created_at;
      const result = await db.prepare(
        "INSERT OR IGNORE INTO tool_authorizations (authorization_request_id,request_stone_hash,package_id,request_ir_id,decision_id,tool_id,arguments_digest,required_authorization,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        record.authorization_request_id, record.request_stone_hash, record.package_id,
        record.request_ir_id, record.decision_id, record.tool_id, record.arguments_digest,
        record.required_authorization, "pending", at, at
      ).run();
      const row = await this.get(record.authorization_request_id);
      return { inserted: dbChanges(result) === 1, row };
    },
    async beginDecision(id, decision, subject, method, issuedAt, expiresAt) {
      const result = await db.prepare(
        "UPDATE tool_authorizations SET status='authorizing',authorization_decision=?,authorization_subject=?,authorization_method=?,issued_at=?,expires_at=?,updated_at=? WHERE authorization_request_id=? AND status='pending'"
      ).bind(decision, subject, method, issuedAt, expiresAt, issuedAt, id).run();
      return { claimed: dbChanges(result) === 1, row: await this.get(id) };
    },
    async finishDecision(id, decision, stoneHash, at) {
      const status = decision === "approved" ? "authorized" : "denied";
      const result = await db.prepare(
        "UPDATE tool_authorizations SET status=?,authorization_stone_hash=?,updated_at=? WHERE authorization_request_id=? AND status='authorizing' AND authorization_decision=?"
      ).bind(status, stoneHash, at, id, decision).run();
      return { changed: dbChanges(result) === 1, row: await this.get(id) };
    },
    async rollbackDecision(id, at) {
      await db.prepare(
        "UPDATE tool_authorizations SET status='pending',authorization_decision=NULL,authorization_subject=NULL,authorization_method=NULL,issued_at=NULL,expires_at=NULL,updated_at=? WHERE authorization_request_id=? AND status='authorizing'"
      ).bind(at, id).run();
      return await this.get(id);
    },
    async markExpired(id, at) {
      await db.prepare("UPDATE tool_authorizations SET status='expired',updated_at=? WHERE authorization_request_id=? AND status='authorized'").bind(at, id).run();
      return await this.get(id);
    },
    async claim(id, claimId, at) {
      const result = await db.prepare(
        "UPDATE tool_authorizations SET status='consuming',claim_id=?,claimed_at=?,updated_at=? WHERE authorization_request_id=? AND status='authorized' AND (expires_at IS NULL OR expires_at > ?)"
      ).bind(claimId, at, at, id, at).run();
      return { claimed: dbChanges(result) === 1, row: await this.get(id) };
    },
    async finishExecution(id, claimId, status, fields, at) {
      const result = await db.prepare(
        "UPDATE tool_authorizations SET status=?,execution_id=?,execution_receipt_stone_hash=?,result_json=?,failure_code=?,updated_at=? WHERE authorization_request_id=? AND status='consuming' AND claim_id=?"
      ).bind(
        status, fields.execution_id || null, fields.execution_receipt_stone_hash || null,
        fields.result_json || null, fields.failure_code || null, at, id, claimId
      ).run();
      return { changed: dbChanges(result) === 1, row: await this.get(id) };
    }
  };
}

export async function loadAuthorizationRequestStone(env, stoneHash) {
  if (!env?.CAIRNSTONE_DB || !env?.CAIRNSTONE_RAW) return { ok: false, error: "authorization_request_storage_unavailable" };
  const row = await env.CAIRNSTONE_DB.prepare("SELECT hash,raw_key FROM stones WHERE hash = ?").bind(stoneHash).first();
  if (!row?.raw_key) return { ok: false, error: "authorization_request_stone_not_found", stone_hash: stoneHash };
  const object = await env.CAIRNSTONE_RAW.get(row.raw_key);
  if (!object) return { ok: false, error: "authorization_request_raw_missing", stone_hash: stoneHash };
  const text = await object.text();
  try {
    return { ok: true, request: JSON.parse(text), raw_text: text };
  } catch {
    return { ok: false, error: "authorization_request_raw_invalid_json", stone_hash: stoneHash };
  }
}

async function verifyLifecycleBinding(row, request, registry) {
  if (!row || !request) return { ok: false, error: "authorization_request_not_found" };
  if (request.authorization_request_id !== row.authorization_request_id) return { ok: false, error: "authorization_identity_mismatch", detail: "request_id" };
  if (request.package_id !== row.package_id) return { ok: false, error: "authorization_identity_mismatch", detail: "package_id" };
  if (request.decision_id !== row.decision_id) return { ok: false, error: "authorization_identity_mismatch", detail: "decision_id" };
  if ((request.tool_id || request.target?.tool_id) !== row.tool_id) return { ok: false, error: "authorization_identity_mismatch", detail: "tool_id" };
  const digest = await canonicalArgumentsDigest(request.target?.arguments ?? request.arguments ?? {});
  if (digest !== row.arguments_digest) return { ok: false, error: "authorization_identity_mismatch", detail: "arguments_digest", observed: digest };
  const policy = validateAuthorizationRequestAgainstRegistry(request, registry);
  if (!policy.ok) return policy;
  return { ok: true, digest, entry: policy.entry, args: policy.args };
}

export async function recordPendingAuthorizationFromRequest(payload, env, deps = {}) {
  const request = payload?.authorization_request;
  const stoneHash = payload?.request_stone_hash;
  if (!request || typeof stoneHash !== "string") return { ok: false, error: "invalid_pending_authorization_record" };
  const store = deps.store || createD1AuthorizationStore(env);
  const digest = await canonicalArgumentsDigest(request.target?.arguments ?? request.arguments ?? {});
  const createdAt = nowIso(deps);
  const stored = await store.recordPending({
    authorization_request_id: request.authorization_request_id,
    request_stone_hash: stoneHash,
    package_id: request.package_id,
    request_ir_id: request.request_ir_id || null,
    decision_id: request.decision_id,
    tool_id: request.tool_id || request.target?.tool_id,
    arguments_digest: digest,
    required_authorization: request.required_authorization,
    created_at: createdAt
  });
  return {
    ok: true,
    inserted: stored.inserted,
    idempotent_replay: !stored.inserted,
    authorization_request_id: request.authorization_request_id,
    request_stone_hash: stored.row?.request_stone_hash || stoneHash,
    arguments_digest: stored.row?.arguments_digest || digest,
    status: stored.row?.status || "pending"
  };
}

export async function findRecordedAuthorizationRequest(authorizationRequestId, env, deps = {}) {
  const store = deps.store || createD1AuthorizationStore(env);
  const row = await store.get(authorizationRequestId);
  return row ? { ok: true, exists: true, row } : { ok: true, exists: false, row: null };
}

export async function listToolAuthorizationsFromBody(body, env, deps = {}) {
  const status = typeof body?.status === "string" ? body.status : "pending";
  const allowed = new Set(["pending", "authorized", "denied", "expired", "consuming", "executed", "guard_failed", "execution_failed"]);
  if (!allowed.has(status)) return { ok: false, error: "invalid_authorization_status" };
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(body?.limit || 50))));
  const store = deps.store || createD1AuthorizationStore(env);
  const loader = deps.loadRequest || (hash => loadAuthorizationRequestStone(env, hash));
  const rows = await store.list(status, limit);
  const items = [];
  for (const row of rows) {
    const loaded = await loader(row.request_stone_hash);
    const request = loaded?.ok ? loaded.request : null;
    items.push({
      authorization_request_id: row.authorization_request_id,
      request_stone_hash: row.request_stone_hash,
      status: row.status,
      package_id: row.package_id,
      request_ir_id: row.request_ir_id,
      decision_id: row.decision_id,
      tool_id: row.tool_id,
      arguments_digest: row.arguments_digest,
      required_authorization: row.required_authorization,
      target: request?.target || null,
      model: request?.model || null,
      turn_id: request?.turn_id || null,
      justification: request?.justification || null,
      guard: guardSummary(request),
      authorization_subject: row.authorization_subject || null,
      authorization_method: row.authorization_method || null,
      expires_at: row.expires_at || null,
      authorization_stone_hash: row.authorization_stone_hash || null,
      execution_receipt_stone_hash: row.execution_receipt_stone_hash || null,
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  }
  return { ok: true, schema: "cairnstone-tool-authorization-list-v1", status, total: items.length, items };
}

function guardSummary(request) {
  const toolId = request?.tool_id || request?.target?.tool_id;
  const args = request?.target?.arguments || {};
  if (toolId === V733_ACCEPTANCE_TOOL_ID) {
    return { type: "d1_acceptance_resource_version", resource_id: args.resource_id || null, expected: Number(args.expected_version) };
  }
  return { type: "tool_specific", expected: null };
}

export async function authorizeToolRequestFromBody(body, env, deps = {}) {
  try {
    if (!deps.trustedCaller?.trusted) return { ok: false, error: "trusted_human_confirmation_required" };
    const substitution = rejectSubstitution(body);
    if (substitution) return { ok: false, error: "authorization_argument_substitution_not_accepted", field: substitution };
    const id = requiredText(body?.authorization_request_id, "authorization_request_id", 100);
    if (!AUTH_ID_RE.test(id)) return { ok: false, error: "invalid_authorization_request_id" };
    const decision = body?.decision;
    if (!new Set(["approved", "denied"]).has(decision)) return { ok: false, error: "invalid_authorization_decision" };
    const subject = requiredText(body?.authorization_subject, "authorization_subject", 240);
    const method = requiredText(deps.trustedCaller.method || "cairnstone-console", "authorization_method", 120);
    const store = deps.store || createD1AuthorizationStore(env);
    const loader = deps.loadRequest || (hash => loadAuthorizationRequestStone(env, hash));
    let row = await store.get(id);
    if (!row) return { ok: false, error: "authorization_request_not_found" };

    if (["authorized", "denied"].includes(row.status)) {
      const expected = row.status === "authorized" ? "approved" : "denied";
      if (expected !== decision) return { ok: false, error: "authorization_already_decided", status: row.status };
      return {
        ok: true, schema: TOOL_AUTHORIZATION_GRANT_SCHEMA, idempotent_replay: true,
        authorization_request_id: id, decision, status: row.status,
        authorization_stone_hash: row.authorization_stone_hash,
        expires_at: row.expires_at
      };
    }
    if (row.status !== "pending") return { ok: false, error: "authorization_not_pending", status: row.status };

    const loaded = await loader(row.request_stone_hash);
    if (!loaded?.ok) return loaded;
    const verified = await verifyLifecycleBinding(row, loaded.request, deps.registry || DEFAULT_TOOL_BROKER_REGISTRY);
    if (!verified.ok) return verified;
    if (row.required_authorization !== "human_confirmation") {
      return { ok: false, error: "trusted_human_confirmation_not_applicable", required_authorization: row.required_authorization };
    }

    const issuedAt = nowIso(deps);
    const ttlSeconds = clampTtl(body?.ttl_seconds);
    const expiresAt = decision === "approved" ? new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString() : null;
    const begun = await store.beginDecision(id, decision, subject, method, issuedAt, expiresAt);
    if (!begun.claimed) return { ok: false, error: "authorization_decision_race_lost", status: begun.row?.status || null };

    const authorizationIdentity = {
      schema: TOOL_AUTHORIZATION_GRANT_SCHEMA,
      authorization_request_id: id,
      request_stone_hash: row.request_stone_hash,
      package_id: row.package_id,
      request_ir_id: row.request_ir_id,
      decision_id: row.decision_id,
      tool_id: row.tool_id,
      arguments_digest: row.arguments_digest,
      authorization_subject: subject,
      authorization_method: method,
      authorization_channel: deps.trustedCaller.channel || "console",
      authorization_evidence: deps.trustedCaller.evidence || null,
      issued_at: issuedAt,
      expires_at: expiresAt,
      one_time_use: decision === "approved",
      decision
    };
    const authorizationId = "sha256:" + await sha256Text(stableJson(authorizationIdentity));
    const content = stableJson({ ...authorizationIdentity, authorization_id: authorizationId });

    let created;
    try {
      created = await deps.createStone?.({
        title: `${decision === "approved" ? "Authorization grant" : "Authorization denial"}: ${row.tool_id}`,
        author: subject,
        content,
        path: `tool-authorizations/${authorizationId.replace("sha256:", "")}.json`,
        chain: TOOL_AUTHORIZATION_CHAIN,
        related: [row.request_stone_hash],
        metadata: {
          type: decision === "approved" ? "tool-authorization-grant" : "tool-authorization-denial",
          schema: TOOL_AUTHORIZATION_GRANT_SCHEMA,
          authorization_id: authorizationId,
          authorization_request_id: id,
          request_stone_hash: row.request_stone_hash,
          tool_id: row.tool_id,
          arguments_digest: row.arguments_digest,
          decision,
          expires_at: expiresAt,
          one_time_use: decision === "approved"
        },
        set_as_head: false
      });
    } catch (error) {
      await store.rollbackDecision(id, nowIso(deps));
      return { ok: false, error: "authorization_evidence_persist_failed", detail: String(error?.message || error) };
    }
    if (!created?.ok || !created?.stone_hash) {
      await store.rollbackDecision(id, nowIso(deps));
      return { ok: false, error: "authorization_evidence_persist_failed" };
    }

    if (typeof deps.linkStones === "function") {
      const linked = await deps.linkStones({ from_hash: created.stone_hash, to_hash: row.request_stone_hash, edge_type: "references", note: "V7.3.3 human authorization decision for exact immutable request" });
      if (!linked?.ok) {
        await store.rollbackDecision(id, nowIso(deps));
        return { ok: false, error: "authorization_graph_link_failed", authorization_stone_hash: created.stone_hash };
      }
    }

    const finished = await store.finishDecision(id, decision, created.stone_hash, nowIso(deps));
    if (!finished.changed) return { ok: false, error: "authorization_lifecycle_finalize_failed", authorization_stone_hash: created.stone_hash };

    return {
      ok: true,
      schema: TOOL_AUTHORIZATION_GRANT_SCHEMA,
      idempotent_replay: false,
      authorization_id: authorizationId,
      authorization_request_id: id,
      request_stone_hash: row.request_stone_hash,
      authorization_stone_hash: created.stone_hash,
      decision,
      status: decision === "approved" ? "authorized" : "denied",
      tool_id: row.tool_id,
      arguments_digest: row.arguments_digest,
      issued_at: issuedAt,
      expires_at: expiresAt,
      one_time_use: decision === "approved",
      execution_authority_from_model: false,
      mutation_authority_from_model: false
    };
  } catch (error) {
    return { ok: false, error: "invalid_tool_authorization_decision", detail: String(error?.message || error) };
  }
}

async function inspectGuard(entry, args, env, deps) {
  if (typeof deps.inspectGuard === "function") return await deps.inspectGuard(entry, args, env);
  if (entry.handler === V733_ACCEPTANCE_HANDLER) {
    const row = await env.CAIRNSTONE_DB.prepare("SELECT resource_id,value,version,updated_at FROM v733_acceptance_resources WHERE resource_id = ?").bind(args.resource_id).first();
    const observed = row ? Number(row.version) : 0;
    const expected = Number(args.expected_version);
    return {
      ok: true,
      type: "d1_acceptance_resource_version",
      resource_id: args.resource_id,
      expected,
      observed,
      matched: Number.isInteger(expected) && expected >= 0 && observed === expected,
      before: row || { resource_id: args.resource_id, value: null, version: 0, updated_at: null }
    };
  }
  return { ok: false, error: "authorization_guard_unimplemented", tool_id: entry.tool_id };
}

async function invokeAuthorizedMutation(entry, args, env, deps) {
  if (typeof deps.invokeAuthorizedMutation === "function") return await deps.invokeAuthorizedMutation(entry, args, env);
  if (entry.handler === V733_ACCEPTANCE_HANDLER) {
    const at = new Date().toISOString();
    if (Number(args.expected_version) === 0) {
      const insert = await env.CAIRNSTONE_DB.prepare(
        "INSERT OR IGNORE INTO v733_acceptance_resources (resource_id,value,version,updated_at) VALUES (?,?,1,?)"
      ).bind(args.resource_id, args.next_value, at).run();
      if (dbChanges(insert) === 1) return { ok: true, resource_id: args.resource_id, version: 1, value: args.next_value };
    }
    const update = await env.CAIRNSTONE_DB.prepare(
      "UPDATE v733_acceptance_resources SET value=?,version=version+1,updated_at=? WHERE resource_id=? AND version=?"
    ).bind(args.next_value, at, args.resource_id, Number(args.expected_version)).run();
    if (dbChanges(update) !== 1) return { ok: false, error: "authorization_guard_mismatch_during_mutation" };
    const row = await env.CAIRNSTONE_DB.prepare("SELECT resource_id,value,version,updated_at FROM v733_acceptance_resources WHERE resource_id=?").bind(args.resource_id).first();
    return { ok: true, ...row };
  }
  return { ok: false, error: "authorized_mutation_handler_unimplemented", tool_id: entry.tool_id };
}

async function verifyMutation(entry, args, mutationResult, env, deps) {
  if (typeof deps.verifyMutation === "function") return await deps.verifyMutation(entry, args, mutationResult, env);
  if (entry.handler === V733_ACCEPTANCE_HANDLER) {
    const row = await env.CAIRNSTONE_DB.prepare("SELECT resource_id,value,version,updated_at FROM v733_acceptance_resources WHERE resource_id=?").bind(args.resource_id).first();
    const expectedVersion = Number(args.expected_version) + 1;
    const passed = Boolean(row && row.value === args.next_value && Number(row.version) === expectedVersion);
    return { ok: true, passed, type: "independent_d1_readback", expected: { value: args.next_value, version: expectedVersion }, observed: row || null };
  }
  return { ok: true, passed: false, type: "verification_unimplemented" };
}

async function persistExecutionReceipt(row, request, grantHash, claimId, guard, mutationResult, verification, status, startedAt, completedAt, deps) {
  const executed = status === "executed";
  const payload = {
    schema: TOOL_AUTHORIZED_EXECUTION_SCHEMA,
    authorization_request_id: row.authorization_request_id,
    request_stone_hash: row.request_stone_hash,
    authorization_stone_hash: grantHash,
    package_id: row.package_id,
    request_ir_id: row.request_ir_id,
    model: request.model || null,
    turn_id: request.turn_id || null,
    decision_id: row.decision_id,
    tool_id: row.tool_id,
    arguments_digest: row.arguments_digest,
    guard,
    authorization_claim_id: claimId,
    started_at: startedAt,
    completed_at: completedAt,
    mutation_result: mutationResult || null,
    verification: verification || null,
    status,
    executed,
    mutation_performed: executed,
    replayed: false
  };
  const executionId = "sha256:" + await sha256Text(stableJson(payload));
  const created = await deps.createStone?.({
    title: `Guarded mutation receipt: ${row.tool_id} — ${status}`,
    author: "cairnstone-v7-tool-broker",
    content: stableJson({ ...payload, execution_id: executionId }),
    path: `tool-mutation-receipts/${executionId.replace("sha256:", "")}.json`,
    chain: TOOL_MUTATION_RECEIPT_CHAIN,
    related: [row.request_stone_hash, grantHash].filter(Boolean),
    metadata: {
      type: "guarded-mutation-receipt",
      schema: TOOL_AUTHORIZED_EXECUTION_SCHEMA,
      execution_id: executionId,
      authorization_request_id: row.authorization_request_id,
      request_stone_hash: row.request_stone_hash,
      authorization_stone_hash: grantHash,
      tool_id: row.tool_id,
      arguments_digest: row.arguments_digest,
      guard_matched: guard?.matched === true,
      verification_passed: verification?.passed === true,
      status,
      executed,
      mutation_performed: executed
    },
    set_as_head: false
  });
  if (!created?.ok || !created?.stone_hash) return { ok: false, error: "execution_receipt_persist_failed", execution_id: executionId };
  if (typeof deps.linkStones === "function") {
    const links = [
      { to: row.request_stone_hash, note: "Receipt references immutable authorization request" },
      ...(grantHash ? [{ to: grantHash, note: "Receipt references immutable human authorization decision" }] : [])
    ];
    for (const link of links) {
      const linked = await deps.linkStones({ from_hash: created.stone_hash, to_hash: link.to, edge_type: "references", note: link.note });
      if (!linked?.ok) return { ok: false, error: "execution_receipt_graph_link_failed", execution_id: executionId, stone_hash: created.stone_hash };
    }
  }
  return { ok: true, execution_id: executionId, stone_hash: created.stone_hash, payload };
}

function replayPayload(row) {
  if (typeof row?.result_json === "string" && row.result_json) {
    try {
      const parsed = JSON.parse(row.result_json);
      return { ...parsed, replayed: true, idempotent_replay: true, mutation_performed: false };
    } catch {}
  }
  return {
    ok: true, schema: TOOL_AUTHORIZED_EXECUTION_SCHEMA,
    authorization_request_id: row?.authorization_request_id || null,
    status: row?.status || "executed",
    execution_id: row?.execution_id || null,
    receipt: row?.execution_receipt_stone_hash ? { stone_hash: row.execution_receipt_stone_hash, chain: TOOL_MUTATION_RECEIPT_CHAIN } : null,
    executed: true, mutation_performed: false, replayed: true, idempotent_replay: true
  };
}

export async function executeAuthorizedToolFromBody(body, env, deps = {}) {
  try {
    const substitution = rejectSubstitution(body);
    if (substitution) return { ok: false, error: "authorized_execution_argument_substitution_not_accepted", field: substitution };
    const id = requiredText(body?.authorization_request_id, "authorization_request_id", 100);
    if (!AUTH_ID_RE.test(id)) return { ok: false, error: "invalid_authorization_request_id" };
    const store = deps.store || createD1AuthorizationStore(env);
    const loader = deps.loadRequest || (hash => loadAuthorizationRequestStone(env, hash));
    let row = await store.get(id);
    if (!row) return { ok: false, error: "authorization_request_not_found" };
    if (row.status === "executed") return replayPayload(row);
    if (row.status === "denied") return { ok: false, error: "authorization_denied", authorization_request_id: id };
    if (["guard_failed", "execution_failed", "expired"].includes(row.status)) return { ok: false, error: `authorization_${row.status}`, authorization_request_id: id, receipt: row.execution_receipt_stone_hash ? { stone_hash: row.execution_receipt_stone_hash } : null };
    if (row.status === "consuming") return { ok: false, error: "authorization_already_consuming", authorization_request_id: id };
    if (row.status !== "authorized") return { ok: false, error: "authorization_not_approved", status: row.status };

    const at = nowIso(deps);
    if (row.expires_at && row.expires_at <= at) {
      row = await store.markExpired(id, at);
      return { ok: false, error: "authorization_expired", authorization_request_id: id, expires_at: row?.expires_at || null };
    }
    if (!row.authorization_stone_hash) return { ok: false, error: "authorization_grant_evidence_missing" };

    const loaded = await loader(row.request_stone_hash);
    if (!loaded?.ok) return loaded;
    const verified = await verifyLifecycleBinding(row, loaded.request, deps.registry || DEFAULT_TOOL_BROKER_REGISTRY);
    if (!verified.ok) return verified;

    const claimId = "sha256:" + await sha256Text(stableJson({ authorization_request_id: id, nonce: crypto.randomUUID(), claimed_at: at }));
    const claim = await store.claim(id, claimId, at);
    if (!claim.claimed) {
      if (claim.row?.status === "executed") return replayPayload(claim.row);
      return { ok: false, error: claim.row?.status === "consuming" ? "authorization_already_consuming" : "authorization_claim_failed", status: claim.row?.status || null };
    }
    row = claim.row;
    const startedAt = at;

    const guard = await inspectGuard(verified.entry, verified.args, env, deps);
    if (!guard?.ok || guard.matched !== true) {
      const completedAt = nowIso(deps);
      const normalizedGuard = guard?.ok ? guard : { type: guard?.type || "unknown", expected: guard?.expected ?? null, observed: guard?.observed ?? null, matched: false, error: guard?.error || "authorization_guard_check_failed" };
      const receipt = await persistExecutionReceipt(row, loaded.request, row.authorization_stone_hash, claimId, normalizedGuard, null, { ok: true, passed: false, type: "not_run" }, "guard_failed", startedAt, completedAt, deps);
      const result = {
        ok: false, error: "authorization_guard_mismatch", schema: TOOL_AUTHORIZED_EXECUTION_SCHEMA,
        authorization_request_id: id, execution_id: receipt.execution_id || null,
        receipt: receipt.ok ? { stone_hash: receipt.stone_hash, chain: TOOL_MUTATION_RECEIPT_CHAIN } : null,
        guard: normalizedGuard, executed: false, mutation_performed: false, replayed: false
      };
      await store.finishExecution(id, claimId, "guard_failed", {
        execution_id: receipt.execution_id || null,
        execution_receipt_stone_hash: receipt.stone_hash || null,
        result_json: stableJson(result),
        failure_code: "authorization_guard_mismatch"
      }, completedAt);
      return result;
    }

    const mutation = await invokeAuthorizedMutation(verified.entry, verified.args, env, deps);
    if (!mutation?.ok) {
      const completedAt = nowIso(deps);
      const verification = { ok: true, passed: false, type: "not_run" };
      const receipt = await persistExecutionReceipt(row, loaded.request, row.authorization_stone_hash, claimId, guard, mutation || null, verification, "execution_failed", startedAt, completedAt, deps);
      const result = {
        ok: false, error: mutation?.error || "authorized_mutation_failed", schema: TOOL_AUTHORIZED_EXECUTION_SCHEMA,
        authorization_request_id: id, execution_id: receipt.execution_id || null,
        receipt: receipt.ok ? { stone_hash: receipt.stone_hash, chain: TOOL_MUTATION_RECEIPT_CHAIN } : null,
        guard, executed: false, mutation_performed: false, replayed: false
      };
      await store.finishExecution(id, claimId, "execution_failed", {
        execution_id: receipt.execution_id || null,
        execution_receipt_stone_hash: receipt.stone_hash || null,
        result_json: stableJson(result), failure_code: result.error
      }, completedAt);
      return result;
    }

    const verification = await verifyMutation(verified.entry, verified.args, mutation, env, deps);
    const completedAt = nowIso(deps);
    if (!verification?.ok || verification.passed !== true) {
      const receipt = await persistExecutionReceipt(row, loaded.request, row.authorization_stone_hash, claimId, guard, mutation, verification, "execution_failed", startedAt, completedAt, deps);
      const result = {
        ok: false, error: "post_mutation_verification_failed", schema: TOOL_AUTHORIZED_EXECUTION_SCHEMA,
        authorization_request_id: id, execution_id: receipt.execution_id || null,
        receipt: receipt.ok ? { stone_hash: receipt.stone_hash, chain: TOOL_MUTATION_RECEIPT_CHAIN } : null,
        guard, verification, executed: true, mutation_performed: true, replayed: false
      };
      await store.finishExecution(id, claimId, "execution_failed", {
        execution_id: receipt.execution_id || null,
        execution_receipt_stone_hash: receipt.stone_hash || null,
        result_json: stableJson(result), failure_code: "post_mutation_verification_failed"
      }, completedAt);
      return result;
    }

    const receipt = await persistExecutionReceipt(row, loaded.request, row.authorization_stone_hash, claimId, guard, mutation, verification, "executed", startedAt, completedAt, deps);
    if (!receipt.ok) {
      const result = {
        ok: false, error: receipt.error, schema: TOOL_AUTHORIZED_EXECUTION_SCHEMA,
        authorization_request_id: id, execution_id: receipt.execution_id || null,
        executed: true, mutation_performed: true, replayed: false, guard, verification
      };
      await store.finishExecution(id, claimId, "execution_failed", { execution_id: receipt.execution_id || null, result_json: stableJson(result), failure_code: receipt.error }, completedAt);
      return result;
    }

    const result = {
      ok: true,
      schema: TOOL_AUTHORIZED_EXECUTION_SCHEMA,
      authorization_request_id: id,
      request_stone_hash: row.request_stone_hash,
      authorization_stone_hash: row.authorization_stone_hash,
      execution_id: receipt.execution_id,
      receipt: { stone_hash: receipt.stone_hash, chain: TOOL_MUTATION_RECEIPT_CHAIN },
      package_id: row.package_id,
      request_ir_id: row.request_ir_id,
      decision_id: row.decision_id,
      tool_id: row.tool_id,
      arguments_digest: row.arguments_digest,
      guard,
      mutation_result: mutation,
      verification,
      executed: true,
      mutation_performed: true,
      replayed: false,
      idempotent_replay: false,
      policy: { model_intent_is_execution_authority: false, model_mutation_authority: false, human_authorization_consumed: true }
    };
    await store.finishExecution(id, claimId, "executed", {
      execution_id: receipt.execution_id,
      execution_receipt_stone_hash: receipt.stone_hash,
      result_json: stableJson(result), failure_code: null
    }, completedAt);
    return result;
  } catch (error) {
    return { ok: false, error: "invalid_authorized_execution_request", detail: String(error?.message || error) };
  }
}

export const TOOL_EXECUTE_AUTHORIZED_TOOL_DEFINITION = {
  name: "cairnstone_tool_execute_authorized",
  description: "V7.3.3: atomically consume one separately human-authorized mutation request exactly once. Accepts only authorization_request_id — never replacement tool arguments — reloads the immutable request, revalidates broker policy and the reviewed concurrency guard, executes the exact registered mutation, verifies it independently, and writes an immutable graph-linked receipt. Replay returns the existing receipt/result without performing another mutation.",
  inputSchema: {
    type: "object",
    required: ["authorization_request_id"],
    properties: { authorization_request_id: { type: "string" } },
    additionalProperties: false
  }
};
