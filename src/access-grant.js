// V7.7.10b — cairnstone-access-grant-v1 operational CRUD + lifecycle
//
// Give Access over a canonical object_ref. NEVER copies payload bytes.
// NEVER moves chain_heads / path_heads. NEVER mints capabilities.
// NEVER widens Scope / workspace / Code Session capability.
// accepted_state_authority always false.
//
// Permissions:
//   read            — bounded visibility only; never execute/mutate
//   discuss         — may attach into Conversation Session; still no execute/mutate
//   execute-against — recorded only; grant alone does NOT execute
//
// Lifecycle: granted → first_read → revoked (revoke = future access only)

import { stableJson } from "./agent-bootstrap.js";
import { parseObjectRef } from "./attachment-refs.js";
import { sendMessageFromBody } from "./correspondence.js";

export const ACCESS_GRANT_SCHEMA = "cairnstone-access-grant-v1";

export const ACCESS_GRANT_PERMISSIONS = Object.freeze([
  "read",
  "discuss",
  "execute-against"
]);

export const ACCESS_GRANT_STATUSES = Object.freeze([
  "granted",
  "first_read",
  "revoked"
]);

export const ACCESS_GRANT_BROKER_TOOL_IDS = Object.freeze({
  create: "cairnstone_access_grant_create",
  get: "cairnstone_access_grant_get",
  list: "cairnstone_access_grant_list",
  revoke: "cairnstone_access_grant_revoke",
  mark_first_read: "cairnstone_access_grant_mark_first_read"
});

export const ACCESS_GRANT_MUTATION_TOOL_IDS = Object.freeze([
  ACCESS_GRANT_BROKER_TOOL_IDS.create,
  ACCESS_GRANT_BROKER_TOOL_IDS.revoke,
  ACCESS_GRANT_BROKER_TOOL_IDS.mark_first_read
]);

export const ACCESS_GRANT_READ_TOOL_IDS = Object.freeze([
  ACCESS_GRANT_BROKER_TOOL_IDS.get,
  ACCESS_GRANT_BROKER_TOOL_IDS.list
]);

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const GRANT_ID_RE = /^grant:[a-z0-9][a-z0-9._-]{0,127}$/i;
const PERMISSION_SET = new Set(ACCESS_GRANT_PERMISSIONS);
const STATUS_SET = new Set(ACCESS_GRANT_STATUSES);
const MAX_LIST = 100;
const DEFAULT_LIST = 20;
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

function grantId(value, field = "grant_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!GRANT_ID_RE.test(text)) throw new Error(`Invalid grant id for ${field}`);
  return text;
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true,
    capability_minted: false,
    scope_widened: false,
    workspace_capability_widened: false,
    code_session_capability_widened: false,
    execute_implied: false,
    mutate_implied: false
  };
}

