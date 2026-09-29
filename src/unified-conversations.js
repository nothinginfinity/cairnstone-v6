// V7.7.10j — authenticated operator aggregate for Unified Conversations / TurnSync.
//
// Read-only operational projection. The caller NEVER supplies the authority
// boundary: account/tenant/connection identity comes from CORE_AUTH_CONTEXT
// and active Core-auth connection principals. Optional actor/provider filters
// can only narrow that server-derived set.
//
// This module never mutates chain_heads/path_heads, never grants capability,
// and never promotes conversation history into accepted project memory.

import { authDb } from "./core-auth.js";
import { listConversationSessions } from "./conversation-session.js";
import { listTaskRuns } from "./task-run.js";
import { listEventsFromTaskRuns } from "./event-plane.js";

export const UNIFIED_CONVERSATIONS_SCHEMA = "cairnstone-unified-conversations-v1";
export const UNIFIED_CONVERSATIONS_TOOL_ID = "cairnstone_unified_conversations";

const MAX_IDENTITIES = 64;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const CONVERSATION_STATUSES = new Set(["active", "paused", "closed", "superseded"]);
const TASK_STATUSES = new Set(["proposed", "queued", "running", "completed", "failed", "cancelled"]);

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_capability: false,
    project_memory_promoted: false
  };
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function normalizeStringList(value, maxItems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("expected_array");
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length > maxItems) throw new Error("too_many_items");
  }
  return out;
}

function safeAliases(raw) {
  if (!raw) return { aliases: [], malformed: false };
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return { aliases: [], malformed: true };
    const aliases = [];
    const seen = new Set();
    for (const value of parsed) {
      const actor = String(value || "").trim();
      if (!ACTOR_ID_RE.test(actor) || seen.has(actor)) continue;
      seen.add(actor);
      aliases.push(actor);
    }
    return { aliases, malformed: false };
  } catch {
    return { aliases: [], malformed: true };
  }
}

function visibleVia(identity) {
  return {
    actor_id: identity.actor_id,
    client_families: [...identity.client_families].sort(),
    connection_ids: [...identity.connection_ids].sort(),
    identity_kinds: [...identity.identity_kinds].sort()
  };
}

function mergeVisibility(existing, next) {
  const byActor = new Map((existing || []).map(item => [item.actor_id, {
    actor_id: item.actor_id,
    client_families: new Set(item.client_families || []),
    connection_ids: new Set(item.connection_ids || []),
    identity_kinds: new Set(item.identity_kinds || [])
  }]));
  const prior = byActor.get(next.actor_id) || {
    actor_id: next.actor_id,
    client_families: new Set(),
    connection_ids: new Set(),
    identity_kinds: new Set()
  };
  for (const value of next.client_families || []) prior.client_families.add(value);
  for (const value of next.connection_ids || []) prior.connection_ids.add(value);
  for (const value of next.identity_kinds || []) prior.identity_kinds.add(value);
  byActor.set(next.actor_id, prior);
  return [...byActor.values()].map(item => ({
    actor_id: item.actor_id,
    client_families: [...item.client_families].sort(),
    connection_ids: [...item.connection_ids].sort(),
    identity_kinds: [...item.identity_kinds].sort()
  })).sort((a, b) => a.actor_id.localeCompare(b.actor_id));
}

function recordTime(record, fields) {
  for (const field of fields) {
    const value = record?.[field];
    if (value) return String(value);
  }
  return "";
}

function newestFirst(fields) {
  return (a, b) => recordTime(b, fields).localeCompare(recordTime(a, fields));
}

