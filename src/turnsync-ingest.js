// V7.7.10j — authenticated, replay-safe TurnSync end-of-turn append bridge.
//
// This is the provider/host end-of-turn ingestion boundary. New appends are
// gated by authenticated account-owned standing policy derived from the target
// Conversation Session (workspace -> chain -> account -> safe default ASK).
// Stable exact replays are non-mutating and may return without re-authorizing
// an upload that already happened.

import { authDb } from "./core-auth.js";
import {
  appendConversationTurn,
  getConversationSession
} from "./conversation-session.js";
import {
  evaluateTurnSyncStandingPolicy,
  getEffectiveTurnSyncPolicy
} from "./turnsync-policy.js";

export const TURNSYNC_APPEND_SCHEMA = "cairnstone-turnsync-append-v1";
export const TURNSYNC_APPEND_TOOL_ID = "cairnstone_turnsync_append";

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const ROLE_SET = new Set(["user", "assistant", "system", "tool", "operational"]);

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_capability: false,
    project_memory_promoted: false
  };
}

function parseAliases(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(value => String(value || "").trim()).filter(value => ACTOR_ID_RE.test(value)))];
  } catch {
    return [];
  }
}

export function selectTurnSyncActor(authContext, connectionRow, requestedActorId = null) {
  const principal = String(authContext?.principal_id || "").trim();
  const connectionId = String(authContext?.connection_id || "").trim();
  const accountId = String(authContext?.account_id || "").trim();
  const tenantId = String(authContext?.tenant_id || "").trim();
  if (!principal || !connectionId || !accountId || !tenantId) {
    return { ok: false, error: "authenticated_account_context_required", ...authorityClosedFields() };
  }
  if (!connectionRow || connectionRow.status !== "active"
      || String(connectionRow.connection_id || "") !== connectionId
      || String(connectionRow.account_id || "") !== accountId
      || String(connectionRow.tenant_id || "") !== tenantId
      || String(connectionRow.principal_id || "") !== principal) {
    return { ok: false, error: "authenticated_connection_not_active", ...authorityClosedFields() };
  }

  const aliases = parseAliases(connectionRow.routing_aliases_json);
  const allowed = [...new Set([principal, ...aliases].filter(value => ACTOR_ID_RE.test(value)))];
  const requested = requestedActorId == null ? "" : String(requestedActorId).trim();
  if (requested) {
    if (!ACTOR_ID_RE.test(requested) || !allowed.includes(requested)) {
      return {
        ok: false,
        error: "turnsync_actor_not_owned_by_connection",
        requested_actor_id: requested || null,
        allowed_actor_ids: allowed,
        ...authorityClosedFields()
      };
    }
    return { ok: true, actor_id: requested, allowed_actor_ids: allowed, aliases, ...authorityClosedFields() };
  }

  if (aliases.length === 1) {
    return { ok: true, actor_id: aliases[0], allowed_actor_ids: allowed, aliases, ...authorityClosedFields() };
  }
  if (aliases.length === 0 && ACTOR_ID_RE.test(principal)) {
    return { ok: true, actor_id: principal, allowed_actor_ids: allowed, aliases, ...authorityClosedFields() };
  }
  return {
    ok: false,
    error: "turnsync_actor_id_required_for_connection",
    allowed_actor_ids: allowed,
    detail: "Connection has multiple usable actor identities; choose one exact actor_id.",
    ...authorityClosedFields()
  };
}

export async function resolveTurnSyncActor(env = {}, requestedActorId = null) {
  const authContext = env?.CORE_AUTH_CONTEXT;
  if (!authContext) return { ok: false, error: "authenticated_account_context_required", ...authorityClosedFields() };
  const binding = authDb(env);
  if (!binding.ok) return { ok: false, error: binding.error || "missing_auth_d1_binding", ...authorityClosedFields() };
  const row = await binding.db.prepare(
    `SELECT connection_id, principal_id, account_id, tenant_id, status, client_family,
            routing_aliases_json, created_at
       FROM auth_connection_principals
      WHERE realm = 'core-auth' AND connection_id = ? AND account_id = ? AND tenant_id = ?
      LIMIT 1`
  ).bind(authContext.connection_id, authContext.account_id, authContext.tenant_id).first();
  const selected = selectTurnSyncActor(authContext, row, requestedActorId);
  if (!selected.ok) return selected;
  return {
    ...selected,
    client_family: String(row?.client_family || "unknown"),
    connection_id: String(row?.connection_id || authContext.connection_id),
    principal_id: String(row?.principal_id || authContext.principal_id)
  };
}

export function turnSyncScopeFromSession(session = {}) {
  const workspaceId = String(session?.workspace_id || "").trim() || null;
  const chain = String(session?.selected_chain || "").trim() || null;
  return { workspace_id: workspaceId, chain };
}

async function findTurnIdentity(db, turnId, messageId) {
  const result = await db.prepare(
    `SELECT turn_id, conversation_id, message_id, actor_id, role, turn_type, created_at
       FROM conversation_turns
      WHERE turn_id = ? OR message_id = ?
      ORDER BY created_at ASC
      LIMIT 2`
  ).bind(turnId, messageId).all();
  return result?.results || [];
}