function permissionPolicy(permission) {
  return {
    permission,
    implies_execute: false,
    implies_mutate: false,
    implies_accepted_state_authority: false,
    execute_against_recorded_only: permission === "execute-against",
    note: permission === "execute-against"
      ? "execute-against is recorded only; grant alone does not execute. Pair with human-committed Task Run / V7.3 authorization."
      : `${permission} never implies execute or mutate`
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

function normalizeObjectRef(raw) {
  const parsed = parseObjectRef(raw);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    object_ref: String(parsed.canonical_ref || parsed.object_ref).slice(0, MAX_REF_LEN),
    kind: parsed.kind
  };
}

function rowToGrant(row) {
  const permission = row.permission;
  return {
    schema: ACCESS_GRANT_SCHEMA,
    grant_id: row.grant_id,
    object_ref: row.object_ref,
    principal_actor_id: row.principal_actor_id,
    permission,
    grantor_actor_id: row.grantor_actor_id,
    created_at: row.created_at,
    expires_at: row.expires_at || null,
    revoked_at: row.revoked_at || null,
    status: row.status,
    first_read_at: row.first_read_at || null,
    notify: row.notify === 1 || row.notify === true,
    notify_message_id: row.notify_message_id || null,
    notify_stone_hash: row.notify_stone_hash || null,
    permission_policy: permissionPolicy(permission),
    revoke_semantics: "future_access_only",
    ...authorityClosedFields()
  };
}

async function selectGrant(db, id) {
  return db.prepare(
    `SELECT grant_id, schema, object_ref, principal_actor_id, permission, grantor_actor_id,
            created_at, expires_at, revoked_at, status, first_read_at, notify,
            notify_message_id, notify_stone_hash, accepted_state_authority
       FROM access_grants WHERE grant_id = ?`
  ).bind(id).first();
}

function actorMayInspectGrant(grant, actorIdValue) {
  return grant.grantor_actor_id === actorIdValue
    || grant.principal_actor_id === actorIdValue;
}

function isExpired(grant, nowIso) {
  if (!grant.expires_at) return false;
  return String(grant.expires_at) <= String(nowIso);
}

export async function createAccessGrant(db, {
  grant_id,
  object_ref,
  principal_actor_id,
  permission,
  grantor_actor_id,
  expires_at = null,
  notify = false,
  now = null
} = {}) {
  let grantor;
  let principal;
  let id;
  try {
    grantor = actorId(grantor_actor_id, "grantor_actor_id");
    principal = actorId(principal_actor_id, "principal_actor_id");
    id = grant_id ? grantId(grant_id) : `grant:${crypto.randomUUID()}`;
  } catch (error) {
    return { ok: false, error: "invalid_access_grant_create", detail: String(error.message || error) };
  }

  if (!PERMISSION_SET.has(permission)) {
    return { ok: false, error: "invalid_permission", allowed: [...ACCESS_GRANT_PERMISSIONS] };
  }

  const refNorm = normalizeObjectRef(object_ref);
  if (!refNorm.ok) return refNorm;

  const createdAt = now || new Date().toISOString();
  let expiresAt = null;
  if (expires_at !== undefined && expires_at !== null && expires_at !== "") {
    if (!isNonEmptyString(expires_at)) {
      return { ok: false, error: "invalid_expires_at" };
    }
    expiresAt = String(expires_at).trim();
    if (expiresAt <= createdAt) {
      return { ok: false, error: "expires_at_must_be_future" };
    }
  }

  const notifyFlag = notify === true ? 1 : 0;

  try {
    await db.prepare(
      `INSERT INTO access_grants (
         grant_id, schema, object_ref, principal_actor_id, permission, grantor_actor_id,
         created_at, expires_at, revoked_at, status, first_read_at, notify,
         notify_message_id, notify_stone_hash, accepted_state_authority
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'granted', NULL, ?, NULL, NULL, 0)`
    ).bind(
      id,
      ACCESS_GRANT_SCHEMA,
      refNorm.object_ref,
      principal,
      permission,
      grantor,
      createdAt,
      expiresAt,
      notifyFlag
    ).run();
  } catch (error) {
    const message = String(error.message || error);
    if (/unique/i.test(message)) {
      return { ok: false, error: "access_grant_already_exists", grant_id: id };
    }
    return { ok: false, error: "access_grant_create_failed", detail: message };
  }

  const row = await selectGrant(db, id);
  return {
    ok: true,
    access_grant: rowToGrant(row),
    object_ref_kind: refNorm.kind,
    ...authorityClosedFields()
  };
}

export async function getAccessGrant(db, grant_id, actor_id) {
  let id;
  let actor;
  try {
    id = grantId(grant_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_access_grant_get", detail: String(error.message || error) };
  }
  const row = await selectGrant(db, id);
  if (!row) return { ok: false, error: "access_grant_not_found", grant_id: id };
  const grant = rowToGrant(row);
  if (!actorMayInspectGrant(grant, actor)) {
    return { ok: false, error: "access_grant_actor_forbidden", grant_id: id, ...authorityClosedFields() };
  }
  return { ok: true, access_grant: grant, ...authorityClosedFields() };
}

export async function listAccessGrants(db, {
  actor_id,
  principal_actor_id = null,
  object_ref = null,
  grantor_actor_id = null,
  status = null,
  limit = DEFAULT_LIST
} = {}) {
  let actor;
  try {
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_actor_id", detail: String(error.message || error) };
  }

  const lim = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_LIST, limit)) : DEFAULT_LIST;
  if (status && !STATUS_SET.has(status)) {
    return { ok: false, error: "invalid_status", allowed: [...ACCESS_GRANT_STATUSES] };
  }

  let objectRefFilter = null;
  if (object_ref !== undefined && object_ref !== null && object_ref !== "") {
    const refNorm = normalizeObjectRef(object_ref);
    if (!refNorm.ok) return refNorm;
    objectRefFilter = refNorm.object_ref;
  }

  let principalFilter = null;
  if (principal_actor_id) {
    try { principalFilter = actorId(principal_actor_id, "principal_actor_id"); }
    catch (error) {
      return { ok: false, error: "invalid_principal_actor_id", detail: String(error.message || error) };
    }
  }

  let grantorFilter = null;
  if (grantor_actor_id) {
    try { grantorFilter = actorId(grantor_actor_id, "grantor_actor_id"); }
    catch (error) {
      return { ok: false, error: "invalid_grantor_actor_id", detail: String(error.message || error) };
    }
  }

  // Caller may list grants where they are principal or grantor.
  const rows = await db.prepare(
    `SELECT grant_id, schema, object_ref, principal_actor_id, permission, grantor_actor_id,
            created_at, expires_at, revoked_at, status, first_read_at, notify,
            notify_message_id, notify_stone_hash, accepted_state_authority
       FROM access_grants
      WHERE (principal_actor_id = ? OR grantor_actor_id = ?)
        AND (? IS NULL OR principal_actor_id = ?)
        AND (? IS NULL OR grantor_actor_id = ?)
        AND (? IS NULL OR object_ref = ?)
        AND (? IS NULL OR status = ?)
      ORDER BY created_at DESC
      LIMIT ?`
  ).bind(
    actor,
    actor,
    principalFilter,
    principalFilter,
    grantorFilter,
    grantorFilter,
    objectRefFilter,
    objectRefFilter,
    status,
    status,
    lim
  ).all();

  const grants = (rows?.results || []).map(rowToGrant);
  return {
    ok: true,
    schema: ACCESS_GRANT_SCHEMA,
    total: grants.length,
    grants,
    ...authorityClosedFields()
  };
}

