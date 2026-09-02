// V7.6.2b -- bounded, operational MCP /mcp/core session state.
//
// This module stores only the ephemeral set of tool schemas a client has
// explicitly asked the experimental native-hydration transport to expose.
// It is NOT CairnStone accepted-state authority, never moves chain/path heads,
// and never grants tool execution or mutation authority.

export const MCP_CORE_SESSION_SCHEMA = "cairnstone-mcp-core-session-v1";
export const MCP_CORE_SESSION_PROFILE = "deferred_tool_vault_core_native_v762b";
export const MCP_CORE_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const MAX_NATIVE_HYDRATED_TOOLS = 24;

function unixSeconds(nowMs) {
  const value = Number(nowMs);
  return Math.floor((Number.isFinite(value) ? value : Date.now()) / 1000);
}

function validSessionId(sessionId) {
  return typeof sessionId === "string" && sessionId.length >= 8 && sessionId.length <= 200 && /^[A-Za-z0-9._~-]+$/.test(sessionId);
}

function normalizeRequestedToolIds(toolIds) {
  if (!Array.isArray(toolIds)) return { ok: false, error: "native_hydration_tool_ids_not_array" };
  if (toolIds.length > MAX_NATIVE_HYDRATED_TOOLS) {
    return { ok: false, error: "native_hydration_tool_limit_exceeded", max_tools: MAX_NATIVE_HYDRATED_TOOLS, requested: toolIds.length };
  }
  const normalized = [];
  for (const value of toolIds) {
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, error: "native_hydration_tool_id_invalid" };
    }
    normalized.push(value.trim());
  }
  return { ok: true, tool_ids: [...new Set(normalized)].sort((a, b) => a.localeCompare(b)) };
}

// Validate the entire requested native tool set before persisting anything.
// Native direct exposure is deliberately narrower than Tool Vault discovery:
// only tools whose *existing* broker classification is read+automatic and
// whose exact definition exists in the live mcpTools() catalog are eligible.
// This makes V7.6.2b an interop experiment, not a new authority path.
export function validateNativeHydrationSelection(toolIds, definitions, coreNames, brokerTools) {
  const normalized = normalizeRequestedToolIds(toolIds);
  if (!normalized.ok) return normalized;

  const definitionNames = new Set(
    (Array.isArray(definitions) ? definitions : [])
      .map(tool => tool && typeof tool.name === "string" ? tool.name : null)
      .filter(Boolean)
  );
  const core = coreNames instanceof Set ? coreNames : new Set(Array.isArray(coreNames) ? coreNames : []);
  const broker = new Map(
    (Array.isArray(brokerTools) ? brokerTools : [])
      .filter(entry => entry && typeof entry.tool_id === "string")
      .map(entry => [entry.tool_id, entry])
  );

  const hydrated = [];
  const alreadyCore = [];
  const unknown = [];
  const ineligible = [];

  for (const toolId of normalized.tool_ids) {
    if (core.has(toolId)) {
      alreadyCore.push(toolId);
      continue;
    }
    if (!definitionNames.has(toolId)) {
      unknown.push(toolId);
      continue;
    }
    const policy = broker.get(toolId) || null;
    if (!policy || policy.available !== true || policy.risk_class !== "read" || policy.authorization !== "automatic") {
      ineligible.push({
        tool_id: toolId,
        risk_class: policy?.risk_class || null,
        authorization: policy?.authorization || null,
        available: policy?.available === true,
        reason: policy ? "native_direct_requires_read_automatic" : "broker_classification_missing"
      });
      continue;
    }
    hydrated.push(toolId);
  }

  if (unknown.length || ineligible.length) {
    return {
      ok: false,
      error: "native_hydration_selection_rejected",
      unknown_tool_ids: unknown,
      policy_ineligible: ineligible,
      persisted: false,
      policy: {
        native_direct_risk_class: "read",
        native_direct_authorization: "automatic",
        execution_authority: false,
        mutation_authority: false
      }
    };
  }

  return {
    ok: true,
    hydrated_tool_ids: hydrated,
    already_core_tool_ids: alreadyCore,
    requested_tool_ids: normalized.tool_ids,
    policy: {
      native_direct_risk_class: "read",
      native_direct_authorization: "automatic",
      execution_authority: false,
      mutation_authority: false
    }
  };
}

function sessionStoreUnavailable() {
  return { ok: false, error: "mcp_session_store_unavailable" };
}

function parseHydratedIds(value) {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "[]");
    return Array.isArray(parsed) && parsed.every(item => typeof item === "string")
      ? [...new Set(parsed)].sort((a, b) => a.localeCompare(b))
      : [];
  } catch {
    return [];
  }
}