export function compileOwnedIdentityScope(authContext, rows = []) {
  const accountId = String(authContext?.account_id || "").trim();
  const tenantId = String(authContext?.tenant_id || "").trim();
  const currentPrincipal = String(authContext?.principal_id || "").trim();
  const currentConnection = String(authContext?.connection_id || "").trim();
  if (!accountId || !tenantId || !currentPrincipal || !currentConnection) {
    return { ok: false, error: "authenticated_account_context_required", ...authorityClosedFields() };
  }

  const active = (rows || []).filter(row =>
    row?.status === "active"
    && String(row.account_id || "") === accountId
    && String(row.tenant_id || "") === tenantId
  );
  if (!active.some(row => String(row.principal_id || "") === currentPrincipal
      && String(row.connection_id || "") === currentConnection)) {
    return { ok: false, error: "authenticated_connection_not_active", ...authorityClosedFields() };
  }

  const identityMap = new Map();
  const connections = [];
  const warnings = [];
  const addIdentity = (actor, row, kind) => {
    if (!ACTOR_ID_RE.test(actor)) return;
    let identity = identityMap.get(actor);
    if (!identity) {
      identity = {
        actor_id: actor,
        client_families: new Set(),
        connection_ids: new Set(),
        identity_kinds: new Set()
      };
      identityMap.set(actor, identity);
    }
    identity.client_families.add(String(row.client_family || "unknown"));
    identity.connection_ids.add(String(row.connection_id));
    identity.identity_kinds.add(kind);
  };

  for (const row of active) {
    const principalId = String(row.principal_id || "").trim();
    const parsed = safeAliases(row.routing_aliases_json);
    if (parsed.malformed) {
      warnings.push({ connection_id: String(row.connection_id || ""), warning: "malformed_routing_aliases_json" });
    }
    if (ACTOR_ID_RE.test(principalId)) addIdentity(principalId, row, "connection_principal");
    else warnings.push({ connection_id: String(row.connection_id || ""), warning: "invalid_principal_actor_id" });
    for (const alias of parsed.aliases) addIdentity(alias, row, "routing_alias");
    connections.push({
      connection_id: String(row.connection_id || ""),
      principal_id: principalId || null,
      client_family: String(row.client_family || "unknown"),
      routing_aliases: parsed.aliases,
      created_at: row.created_at || null
    });
  }

  const identities = [...identityMap.values()]
    .slice(0, MAX_IDENTITIES)
    .sort((a, b) => a.actor_id.localeCompare(b.actor_id));

  return {
    ok: true,
    account_id: accountId,
    tenant_id: tenantId,
    current_principal_id: currentPrincipal,
    current_connection_id: currentConnection,
    connections,
    identities,
    warnings,
    truncated_identities: identityMap.size > MAX_IDENTITIES,
    ...authorityClosedFields()
  };
}

export async function resolveOwnedIdentityScope(env = {}) {
  const authContext = env?.CORE_AUTH_CONTEXT;
  if (!authContext) return { ok: false, error: "authenticated_account_context_required", ...authorityClosedFields() };
  const binding = authDb(env);
  if (!binding.ok) return { ok: false, error: binding.error || "missing_auth_d1_binding", ...authorityClosedFields() };
  const result = await binding.db.prepare(
    `SELECT connection_id, principal_id, account_id, tenant_id, status,
            client_family, routing_aliases_json, created_at
       FROM auth_connection_principals
      WHERE realm = 'core-auth' AND account_id = ? AND tenant_id = ? AND status = 'active'
      ORDER BY created_at ASC, connection_id ASC`
  ).bind(authContext.account_id, authContext.tenant_id).all();
  return compileOwnedIdentityScope(authContext, result?.results || []);
}

function filterOwnedIdentities(scope, body) {
  let actorIds;
  let clientFamilies;
  try {
    actorIds = normalizeStringList(body.actor_ids, MAX_IDENTITIES);
    clientFamilies = normalizeStringList(body.client_families, 32);
  } catch (error) {
    return { ok: false, error: "invalid_identity_filter", detail: String(error.message || error) };
  }
  const actorSet = actorIds.length ? new Set(actorIds) : null;
  const familySet = clientFamilies.length ? new Set(clientFamilies) : null;
  const identities = scope.identities.filter(identity => {
    if (actorSet && !actorSet.has(identity.actor_id)) return false;
    if (familySet && ![...identity.client_families].some(value => familySet.has(value))) return false;
    return true;
  });
  return {
    ok: true,
    identities,
    requested_actor_ids: actorIds,
    requested_client_families: clientFamilies,
    filters_are_narrow_only: true
  };
}