export async function revokeAccessGrant(db, {
  grant_id,
  actor_id,
  now = null
} = {}) {
  let id;
  let actor;
  try {
    id = grantId(grant_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_access_grant_revoke", detail: String(error.message || error) };
  }

  const row = await selectGrant(db, id);
  if (!row) return { ok: false, error: "access_grant_not_found", grant_id: id };
  const grant = rowToGrant(row);

  // Only grantor may revoke (operator control). Principal cannot self-revoke via this path.
  if (grant.grantor_actor_id !== actor) {
    return { ok: false, error: "access_grant_revoke_forbidden", grant_id: id, ...authorityClosedFields() };
  }

  if (grant.status === "revoked") {
    return {
      ok: true,
      already_revoked: true,
      access_grant: grant,
      revoke_semantics: "future_access_only",
      ...authorityClosedFields()
    };
  }

  const revokedAt = now || new Date().toISOString();
  await db.prepare(
    `UPDATE access_grants
        SET status = 'revoked', revoked_at = ?
      WHERE grant_id = ? AND status != 'revoked'`
  ).bind(revokedAt, id).run();

  const updated = rowToGrant(await selectGrant(db, id));
  return {
    ok: true,
    access_grant: updated,
    revoke_semantics: "future_access_only",
    note: "Revocation blocks future access only; it does not erase data already read.",
    ...authorityClosedFields()
  };
}

export async function markAccessGrantFirstRead(db, {
  grant_id,
  actor_id,
  now = null
} = {}) {
  let id;
  let actor;
  try {
    id = grantId(grant_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_access_grant_mark_first_read", detail: String(error.message || error) };
  }

  const row = await selectGrant(db, id);
  if (!row) return { ok: false, error: "access_grant_not_found", grant_id: id };
  const grant = rowToGrant(row);

  if (grant.principal_actor_id !== actor) {
    return { ok: false, error: "access_grant_first_read_forbidden", grant_id: id, ...authorityClosedFields() };
  }
  if (grant.status === "revoked") {
    return { ok: false, error: "access_grant_revoked", grant_id: id, ...authorityClosedFields() };
  }

  const nowIso = now || new Date().toISOString();
  if (isExpired(grant, nowIso)) {
    return { ok: false, error: "access_grant_expired", grant_id: id, expires_at: grant.expires_at, ...authorityClosedFields() };
  }

  if (grant.status === "first_read") {
    return {
      ok: true,
      already_first_read: true,
      access_grant: grant,
      ...authorityClosedFields()
    };
  }

  await db.prepare(
    `UPDATE access_grants
        SET status = 'first_read', first_read_at = ?
      WHERE grant_id = ? AND status = 'granted'`
  ).bind(nowIso, id).run();

  const updated = rowToGrant(await selectGrant(db, id));
  return {
    ok: true,
    access_grant: updated,
    ...authorityClosedFields()
  };
}

async function maybeNotifyGrant(env, deps, grant) {
  if (!grant.notify) return { notified: false, skipped: true, reason: "notify_false" };
  if (typeof deps?.createStone !== "function" && typeof deps?.sendMessage !== "function") {
    return { notified: false, skipped: true, reason: "notify_transport_unavailable" };
  }

  const content = stableJson({
    schema: "cairnstone-access-grant-notify-v1",
    grant_id: grant.grant_id,
    object_ref: grant.object_ref,
    permission: grant.permission,
    grantor_actor_id: grant.grantor_actor_id,
    principal_actor_id: grant.principal_actor_id,
    note: "You were granted access to a canonical object_ref. This is visibility only; it does not grant execute/mutate/accepted-state authority.",
    accepted_state_authority: false,
    grants_no_capability: true
  });

  const messageId = `msg:access-grant-notify-${grant.grant_id.slice(6)}`;
  const send = deps.sendMessage
    || ((body) => sendMessageFromBody(body, env, { createStone: deps.createStone }));

  const sent = await send({
    from: grant.grantor_actor_id,
    to: [grant.principal_actor_id],
    content,
    message_id: messageId,
    intent: "message",
    priority: "normal",
    subject: `Access grant: ${grant.object_ref}`,
    labels: ["informational"]
  });

  if (!sent?.ok) {
    return { notified: false, skipped: false, error: sent?.error || "notify_failed", detail: sent };
  }

  await env.CAIRNSTONE_DB.prepare(
    `UPDATE access_grants
        SET notify_message_id = ?, notify_stone_hash = ?
      WHERE grant_id = ?`
  ).bind(sent.message_id, sent.stone_hash || null, grant.grant_id).run();

  return {
    notified: true,
    message_id: sent.message_id,
    stone_hash: sent.stone_hash || null,
    idempotent_replay: Boolean(sent.idempotent_replay)
  };
}

export async function createAccessGrantFromBody(body = {}, env = {}, deps = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;

  const grantor = requireActorField(body, "grantor_actor_id");
  if (!grantor.ok) {
    // Alias: actor_id as grantor when grantor_actor_id omitted
    const alias = requireActorField(body, "actor_id");
    if (!alias.ok) return grantor;
    body = { ...body, grantor_actor_id: alias.value };
  }

  const created = await createAccessGrant(bindings.db, {
    grant_id: body.grant_id,
    object_ref: body.object_ref,
    principal_actor_id: body.principal_actor_id,
    permission: body.permission,
    grantor_actor_id: body.grantor_actor_id || body.actor_id,
    expires_at: body.expires_at,
    notify: body.notify === true
  });
  if (!created.ok) return { ...created, ...authorityClosedFields() };

  let notify_result = { notified: false, skipped: true, reason: "notify_false" };
  if (body.notify === true) {
    notify_result = await maybeNotifyGrant(env, deps, created.access_grant);
    if (notify_result.notified) {
      const refreshed = await selectGrant(bindings.db, created.access_grant.grant_id);
      created.access_grant = rowToGrant(refreshed);
    }
  }

  return {
    ...created,
    notify_result,
    ...authorityClosedFields()
  };
}

export async function getAccessGrantFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;
  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.grant_id)) return { ok: false, error: "grant_id_required" };
  return getAccessGrant(bindings.db, body.grant_id, actor.value);
}