function classifyExisting(rows, expected, session) {
  if (!rows.length) return { state: "missing" };
  if (rows.length !== 1) {
    return {
      state: "conflict",
      error: "turnsync_turn_identity_conflict",
      detail: "turn_id and message_id resolve to different durable turns"
    };
  }
  const row = rows[0];
  const exactIdentity = String(row.turn_id || "") === expected.turn_id
    && String(row.message_id || "") === expected.message_id
    && String(row.conversation_id || "") === expected.conversation_id
    && String(row.actor_id || "") === expected.actor_id
    && String(row.role || "") === expected.role;
  if (!exactIdentity) {
    return {
      state: "conflict",
      error: "turnsync_turn_identity_conflict",
      existing: {
        turn_id: row.turn_id || null,
        message_id: row.message_id || null,
        conversation_id: row.conversation_id || null,
        actor_id: row.actor_id || null,
        role: row.role || null
      }
    };
  }
  const projected = Array.isArray(session?.message_log)
    && session.message_log.some(item => item?.turn_id === expected.turn_id && item?.message_id === expected.message_id);
  if (!projected) {
    return {
      state: "projection_incomplete",
      error: "turnsync_turn_projection_incomplete",
      detail: "Durable turn exists but Conversation Session message_log does not include it; fail closed instead of reporting a replay success.",
      existing: {
        turn_id: row.turn_id,
        message_id: row.message_id,
        conversation_id: row.conversation_id,
        actor_id: row.actor_id,
        role: row.role
      }
    };
  }
  return {
    state: "replay",
    existing: {
      turn_id: row.turn_id,
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      actor_id: row.actor_id,
      role: row.role,
      created_at: row.created_at || null
    }
  };
}

async function replayOrConflict(db, expected) {
  const session = await getConversationSession(db, expected.conversation_id);
  const rows = await findTurnIdentity(db, expected.turn_id, expected.message_id);
  const classified = classifyExisting(rows, expected, session);
  if (classified.state === "missing") return null;
  if (classified.state === "replay") {
    return {
      ok: true,
      schema: TURNSYNC_APPEND_SCHEMA,
      replayed: true,
      turn: classified.existing,
      conversation_session: session,
      sync_policy_evaluated: false,
      ...authorityClosedFields()
    };
  }
  return {
    ok: false,
    schema: TURNSYNC_APPEND_SCHEMA,
    replayed: false,
    error: classified.error,
    detail: classified.detail,
    existing: classified.existing || null,
    sync_policy_evaluated: false,
    ...authorityClosedFields()
  };
}