export async function createMcpCoreSession(db, sessionId, nowMs = Date.now()) {
  if (!db || typeof db.prepare !== "function") return sessionStoreUnavailable();
  if (!validSessionId(sessionId)) return { ok: false, error: "mcp_session_id_invalid" };
  const now = unixSeconds(nowMs);
  const expiresAt = now + MCP_CORE_SESSION_TTL_SECONDS;
  await db.prepare(
    "INSERT INTO mcp_core_sessions (session_id,profile,hydrated_tool_ids_json,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET profile=excluded.profile,hydrated_tool_ids_json='[]',updated_at=excluded.updated_at,expires_at=excluded.expires_at"
  ).bind(sessionId, MCP_CORE_SESSION_PROFILE, "[]", now, now, expiresAt).run();
  return {
    ok: true,
    schema: MCP_CORE_SESSION_SCHEMA,
    session_id: sessionId,
    profile: MCP_CORE_SESSION_PROFILE,
    hydrated_tool_ids: [],
    created_at: now,
    updated_at: now,
    expires_at: expiresAt,
    accepted_state_authority: false
  };
}

export async function getMcpCoreSession(db, sessionId, nowMs = Date.now()) {
  if (!db || typeof db.prepare !== "function") return sessionStoreUnavailable();
  if (!validSessionId(sessionId)) return { ok: false, error: "mcp_session_id_invalid" };
  const row = await db.prepare(
    "SELECT session_id,profile,hydrated_tool_ids_json,created_at,updated_at,expires_at FROM mcp_core_sessions WHERE session_id = ?"
  ).bind(sessionId).first();
  if (!row) return { ok: false, error: "mcp_session_not_found", session_id: sessionId };

  const now = unixSeconds(nowMs);
  if (Number(row.expires_at) <= now) {
    await db.prepare("DELETE FROM mcp_core_sessions WHERE session_id = ?").bind(sessionId).run();
    return { ok: false, error: "mcp_session_expired", session_id: sessionId };
  }

  return {
    ok: true,
    schema: MCP_CORE_SESSION_SCHEMA,
    session_id: row.session_id,
    profile: row.profile,
    hydrated_tool_ids: parseHydratedIds(row.hydrated_tool_ids_json),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    expires_at: Number(row.expires_at),
    accepted_state_authority: false
  };
}

export async function setMcpCoreSessionTools(db, sessionId, toolIds, nowMs = Date.now()) {
  if (!db || typeof db.prepare !== "function") return sessionStoreUnavailable();
  const current = await getMcpCoreSession(db, sessionId, nowMs);
  if (!current.ok) return current;
  const normalized = normalizeRequestedToolIds(toolIds);
  if (!normalized.ok) return normalized;

  const now = unixSeconds(nowMs);
  const expiresAt = now + MCP_CORE_SESSION_TTL_SECONDS;
  await db.prepare(
    "UPDATE mcp_core_sessions SET hydrated_tool_ids_json = ?, updated_at = ?, expires_at = ? WHERE session_id = ?"
  ).bind(JSON.stringify(normalized.tool_ids), now, expiresAt, sessionId).run();

  return {
    ok: true,
    schema: MCP_CORE_SESSION_SCHEMA,
    session_id: sessionId,
    profile: current.profile,
    hydrated_tool_ids: normalized.tool_ids,
    created_at: current.created_at,
    updated_at: now,
    expires_at: expiresAt,
    accepted_state_authority: false
  };
}

// V7.6.2b: MCP tool definition for the experimental native-hydration
// control primitive. Always present in the /mcp/core boot surface. Native
// direct exposure is intentionally narrower than Tool Vault discovery --
// only tools whose broker classification is read+automatic are eligible --
// so this can never become a second, looser authority/execution path.
export const LOAD_TOOLS_TOOL_DEFINITION = {
  name: "cairnstone_load_tools",
  description: "V7.6.2b experimental: request that this MCP session natively hydrate a bounded set of additional read+automatic CairnStone tools directly into tools/list, instead of reaching them generically via cairnstone_tool_search -> cairnstone_get_tool_contract -> cairnstone_tool_execute. Only tools whose existing broker classification is risk_class:'read' and authorization:'automatic', and whose exact definition exists in the live tool catalog, are eligible; unknown or ineligible tool_ids reject the entire request without persisting anything. On success, session-scoped hydration state is stored (never CairnStone accepted-state authority, never moves chain/path heads) and, when the client accepts text/event-stream, a notifications/tools/list_changed message is emitted in the same response stream before this tool's result so the client can re-fetch tools/list. Clients that cannot receive that notification get portable_fallback_required:true in the result and remain fully capable through the portable tool_search -> get_tool_contract -> tool_execute path; the full /mcp surface and unhydrated /mcp/core behavior are both unaffected by this call.",
  inputSchema: {
    type: "object",
    required: ["tool_ids"],
    properties: {
      tool_ids: {
        type: "array",
        items: { type: "string" },
        description: "Exact tool names from the live catalog to natively hydrate for this session (bounded, deduped, sorted). Tools already in the core boot set are accepted as no-ops; mutation/execution/prohibited or unclassified tools are rejected."
      }
    },
    additionalProperties: false
  }
};

export async function deleteMcpCoreSession(db, sessionId) {
  if (!db || typeof db.prepare !== "function") return sessionStoreUnavailable();
  if (!validSessionId(sessionId)) return { ok: false, error: "mcp_session_id_invalid" };
  await db.prepare("DELETE FROM mcp_core_sessions WHERE session_id = ?").bind(sessionId).run();
  return { ok: true, session_id: sessionId, deleted: true, accepted_state_authority: false };
}