export async function listAccessGrantsFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;
  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  return listAccessGrants(bindings.db, {
    actor_id: actor.value,
    principal_actor_id: body.principal_actor_id || null,
    object_ref: body.object_ref || null,
    grantor_actor_id: body.grantor_actor_id || null,
    status: body.status || null,
    limit: body.limit
  });
}

export async function revokeAccessGrantFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;
  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.grant_id)) return { ok: false, error: "grant_id_required" };
  return revokeAccessGrant(bindings.db, {
    grant_id: body.grant_id,
    actor_id: actor.value
  });
}

export async function markAccessGrantFirstReadFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;
  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.grant_id)) return { ok: false, error: "grant_id_required" };
  return markAccessGrantFirstRead(bindings.db, {
    grant_id: body.grant_id,
    actor_id: actor.value
  });
}

export const ACCESS_GRANT_CREATE_TOOL_DEFINITION = Object.freeze({
  name: ACCESS_GRANT_BROKER_TOOL_IDS.create,
  description: "V7.7.10b: create cairnstone-access-grant-v1 over a canonical object_ref (Give Access). Does not copy payloads; read/discuss never imply execute/mutate; execute-against is recorded only. Optional notify sends AC1. Never moves HEADs; never mints capabilities.",
  inputSchema: {
    type: "object",
    required: ["object_ref", "principal_actor_id", "permission"],
    properties: {
      grant_id: { type: "string", description: "grant:…" },
      object_ref: { type: "string", description: "typed canonical ref" },
      principal_actor_id: { type: "string" },
      permission: { type: "string", enum: [...ACCESS_GRANT_PERMISSIONS] },
      grantor_actor_id: { type: "string" },
      actor_id: { type: "string", description: "alias for grantor_actor_id" },
      expires_at: { type: "string" },
      notify: { type: "boolean" }
    },
    additionalProperties: false
  }
});