export async function turnSyncAppendFromBody(body = {}, env = {}, deps = {}) {
  if (!env?.CAIRNSTONE_DB) {
    return { ok: false, error: "missing_d1_binding", detail: "CAIRNSTONE_DB required", ...authorityClosedFields() };
  }
  if (!ROLE_SET.has(body.role)) {
    return { ok: false, error: "invalid_turn_role", allowed: [...ROLE_SET], ...authorityClosedFields() };
  }

  const resolveActor = deps.resolveTurnSyncActor || resolveTurnSyncActor;
  const selected = await resolveActor(env, body.actor_id || null);
  if (!selected?.ok) return selected;

  const expected = {
    conversation_id: String(body.conversation_id || "").trim(),
    turn_id: String(body.turn_id || "").trim(),
    message_id: String(body.message_id || "").trim(),
    actor_id: selected.actor_id,
    role: body.role
  };
  if (!expected.conversation_id || !expected.turn_id || !expected.message_id) {
    return { ok: false, error: "turnsync_turn_identity_required", ...authorityClosedFields() };
  }

  const db = env.CAIRNSTONE_DB;
  const getSession = deps.getConversationSession || getConversationSession;
  const appendTurn = deps.appendConversationTurn || appendConversationTurn;
  const getPolicy = deps.getEffectiveTurnSyncPolicy || getEffectiveTurnSyncPolicy;
  const existingFirst = deps.replayOrConflict
    ? await deps.replayOrConflict(db, expected)
    : await replayOrConflict(db, expected);
  if (existingFirst) return existingFirst;

  let session = await getSession(db, expected.conversation_id);
  if (!session) {
    return { ok: false, error: "conversation_session_not_found", conversation_id: expected.conversation_id, ...authorityClosedFields() };
  }

  const syncScope = turnSyncScopeFromSession(session);
  const policyResolved = await getPolicy(env, syncScope);
  if (!policyResolved?.ok) {
    return {
      ...policyResolved,
      schema: TURNSYNC_APPEND_SCHEMA,
      sync_policy_evaluated: true,
      sync_scope: syncScope,
      ...authorityClosedFields()
    };
  }
  const policyGate = evaluateTurnSyncStandingPolicy(policyResolved.effective);
  const oneTimeConfirmed = policyGate.requires_human_confirmation === true
    && body.sync_confirmed === true
    && policyResolved.effective?.payload_mode === "full_turns";
  const syncPolicy = {
    mode: policyResolved.effective?.mode || null,
    payload_mode: policyResolved.effective?.payload_mode || null,
    scope_kind: policyResolved.effective?.scope_kind || null,
    scope_key: policyResolved.effective?.scope_key || null,
    revision: Number(policyResolved.effective?.revision || 0),
    defaulted: policyResolved.defaulted === true,
    one_time_confirmation: oneTimeConfirmed
  };
  if (!policyGate.allow_append && !oneTimeConfirmed) {
    return {
      ok: false,
      schema: TURNSYNC_APPEND_SCHEMA,
      error: policyGate.error || "turnsync_policy_denied",
      requires_human_confirmation: policyGate.requires_human_confirmation === true,
      sync_policy_evaluated: true,
      sync_scope: syncScope,
      sync_policy: syncPolicy,
      ...authorityClosedFields()
    };
  }

  const appendArgs = {
    ...body,
    actor_id: selected.actor_id
  };
  delete appendArgs.base_revision;
  delete appendArgs.sync_confirmed;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await appendTurn(db, {
      ...appendArgs,
      base_revision: session.session_revision
    });
    if (result?.ok) {
      return {
        ...result,
        schema: TURNSYNC_APPEND_SCHEMA,
        replayed: false,
        retry_count: attempt,
        connection: {
          connection_id: selected.connection_id || null,
          client_family: selected.client_family || null,
          actor_id: selected.actor_id
        },
        sync_policy_evaluated: true,
        sync_scope: syncScope,
        sync_policy: syncPolicy,
        sync_confirmation_recorded: oneTimeConfirmed,
        ...authorityClosedFields()
      };
    }

    if (result?.error === "conversation_turn_already_exists" || result?.error === "conversation_session_conflict") {
      const replay = deps.replayOrConflict
        ? await deps.replayOrConflict(db, expected)
        : await replayOrConflict(db, expected);
      if (replay) {
        return {
          ...replay,
          sync_policy_evaluated: true,
          sync_scope: syncScope,
          sync_policy: syncPolicy,
          sync_confirmation_recorded: oneTimeConfirmed
        };
      }
      if (result.error === "conversation_session_conflict" && attempt === 0) {
        session = await getSession(db, expected.conversation_id);
        if (!session) return result;
        continue;
      }
    }
    return {
      ...result,
      schema: TURNSYNC_APPEND_SCHEMA,
      replayed: false,
      sync_policy_evaluated: true,
      sync_scope: syncScope,
      sync_policy: syncPolicy,
      sync_confirmation_recorded: oneTimeConfirmed
    };
  }

  return {
    ok: false,
    schema: TURNSYNC_APPEND_SCHEMA,
    error: "conversation_session_conflict",
    replayed: false,
    sync_policy_evaluated: true,
    sync_scope: syncScope,
    sync_policy: syncPolicy,
    sync_confirmation_recorded: oneTimeConfirmed,
    ...authorityClosedFields()
  };
}

export const TURNSYNC_APPEND_MCP_TOOL_DEFINITION = Object.freeze({
  name: TURNSYNC_APPEND_TOOL_ID,
  description: "V7.7.10j: authenticated, retry-safe TurnSync end-of-turn append bridge. Actor identity is constrained to the current Core-auth connection; new appends enforce workspace/chain/account standing policy with safe default ASK; duplicate stable turn/message identity replays safely. Never promotes conversation history to accepted project memory.",
  inputSchema: {
    type: "object",
    required: ["conversation_id", "turn_id", "message_id", "role"],
    properties: {
      conversation_id: { type: "string" },
      actor_id: { type: "string", description: "Optional exact actor identity owned by the authenticated connection. Required when that connection has multiple routing aliases." },
      turn_id: { type: "string" },
      message_id: { type: "string" },
      role: { type: "string", enum: [...ROLE_SET] },
      sync_confirmed: { type: "boolean", description: "One-turn explicit confirmation marker used only when the effective standing policy is ASK. It does not override OFF or payload transform requirements." },
      turn_type: { type: "string" },
      content_ref: { type: ["string", "null"] },
      content_preview: { type: ["string", "null"], maxLength: 512 },
      response_ids: { type: "array", items: { type: "string" }, maxItems: 100 },
      context_pack_id: { type: ["string", "null"] },
      tool_receipt_refs: { type: "array", items: { type: "string" }, maxItems: 200 },
      attachment_refs: { type: "array", items: { type: "string" }, maxItems: 100 },
      access_grant_ids: { type: "array", items: { type: "string" }, maxItems: 100 },
      object_refs: { type: "array", items: { type: "string" }, maxItems: 100 },
      task_run_ids: { type: "array", items: { type: "string" }, maxItems: 100 },
      routing_envelope: { type: ["object", "null"] },
      intent_mode: { type: ["string", "null"], enum: ["read", "compare", "propose-action", null] }
    },
    additionalProperties: false
  }
});