function mergeRecord(map, key, record, identity) {
  if (!key) return;
  const provenance = visibleVia(identity);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { ...record, visible_via: [provenance] });
    return;
  }
  existing.visible_via = mergeVisibility(existing.visible_via, provenance);
}

function mergeThread(map, thread, identity) {
  const id = String(thread?.thread_id || "").trim();
  if (!id) return;
  const provenance = visibleVia(identity);
  const existing = map.get(id);
  const view = { actor_id: identity.actor_id, summary: thread };
  if (!existing) {
    map.set(id, {
      thread_id: id,
      latest_at: thread.latest_at || null,
      summary: thread,
      visible_via: [provenance],
      recipient_views: [view]
    });
    return;
  }
  existing.visible_via = mergeVisibility(existing.visible_via, provenance);
  existing.recipient_views.push(view);
  if (String(thread.latest_at || "") > String(existing.latest_at || "")) {
    existing.latest_at = thread.latest_at || null;
    existing.summary = thread;
  }
}

export async function unifiedConversationsFromBody(body = {}, env = {}, deps = {}) {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_d1_binding", detail: "CAIRNSTONE_DB required", ...authorityClosedFields() };

  const resolveScope = deps.resolveOwnedIdentityScope || resolveOwnedIdentityScope;
  const scope = await resolveScope(env);
  if (!scope?.ok) return scope;

  const filtered = filterOwnedIdentities(scope, body || {});
  if (!filtered.ok) return { ...filtered, ...authorityClosedFields() };

  const conversationStatus = body.conversation_status == null ? null : String(body.conversation_status);
  const taskStatus = body.task_status == null ? null : String(body.task_status);
  if (conversationStatus && !CONVERSATION_STATUSES.has(conversationStatus)) {
    return { ok: false, error: "invalid_conversation_status", ...authorityClosedFields() };
  }
  if (taskStatus && !TASK_STATUSES.has(taskStatus)) {
    return { ok: false, error: "invalid_task_status", ...authorityClosedFields() };
  }

  const limit = clampLimit(body.limit);
  const listSessions = deps.listConversationSessions || listConversationSessions;
  const listRuns = deps.listTaskRuns || listTaskRuns;
  const listThreads = deps.listThreads;
  if (typeof listThreads !== "function") {
    return { ok: false, error: "unified_conversation_threads_dependency_required", ...authorityClosedFields() };
  }

  const sessionMap = new Map();
  const taskMap = new Map();
  const threadMap = new Map();
  const readErrors = [];

  for (const identity of filtered.identities) {
    const actor = identity.actor_id;
    try {
      const listed = await listSessions(env.CAIRNSTONE_DB, {
        actor_id: actor,
        status: conversationStatus,
        limit
      });
      if (listed?.ok) {
        for (const session of listed.sessions || []) mergeRecord(sessionMap, session.conversation_id, session, identity);
      } else {
        readErrors.push({ actor_id: actor, source: "conversation_sessions", error: listed?.error || "read_failed" });
      }
    } catch (error) {
      readErrors.push({ actor_id: actor, source: "conversation_sessions", error: String(error?.message || error) });
    }

    try {
      const listed = await listRuns(env.CAIRNSTONE_DB, {
        actor_id: actor,
        status: taskStatus,
        limit
      });
      if (listed?.ok) {
        for (const taskRun of listed.task_runs || []) mergeRecord(taskMap, taskRun.task_run_id, taskRun, identity);
      } else {
        readErrors.push({ actor_id: actor, source: "task_runs", error: listed?.error || "read_failed" });
      }
    } catch (error) {
      readErrors.push({ actor_id: actor, source: "task_runs", error: String(error?.message || error) });
    }

    try {
      const listed = await listThreads({ recipient_id: actor, limit }, env);
      if (listed?.ok) {
        for (const thread of listed.threads || []) mergeThread(threadMap, thread, identity);
      } else {
        readErrors.push({ actor_id: actor, source: "mailbox_threads", error: listed?.error || "read_failed" });
      }
    } catch (error) {
      readErrors.push({ actor_id: actor, source: "mailbox_threads", error: String(error?.message || error) });
    }
  }

  const sessions = [...sessionMap.values()]
    .sort(newestFirst(["updated_at", "created_at"]))
    .slice(0, limit);
  const taskRuns = [...taskMap.values()]
    .sort(newestFirst(["updated_at", "completed_at", "started_at", "created_at"]))
    .slice(0, limit);
  const threads = [...threadMap.values()]
    .sort(newestFirst(["latest_at"]))
    .slice(0, limit);

  const eventProjection = listEventsFromTaskRuns(taskRuns, { limit });
  const events = (eventProjection.events || []).map(event => ({
    ...event,
    visible_via: taskMap.get(event.task_run_id)?.visible_via || []
  }));

  return {
    ok: true,
    schema: UNIFIED_CONVERSATIONS_SCHEMA,
    generated_at: new Date().toISOString(),
    identity_scope: {
      source: "CORE_AUTH_CONTEXT + active auth_connection_principals",
      account_id: scope.account_id,
      tenant_id: scope.tenant_id,
      current_principal_id: scope.current_principal_id,
      current_connection_id: scope.current_connection_id,
      connections: scope.connections,
      identities: filtered.identities.map(visibleVia),
      requested_actor_ids: filtered.requested_actor_ids,
      requested_client_families: filtered.requested_client_families,
      filters_are_narrow_only: true,
      truncated_identities: scope.truncated_identities === true
    },
    counts: {
      connections: scope.connections.length,
      identities: filtered.identities.length,
      conversations: sessions.length,
      mailbox_threads: threads.length,
      task_runs: taskRuns.length,
      events: events.length
    },
    conversations: sessions,
    mailbox_threads: threads,
    task_runs: taskRuns,
    events,
    partial: readErrors.length > 0,
    read_errors: readErrors,
    warnings: scope.warnings || [],
    policy: {
      authority_boundary: "server_derived_authenticated_account",
      actor_provider_filters: "narrow_only",
      arbitrary_actor_read: false,
      execution_authority: false,
      mutation_authority: false,
      accepted_state_authority: false,
      project_memory_promotion: false
    },
    ...authorityClosedFields()
  };
}

export const UNIFIED_CONVERSATIONS_MCP_TOOL_DEFINITION = Object.freeze({
  name: UNIFIED_CONVERSATIONS_TOOL_ID,
  description: "V7.7.10j: authenticated account-scoped Unified Conversations operator read model over Conversation Sessions, AC1 mailbox threads, Task Runs, and event projections. Identity scope is derived server-side from CORE_AUTH_CONTEXT + active account connections; actor/provider filters only narrow. Never moves HEADs, grants capabilities, executes work, or promotes history to project memory.",
  inputSchema: {
    type: "object",
    properties: {
      actor_ids: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_IDENTITIES,
        description: "Optional exact actor-id narrowing filter. Cannot widen beyond server-owned active identities."
      },
      client_families: {
        type: "array",
        items: { type: "string" },
        maxItems: 32,
        description: "Optional provider/client-family narrowing filter. Cannot widen account scope."
      },
      conversation_status: { type: "string", enum: [...CONVERSATION_STATUSES] },
      task_status: { type: "string", enum: [...TASK_STATUSES] },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT }
    },
    additionalProperties: false
  }
});