export const ACCESS_GRANT_GET_TOOL_DEFINITION = Object.freeze({
  name: ACCESS_GRANT_BROKER_TOOL_IDS.get,
  description: "V7.7.10b: get one access grant by grant_id. Visible to grantor or principal. Never accepted-state authority.",
  inputSchema: {
    type: "object",
    required: ["grant_id", "actor_id"],
    properties: {
      grant_id: { type: "string" },
      actor_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const ACCESS_GRANT_LIST_TOOL_DEFINITION = Object.freeze({
  name: ACCESS_GRANT_BROKER_TOOL_IDS.list,
  description: "V7.7.10b: list access grants visible to actor (as principal or grantor). Filter by principal_actor_id, object_ref, grantor_actor_id, status.",
  inputSchema: {
    type: "object",
    required: ["actor_id"],
    properties: {
      actor_id: { type: "string" },
      principal_actor_id: { type: "string" },
      object_ref: { type: "string" },
      grantor_actor_id: { type: "string" },
      status: { type: "string", enum: [...ACCESS_GRANT_STATUSES] },
      limit: { type: "number", minimum: 1, maximum: MAX_LIST }
    },
    additionalProperties: false
  }
});

export const ACCESS_GRANT_REVOKE_TOOL_DEFINITION = Object.freeze({
  name: ACCESS_GRANT_BROKER_TOOL_IDS.revoke,
  description: "V7.7.10b: revoke an access grant (grantor only). Blocks future access only; does not erase data already read. Never moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["grant_id", "actor_id"],
    properties: {
      grant_id: { type: "string" },
      actor_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const ACCESS_GRANT_MARK_FIRST_READ_TOOL_DEFINITION = Object.freeze({
  name: ACCESS_GRANT_BROKER_TOOL_IDS.mark_first_read,
  description: "V7.7.10b: principal marks first_read on a grant (audit / read receipt). Does not grant additional capability.",
  inputSchema: {
    type: "object",
    required: ["grant_id", "actor_id"],
    properties: {
      grant_id: { type: "string" },
      actor_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const ACCESS_GRANT_MCP_TOOL_DEFINITIONS = Object.freeze([
  ACCESS_GRANT_CREATE_TOOL_DEFINITION,
  ACCESS_GRANT_GET_TOOL_DEFINITION,
  ACCESS_GRANT_LIST_TOOL_DEFINITION,
  ACCESS_GRANT_REVOKE_TOOL_DEFINITION,
  ACCESS_GRANT_MARK_FIRST_READ_TOOL_DEFINITION
]);
